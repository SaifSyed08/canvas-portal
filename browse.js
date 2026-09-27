/* Opening a Canvas page the way Saif would, in a window he never sees.

   The API covers most tabs but not all: external tools (Gradescope, Panopto,
   the course's video library), a home page built as a recent-activity feed,
   whatever an instructor embedded. Those are loaded here with the signed-in
   session and read off the screen, every frame included, because an external
   tool draws inside an iframe from its own site.

   A lapsed session shows up as a trip through Canvas's /login, which is
   thrown as NeedsLogin so the usual quiet re-login and retry applies. */

const { BrowserWindow } = require('electron');

/* Run inside each frame. On Canvas itself only #content is read, so the
   global menu and the course menu don't drown out the page. */
const READ_FRAME = canvasOrigin => `(() => {
  if (!document.body) return null;
  const root = (location.origin === ${JSON.stringify(canvasOrigin)} && document.querySelector('#content')) || document.body;
  const links = [];
  for (const a of root.querySelectorAll('a[href]')) {
    if (links.length >= 300) break;
    const t = (a.innerText || a.getAttribute('aria-label') || a.title || '').trim().replace(/\\s+/g, ' ');
    if (t && /^https?:/.test(a.href)) links.push([t.slice(0, 120), a.href]);
  }
  return { url: location.href, title: document.title, text: root.innerText || '', links };
})()`;

/* How much a frame shows, measured the same way, and -1 while it is still
   loading. An external tool signs in through a chain of redirects inside its
   iframe, blank between hops, so blank-and-quiet is not the same as done. */
const SIZE = canvasOrigin => `(() => {
  if (!document.body || document.readyState !== 'complete') return -1;
  const root = (location.origin === ${JSON.stringify(canvasOrigin)} && document.querySelector('#content')) || document.body;
  return (root.innerText || '').trim().length;
})()`;

const within = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

function createBrowser({ partition, getSession, getBase, canvas, NeedsLogin }) {
  let queue = Promise.resolve();
  const ours = new Set();
  let wired = false;

  /* A page that starts a download (a file link) should not drop files into
     Downloads behind Saif's back; get_file is the way to fetch those. */
  function wire() {
    if (wired) return;
    wired = true;
    getSession().on('will-download', (e, _item, wc) => { if (wc && ours.has(wc.id)) e.preventDefault(); });
  }

  async function eachFrame(wc, code, ms) {
    const out = [];
    for (const f of wc.mainFrame.framesInSubtree) {
      try { out.push({ frame: f, value: await within(f.executeJavaScript(code), ms) }); } catch (e) {}
    }
    return out;
  }

  /* Loads url hidden and waits until the page has settled (its text stops
     changing for a moment) or until(wc) returns something. One page at a
     time, so a burst of tool calls can't open a pile of windows. */
  function visit(url, { until, timeout = 25000, settle = 1800 } = {}) {
    const job = () => new Promise((resolve, reject) => {
      wire();
      const base = getBase();
      const w = new BrowserWindow({
        show: false, width: 1280, height: 900,
        webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
      });
      const wc = w.webContents;
      const wcId = wc.id;
      ours.add(wcId);
      wc.setAudioMuted(true);
      /* Tools that insist on a new window get it in this same hidden one. */
      wc.setWindowOpenHandler(({ url: next }) => {
        if (/^https:\/\//i.test(next)) wc.loadURL(next).catch(() => {});
        return { action: 'deny' };
      });

      let over = false, busy = false, lastSize = -1, stableSince = Date.now();
      const collect = async () => ({
        url: wc.getURL(),
        frames: (await eachFrame(wc, READ_FRAME(base), 3000)).map(x => x.value).filter(Boolean)
      });
      const end = (err, val) => {
        if (over) return;
        over = true;
        clearInterval(tick);
        clearTimeout(cap);
        ours.delete(wcId);
        if (!w.isDestroyed()) w.destroy();
        if (err) reject(err); else resolve(val);
      };

      wc.on('did-navigate', (_e, u) => { if (base && u.startsWith(base + '/login')) end(new NeedsLogin()); });

      const tick = setInterval(async () => {
        if (over || busy || w.isDestroyed()) return;
        busy = true;
        try {
          if (until) {
            const v = await until(wc);
            if (v) return end(null, { ...(await collect()), value: v });
          }
          if (wc.isLoading()) { stableSince = Date.now(); return; }
          const sizes = (await eachFrame(wc, SIZE(base), 1500))
            .filter(x => x.frame.url && x.frame.url !== 'about:blank').map(x => x.value);
          const n = sizes.some(v => v == null || v < 0) ? -1 : sizes.reduce((s, v) => s + v, 0);
          if (n < 0 || n !== lastSize) { lastSize = n; stableSince = Date.now(); return; }
          if (!until && n > 40 && Date.now() - stableSince >= settle) end(null, await collect());
        } catch (e) {
        } finally { busy = false; }
      }, 600);

      /* Out of time: hand back whatever is on screen rather than nothing. */
      const cap = setTimeout(async () => {
        if (over) return;
        try { end(null, { ...(await collect()), value: null, timedOut: true }); } catch (e) { end(e); }
      }, timeout);

      /* loadURL rejects on the aborted navigations that redirects and
         auto-posting launch forms cause; the tick above decides when it is done. */
      wc.loadURL(url).catch(() => {});
    });
    const p = queue.then(job, job);
    queue = p.catch(() => {});
    return p;
  }

  /* An external tool opens inside its Canvas page, in an iframe, exactly as
     it does for Saif. (Canvas's sessionless launch would open it bare, but UT
     answers students "not authorized" there.) */
  function launchUrl(courseId, toolId) {
    return `${getBase()}/courses/${courseId}/external_tools/${encodeURIComponent(toolId)}`;
  }

  /* What a visit looks like to Claude: the text, frame by frame, plus the
     links and any Canvas file ids, so it can keep going from there. */
  function summarize(page, maxText = 24000) {
    const base = getBase();
    const seen = new Set();
    const parts = [];
    page.frames.forEach((f, i) => {
      const t = String(f.text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (t.length < 2 || seen.has(t)) return;
      seen.add(t);
      let host = '';
      try { host = new URL(f.url).host; } catch (e) {}
      parts.push(i === 0 ? t : `--- inside the page: ${f.title || host} ---\n${t}`);
    });
    let text = parts.join('\n\n');
    if (text.length > maxText) text = text.slice(0, maxText) + '\n…(cut off)';

    const links = new Map();
    const fileIds = new Set();
    for (const f of page.frames) for (const [label, href] of f.links || []) {
      const m = href.match(/\/files\/(\d+)/);
      if (m && base && href.startsWith(base)) fileIds.add(m[1]);
      if (!links.has(href) && !/^javascript:/i.test(href) && !href.includes('#skip')) links.set(href, label);
    }
    return {
      url: page.url,
      text: text || '(the page showed no text)',
      frames: text ? undefined : page.frames.map(f => f.url),
      linked_file_ids: [...fileIds],
      links: [...links].slice(0, 80).map(([href, label]) => ({ label, href })),
      note: page.timedOut ? 'The page was still loading after 25 seconds; this is what had appeared by then.' : undefined
    };
  }

  async function openTab({ course_id, tab }) {
    const tabs = await canvas.getAll(`/api/v1/courses/${course_id}/tabs?per_page=100`);
    const want = String(tab || '').trim().toLowerCase();
    const t = tabs.find(x => x.id.toLowerCase() === want) || tabs.find(x => x.label.toLowerCase() === want)
      || tabs.find(x => x.label.toLowerCase().includes(want));
    if (!t) throw new Error(`This course has no "${tab}" tab. It has: ${tabs.map(x => x.label).join(', ')}.`);
    const url = t.type === 'external'
      ? await launchUrl(course_id, t.id.replace(/^context_external_tool_/, ''))
      : getBase() + t.html_url;
    return { tab: t.label, ...summarize(await visit(url)) };
  }

  /* Only Saif's own Canvas: a link found on some page should not be able to
     steer a signed-in window anywhere else. External tools go through their
     tab, which Canvas launches itself. */
  async function openPage({ url }) {
    const base = getBase();
    const s = String(url || '').trim();
    const full = s.startsWith('/') ? base + s : s;
    let ok = false;
    try { ok = new URL(full).origin === base; } catch (e) {}
    if (!ok) throw new Error(`Only pages on ${base} can be opened this way. For an external tool, use open_tab with its tab.`);
    return summarize(await visit(full));
  }

  const obj = (props, required = []) => ({ type: 'object', properties: props, required });
  const id = { type: ['integer', 'string'] };
  const tools = [
    {
      name: 'open_tab',
      description: "Open any tab of a course the way Saif would see it and read the page: external tools like Gradescope, Panopto or Piazza, a course home page, anything list_tabs marks as open_tab. Slower than the dedicated tools (it loads the real page), so prefer those when list_tabs names one. Opening a page can count as viewing it, as it would for Saif.",
      inputSchema: obj({
        course_id: id,
        tab: { type: 'string', description: 'The tab id or label from list_tabs, e.g. "grades" or "Gradescope"' }
      }, ['course_id', 'tab']),
      run: openTab
    },
    {
      name: 'open_canvas_page',
      description: "Open any page on Saif's Canvas by its address (a link from another tool's results, a module item's open_url, a page an instructor linked) and read what it shows, frames included.",
      inputSchema: obj({ url: { type: 'string', description: 'Full Canvas address, or a path like /courses/123/grades' } }, ['url']),
      run: openPage
    }
  ];

  return { visit, launchUrl, summarize, tools };
}

module.exports = { createBrowser };
