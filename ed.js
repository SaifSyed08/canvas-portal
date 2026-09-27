/* Ed Discussion, reached through a course's Ed tab in Canvas.

   Ed is its own site with its own login, but Canvas launches it already
   signed in. So the first time a course's Ed is asked for, the portal opens
   that tab in a hidden window, and the Ed web app, starting up, makes its own
   API calls carrying its token (an X-Token header). That token is all Ed's
   API needs, so from then on the portal asks the API directly. The token is
   kept in memory only; after a restart one more hidden launch fetches it. */

const ED_TAB = /\bed\b|edstem/i;
const MAX_TEXT = 24000;

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

/* Ed stamps times in its own (Australian) zone, +10:00; everything the
   portal hands Claude is UTC, like Canvas's. */
const utc = t => { const d = new Date(t); return isNaN(d) ? t || null : d.toISOString().replace(/\.\d+Z$/, 'Z'); };

/* edstem.org/us/courses/… is served by the API at us.edstem.org. */
function apiFor(pageUrl) {
  const m = String(pageUrl).match(/edstem\.org\/([a-z]{2})\//);
  return m ? `https://${m[1]}.edstem.org` : 'https://edstem.org';
}

function createEd({ canvas, browser, getSession }) {
  let auth = null;                 // { token, api }
  let hooked = false;
  let apiCourseSeen = null;        // the last Ed course id the web app asked its API about
  const edCourseOf = new Map();    // Canvas course id → Ed course id
  const regionOf = new Map();      // Ed course id → "us" / "au", for links back to Ed
  let lastCanvasCourse = null;

  function hook() {
    if (hooked) return;
    hooked = true;
    getSession().webRequest.onBeforeSendHeaders({ urls: ['*://edstem.org/*', '*://*.edstem.org/*'] }, (d, cb) => {
      try {
        const u = new URL(d.url);
        if (u.pathname.startsWith('/api/')) {
          for (const [k, v] of Object.entries(d.requestHeaders || {}))
            if (/^x-token$/i.test(k) && v) auth = { token: v, api: u.origin };
          const m = u.pathname.match(/^\/api\/courses\/(\d+)\b/);
          if (m) apiCourseSeen = m[1];
        }
      } catch (e) {}
      cb({ requestHeaders: d.requestHeaders });
    });
  }

  async function edTabOf(courseId) {
    const tabs = await canvas.getAll(`/api/v1/courses/${courseId}/tabs?per_page=100`);
    return tabs.find(t => t.type === 'external' && ED_TAB.test(t.label)) || null;
  }

  /* Any course of Saif's that has an Ed tab, for when only a thread id is known. */
  async function anyEdCourse() {
    if (lastCanvasCourse) return lastCanvasCourse;
    const list = await canvas.getAll('/api/v1/courses?enrollment_state=active&per_page=100');
    for (const c of list) {
      try { if (await edTabOf(c.id)) return c.id; } catch (e) {}
    }
    throw new Error('None of Saif\'s Canvas courses has an Ed Discussion tab.');
  }

  async function connect(courseId) {
    hook();
    const tab = await edTabOf(courseId);
    if (!tab) throw new Error('This course has no Ed Discussion tab in Canvas. Check list_tabs; its discussions may be the Canvas kind (list_discussions).');
    apiCourseSeen = null;
    const url = await browser.launchUrl(courseId, tab.id.replace(/^context_external_tool_/, ''));
    const page = await browser.visit(url, {
      timeout: 40000,
      until: async wc => {
        let fromUrl = null;
        for (const f of wc.mainFrame.framesInSubtree) {
          const m = String(f.url).match(/edstem\.org\/([a-z]{2})\/courses\/(\d+)/);
          if (m) { fromUrl = m[2]; regionOf.set(m[2], m[1]); }
          /* Fallback if the header never shows: the web app keeps its token here. */
          if (!auth && /edstem\.org/.test(f.url)) {
            try {
              const t = await f.executeJavaScript("localStorage.getItem('authToken')");
              if (t) auth = { token: t, api: apiFor(f.url) };
            } catch (e) {}
          }
        }
        const course = fromUrl || apiCourseSeen;
        return auth && course ? course : null;
      }
    });
    if (!auth) throw new Error("Ed didn't finish opening from Canvas. Saif may need to open the Ed tab once in a browser (to link his account or accept Ed's terms), then ask again.");
    const ed = page.value || apiCourseSeen;
    if (!ed) throw new Error('Ed opened, but it did not say which Ed course this Canvas course is.');
    edCourseOf.set(String(courseId), String(ed));
    lastCanvasCourse = courseId;
    return String(ed);
  }

  async function edCourse(courseId) {
    const k = String(courseId);
    if (!auth || !edCourseOf.has(k)) await connect(courseId);
    lastCanvasCourse = courseId;
    return edCourseOf.get(k);
  }

  /* A rejected token (Ed signs people out now and then) gets one fresh launch. */
  async function api(p, courseId) {
    for (let attempt = 0; ; attempt++) {
      if (!auth) await connect(courseId || await anyEdCourse());
      const res = await fetch(auth.api + '/api' + p, {
        headers: { 'X-Token': auth.token, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000)
      });
      if (res.status === 401 && attempt === 0) { auth = null; continue; }
      if (!res.ok) {
        let msg = '';
        try { const j = await res.json(); msg = j.message || j.code || ''; } catch (e) {}
        if (res.status === 403) throw new Error('Ed says Saif can\'t see that' + (msg ? ': ' + msg : '.'));
        throw new Error('Ed said ' + res.status + (msg ? ': ' + msg : ''));
      }
      return res.json();
    }
  }

  const people = users => new Map((users || []).map(u => [u.id, u]));
  const nameOf = (map, x) => {
    if (x.is_anonymous || !x.user_id) return 'Anonymous';
    const u = map.get(x.user_id);
    if (!u) return 'Someone';
    const role = u.course_role && u.course_role !== 'student' ? ` (${u.course_role === 'admin' ? 'instructor' : u.course_role})` : '';
    return u.name + role;
  };
  const linkTo = (edCourseId, threadId) =>
    `https://edstem.org/${regionOf.get(String(edCourseId)) || 'us'}/courses/${edCourseId}/discussion/${threadId}`;

  async function threads({ course_id, search, category, unanswered, limit = 30 }) {
    const ec = await edCourse(course_id);
    limit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
    const users = new Map();
    const take = j => { for (const [k, v] of people(j.users)) users.set(k, v); return j.threads || []; };

    /* Ed's list is newest first and has no server-side filter worth relying
       on, so filtering reads back through the most recent 500. */
    const filtering = !!(search || category || unanswered);
    let list = [];
    for (let off = 0; off < (filtering ? 500 : limit); off += 100) {
      const n = filtering ? 100 : Math.min(100, limit - off);
      const page = take(await api(`/courses/${ec}/threads?limit=${n}&offset=${off}&sort=new`, course_id));
      list.push(...page);
      if (page.length < n) break;
    }
    if (search) {
      const words = String(search).toLowerCase().split(/\s+/).filter(Boolean);
      list = list.filter(t => {
        const hay = `${t.title} ${t.document || ''} ${t.category || ''} ${t.subcategory || ''}`.toLowerCase();
        return words.every(w => hay.includes(w));
      });
    }
    if (category) {
      const c = String(category).toLowerCase();
      list = list.filter(t => [t.category, t.subcategory, t.subsubcategory].some(x => x && x.toLowerCase().includes(c)));
    }
    if (unanswered) list = list.filter(t => t.type === 'question' && !t.is_answered);

    return list.slice(0, limit).map(t => ({
      thread_id: t.id, number: t.number, title: t.title, type: t.type,
      category: [t.category, t.subcategory].filter(Boolean).join(' › ') || undefined,
      author: nameOf(users, t),
      created_at: utc(t.created_at),
      replies: t.reply_count,
      answered: t.type === 'question' ? !!t.is_answered : undefined,
      staff_answered: t.is_staff_answered || undefined,
      endorsed: t.is_endorsed || undefined,
      pinned: t.is_pinned || undefined,
      unread: t.is_seen === false || undefined,
      preview: clip(String(t.document || '').replace(/\s+/g, ' ').trim(), 280),
      url: linkTo(ec, t.id)
    }));
  }

  async function thread({ thread_id, course_id }) {
    const idMatch = String(thread_id).match(/discussion\/(\d+)/);
    const id = idMatch ? idMatch[1] : String(thread_id).replace(/\D/g, '');
    if (!id) throw new Error('Give the thread_id from ed_threads (or an Ed thread link).');
    const j = await api(`/threads/${id}`, course_id);
    const t = j.thread || j;
    const users = people(j.users);
    const lines = [];
    let budget = MAX_TEXT;
    const say = s => { if (budget > 0) { lines.push(s); budget -= s.length; } };
    const body = (s, pad) => String(s || '').trim().replace(/\n{3,}/g, '\n\n').replace(/\n/g, '\n' + pad);
    const flags = x => [x.is_endorsed && 'endorsed', x.is_resolved && 'resolved', x.vote_count > 0 && `${x.vote_count} votes`]
      .filter(Boolean).join(', ');
    const walk = (list, depth) => {
      for (const c of list || []) {
        const pad = '  '.repeat(depth + 1);
        const f = flags(c);
        say(`${'  '.repeat(depth)}- ${nameOf(users, c)} (${utc(c.created_at)}${f ? ', ' + f : ''}):\n${pad}${body(c.document, pad)}`);
        walk(c.comments, depth + 1);
      }
    };

    say(`#${t.number} ${t.title}`);
    say(`${t.type}${t.category ? ' in ' + [t.category, t.subcategory].filter(Boolean).join(' › ') : ''} · by ${nameOf(users, t)} · ${utc(t.created_at)}` +
      (t.type === 'question' ? (t.is_answered ? ' · answered' : ' · not answered yet') : '') +
      (t.vote_count ? ` · ${t.vote_count} votes` : ''));
    say('');
    say(body(t.document, ''));
    if ((t.answers || []).length) { say('\nANSWERS'); walk(t.answers, 0); }
    if ((t.comments || []).length) { say('\nCOMMENTS'); walk(t.comments, 0); }
    if (budget <= 0) lines.push('…(the rest is cut off)');
    lines.push('\n' + linkTo(t.course_id, t.id));
    return lines.join('\n');
  }

  const obj = (props, required = []) => ({ type: 'object', properties: props, required });
  const cid = { type: ['integer', 'string'] };
  const tools = [
    {
      name: 'ed_threads',
      description: "Posts on a course's Ed Discussion board (the Ed tab in Canvas), newest first: title, category, author (instructors and TAs are marked), reply count, whether a question is answered, and a preview. Filter by words, category, or unanswered questions. Read a whole thread with ed_thread. The first Ed call in a session takes a few seconds while the portal opens Ed through Canvas.",
      inputSchema: obj({
        course_id: { ...cid, description: 'The Canvas course id (from list_courses)' },
        search: { type: 'string', description: 'Optional words that must all appear in the title, body or category' },
        category: { type: 'string', description: 'Optional category, e.g. "Homework" or "Exams"' },
        unanswered: { type: 'boolean', description: 'Only questions nobody has answered yet' },
        limit: { type: 'integer', description: 'How many to return (default 30, max 100)' }
      }, ['course_id']),
      run: threads
    },
    {
      name: 'ed_thread',
      description: 'Read one Ed Discussion thread in full: the post, every answer and comment with who wrote it, which answers instructors endorsed, and votes.',
      inputSchema: obj({
        thread_id: { ...cid, description: 'thread_id from ed_threads, or an Ed thread link' },
        course_id: { ...cid, description: 'The Canvas course id, if known' }
      }, ['thread_id']),
      run: thread
    }
  ];

  return { tools };
}

module.exports = { createEd };
