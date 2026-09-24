/* Canvas, read and written through the signed-in browser session.

   No token: the portal signs in once in a real window and then talks to
   /api/v1 with those cookies, the same way the Canvas dashboard does. Two
   quirks come with that. Session-authenticated JSON starts with `while(1);`,
   and a lapsed session is not a 401 but a redirect to the login page, so
   redirects are never followed on API calls and are read as "sign in again".
   An unfollowed redirect from net.fetch is opaque — status 0, no Location —
   and some schools answer the login page directly as 200 HTML; both mean
   the same thing. */

const { net } = require('electron');
const crypto = require('crypto');

class NeedsLogin extends Error {
  constructor() {
    super('Canvas sign-in has expired. Saif needs to click "Sign in" in the sidebar again.');
    this.code = 'login';
  }
}

function createCanvas({ getBase, getSession }) {
  const base = () => {
    const b = getBase();
    if (!b) throw new Error('No Canvas address is set up yet.');
    return b;
  };

  async function csrf() {
    const got = await getSession().cookies.get({ url: base(), name: '_csrf_token' });
    return got.length ? decodeURIComponent(got[0].value) : '';
  }

  /* pairs: [[key, value], ...] so array fields like file_ids[] can repeat */
  const encodeForm = pairs =>
    pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');

  async function request(pathOrUrl, { method = 'GET', form, body, headers = {}, follow = false } = {}) {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : base() + pathOrUrl;
    const h = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...headers };
    let payload = body;
    if (form) {
      payload = encodeForm(form);
      h['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (method !== 'GET' && url.startsWith(base())) h['X-CSRF-Token'] = await csrf();
    const res = await net.fetch(url, {
      method,
      headers: h,
      body: payload,
      session: getSession(),
      redirect: follow ? 'follow' : 'manual',
      signal: AbortSignal.timeout(60000)
    });
    if (res.status === 401) throw new NeedsLogin();
    return res;
  }

  const bounced = res => !res.status || res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);

  async function readJson(res) {
    if (res.ok && !/json/i.test(res.headers.get('content-type') || '')) throw new NeedsLogin();
    const text = (await res.text()).replace(/^while\(1\);/, '');
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { throw new Error('Canvas sent something that was not JSON (status ' + res.status + ')'); }
  }

  async function failure(res) {
    let msg = '';
    try {
      const j = await readJson(res);
      msg = (j && (j.message || (j.errors && (j.errors[0] && j.errors[0].message || JSON.stringify(j.errors))))) || '';
    } catch (e) {}
    return new Error('Canvas said ' + res.status + (msg ? ': ' + msg : ''));
  }

  async function get(path) {
    const res = await request(path);
    if (bounced(res)) throw new NeedsLogin();
    if (!res.ok) throw await failure(res);
    return readJson(res);
  }

  /* Canvas paginates with Link headers; follow rel="next" up to a sane cap. */
  async function getAll(path, cap = 400) {
    let url = path, out = [];
    while (url && out.length < cap) {
      const res = await request(url);
      if (bounced(res)) throw new NeedsLogin();
      if (!res.ok) throw await failure(res);
      const page = await readJson(res);
      out = out.concat(Array.isArray(page) ? page : []);
      const link = res.headers.get('link') || '';
      const next = link.split(',').find(p => /rel="next"/.test(p));
      url = next ? next.match(/<([^>]+)>/)[1] : null;
    }
    return out;
  }

  async function send(path, method, pairs) {
    const res = await request(path, { method, form: pairs });
    if (bounced(res)) throw new NeedsLogin();
    if (!res.ok) throw await failure(res);
    return readJson(res);
  }

  async function download(url, maxBytes) {
    const res = await request(url, { follow: true, headers: { Accept: '*/*' } });
    if (!res.ok) throw new Error('Could not download that file (status ' + res.status + ')');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('That file is larger than ' + Math.round(maxBytes / 1e6) + ' MB');
    return buf;
  }

  /* Handing in a file is three steps: tell Canvas it is coming, send the bytes
     to wherever Canvas says (often a separate storage host), then attach the
     resulting file ids to a submission. */
  async function uploadForSubmission(courseId, assignmentId, file) {
    const pre = await send(
      `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/self/files`, 'POST',
      [['name', file.name], ['size', file.data.length], ['content_type', file.type], ['on_duplicate', 'rename']]
    );
    if (!pre || !pre.upload_url) throw new Error('Canvas did not hand back an upload address');

    const boundary = '----portal' + crypto.randomBytes(12).toString('hex');
    const parts = [];
    for (const [k, v] of Object.entries(pre.upload_params || {}))
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name.replace(/["\r\n]/g, '')}"\r\n` +
      `Content-Type: ${file.type}\r\n\r\n`));
    parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));

    /* Canvas may finish with a redirect to a confirm URL that has to be
       fetched with the session; following it does exactly that (a redirected
       POST turns into a GET). */
    const up = await request(pre.upload_url, {
      method: 'POST',
      body: Buffer.concat(parts),
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      follow: true
    });
    if (!up.ok) throw await failure(up);
    let done = await readJson(up);
    if (done && done.id == null && done.location) {
      const res = await request(done.location, { follow: true });
      if (!res.ok) throw await failure(res);
      done = await readJson(res);
    }
    if (!done || done.id == null) throw new Error('Canvas did not confirm the upload');
    return done.id;
  }

  async function submitFiles(courseId, assignmentId, files, comment) {
    const ids = [];
    for (const f of files) ids.push(await uploadForSubmission(courseId, assignmentId, f));
    const pairs = [['submission[submission_type]', 'online_upload']];
    for (const id of ids) pairs.push(['submission[file_ids][]', id]);
    if (comment) pairs.push(['comment[text_comment]', comment]);
    return send(`/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`, 'POST', pairs);
  }

  return { get, getAll, download, submitFiles, base };
}

module.exports = { createCanvas, NeedsLogin };
