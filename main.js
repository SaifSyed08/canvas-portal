const { app, BrowserWindow, ipcMain, session, dialog, shell, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { createCanvas, NeedsLogin } = require('./canvas');
const { createTools } = require('./tools');
const { startMcp } = require('./mcp');
const { findClaude, runTurn } = require('./claude');

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
const userData = () => app.getPath('userData');
const workDir = () => path.join(userData(), 'workspace');

/* ── config ── */
const cfgPath = () => path.join(userData(), 'config.json');
function readCfg() { try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch (e) { return {}; } }
function writeCfg(patch) {
  const next = { ...readCfg(), ...patch };
  fs.writeFileSync(cfgPath(), JSON.stringify(next, null, 1));
  return next;
}

/* ── saved sign-in ──
   Email and password go through safeStorage, which on Windows is DPAPI: only
   this Windows account on this machine can decrypt them. Without it they are
   not saved at all. */
function saveLogin(user, pass) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  writeCfg({ login: { user, pass: safeStorage.encryptString(pass).toString('base64') } });
  return true;
}
function savedLogin() {
  const l = readCfg().login;
  if (!l || !l.user || !l.pass) return null;
  try { return { user: l.user, pass: safeStorage.decryptString(Buffer.from(l.pass, 'base64')) }; }
  catch (e) { return null; }
}

/* ── Canvas session ── */
const PARTITION = 'persist:canvas';
let uaSet = false;
function canvasSession() {
  const s = session.fromPartition(PARTITION);
  /* Single sign-on pages turn away anything that says it is an embedded
     browser. It is Chromium either way; only the app's name comes out. */
  if (!uaSet) {
    s.setUserAgent(app.userAgentFallback
      .replace(new RegExp('\\s?' + app.getName().replace(/\s/g, '\\s?') + '\\/[\\d.]+', 'gi'), '')
      .replace(/\s?Electron\/[\d.]+/gi, ''));
    uaSet = true;
  }
  return s;
}

const canvas = createCanvas({ getBase: () => readCfg().base, getSession: canvasSession });

function sendUI(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* Fills whatever sign-in step is on screen: a username box, a password box,
   or Microsoft's "Stay signed in?". Works through React-style inputs by
   going through the native value setter. Returns which step it acted on. */
const FILL_SCRIPT = `(function (u, p, allowPassword) {
  const vis = el => el && el.offsetParent !== null && !el.disabled && !el.readOnly;
  const set = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const clickable = () => [...document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button]')].filter(vis);
  const label = b => (b.innerText || b.value || '').trim();
  if (/stay signed in/i.test(document.body.innerText)) {
    const yes = clickable().find(b => /^yes$/i.test(label(b)));
    if (yes) { yes.click(); return 'stay'; }
  }
  const pw = [...document.querySelectorAll('input[type=password]')].find(vis);
  const textish = el => vis(el) && !/^(password|hidden|checkbox|radio|submit|button)$/i.test(el.type);
  const user = [...document.querySelectorAll('input[type=email], input[autocomplete=username], input[name*=user i], input[name*=login i], input[name*=email i], input[name*=unique_id i], input[id*=user i], input[id*=email i], input[name=loginfmt]')].find(textish)
    || (pw && pw.form && [...pw.form.querySelectorAll('input')].find(textish));
  if (window.__portalClick) return 'waiting';
  if (!pw && !user) return 'none';
  if (pw && !allowPassword) return 'blocked';
  if (user && user.value !== u) set(user, u);
  if (pw) set(pw, p);
  const form = (pw || user).form;
  const btn = (form && [...form.querySelectorAll('button[type=submit], input[type=submit], button:not([type])')].find(vis))
    || clickable().find(b => /^(sign in|log ?in|next|continue|submit|verify)$/i.test(label(b)));
  window.__portalClick = true;
  setTimeout(() => {
    window.__portalClick = false;
    if (btn) btn.click();
    else if (form) (form.requestSubmit ? form.requestSubmit() : form.submit());
  }, 150);
  return pw ? 'password' : 'user';
})`;

let loginWin = null;
let loginPromise = null;

/* One sign-in window at a time. `quiet` keeps it hidden while saved details
   do the work, and only shows it if something needs Saif — usually a Duo or
   Authenticator prompt — or if it stalls. */
function canvasLogin({ quiet = false } = {}) {
  if (loginPromise) {
    if (!quiet && loginWin && !loginWin.isDestroyed()) { loginWin.show(); loginWin.focus(); }
    return loginPromise;
  }
  const base = readCfg().base;
  if (!base) return Promise.resolve({ ok: false, error: 'Set your Canvas address first' });
  const creds = savedLogin();

  loginPromise = new Promise(resolve => {
    loginWin = new BrowserWindow({
      width: 1000, height: 780,
      title: 'Sign in to Canvas',
      parent: win || undefined,
      show: !(quiet && creds),
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      /* hidden windows throttle timers, and the fill script's click rides one */
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    canvasSession();

    let finished = false;
    let passwordTries = 0;
    const seen = new Map();

    const reveal = why => {
      if (loginWin && !loginWin.isDestroyed() && !loginWin.isVisible()) {
        loginWin.show();
        sendUI('login:status', why);
      }
    };

    const finish = out => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(showTimer);
      clearTimeout(giveUp);
      if (loginWin && !loginWin.isDestroyed()) loginWin.destroy();
      loginWin = null;
      loginPromise = null;
      if (out.ok) writeCfg({ who: out.who });
      sendUI('state:changed', publicState());
      resolve(out);
    };

    /* The way back from single sign-on is not predictable, so the finish line
       is not a URL: it is the moment Canvas answers /users/self. */
    const poll = setInterval(async () => {
      if (!loginWin || loginWin.isDestroyed()) return;
      const wc = loginWin.webContents;
      const here = wc.getURL();
      if (here.startsWith(base) && !/\/login(\/|$|\?)/.test(here)) {
        try {
          const me = await canvas.get('/api/v1/users/self');
          return finish({ ok: true, who: me.short_name || me.name || 'Canvas' });
        } catch (e) { /* not through yet */ }
      }
      if (!creds || wc.isLoading()) return;
      try {
        const step = await wc.executeJavaScript(
          `${FILL_SCRIPT}(${JSON.stringify(creds.user)}, ${JSON.stringify(creds.pass)}, ${passwordTries < 1})`);
        /* Pages take a beat to move on after a click, so the same step showing
           up once more is normal. Three times in a row means it is stuck. */
        if (step === 'password') passwordTries++;
        const key = here.split('#')[0] + '|' + step;
        seen.set(key, (seen.get(key) || 0) + 1);
        if (step !== 'none' && step !== 'password' && step !== 'waiting' && seen.get(key) >= 3)
          reveal(step === 'blocked'
            ? 'The saved password did not go through. Finish signing in yourself.'
            : 'Signing in needs you for a moment.');
      } catch (e) {}
    }, 1200);

    /* Hidden for 15 seconds at most: past that it is waiting on a person. */
    const showTimer = setTimeout(() => reveal('Your school wants you to confirm it is you.'), 15000);
    const giveUp = setTimeout(() => finish({ ok: false, error: 'Sign-in took too long' }), 5 * 60e3);

    loginWin.webContents.setWindowOpenHandler(() => ({ action: 'allow' }));
    loginWin.on('closed', () => { loginWin = null; finish({ ok: false, error: 'Sign-in window was closed' }); });
    loginWin.loadURL(base + '/login').catch(() => finish({ ok: false, error: 'Could not reach Canvas' }));
  });
  return loginPromise;
}

/* Any Canvas call that finds the session expired gets one quiet retry after a
   fresh sign-in, so a lapse mid-chat costs nothing when details are saved. */
async function withLogin(fn) {
  try { return await fn(); }
  catch (e) {
    if (!(e instanceof NeedsLogin)) throw e;
    writeCfg({ who: null });
    sendUI('state:changed', publicState());
    const r = await canvasLogin({ quiet: true });
    if (!r.ok) throw e;
    return fn();
  }
}

/* ── tools + MCP ── */
const tools = createTools({
  canvas,
  workDir: workDir(),
  onProposal: card => sendUI('chat:event', { type: 'proposal', card })
});
for (const t of tools.tools) { const run = t.run; t.run = args => withLogin(() => run(args)); }

let mcpConfigPath = null;
let systemPromptPath = null;
const claudeExe = findClaude();

function systemPrompt() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `You are running inside Canvas Portal, Saif's desktop app that connects you to his Canvas LMS account through the "canvas" tools. You are his study assistant: help him understand assignments, plan his time, find what's due, and go over his work.

- Look things up with the canvas tools instead of guessing. Canvas ids are numbers; get them from tool results, never invent them. When he mentions an assignment by name, find it (upcoming, or list_courses then list_assignments) before answering.
- Canvas times are UTC. Saif is in ${tz}. Give times in his local time with the weekday, and how far away they are ("Thu 11:59 PM, in 2 days").
- Instructions often sit in linked files or module pages. When get_assignment lists linked_file_ids, open the relevant ones with get_file and then Read.
- Files Saif attaches are saved in ./uploads (see list_attached_files). Files you download from Canvas go to ./downloads. Read either with the Read tool.
- Handing in: only when Saif asks you to submit or turn something in, call propose_submission. It does NOT submit. It shows him a confirmation card, and nothing reaches Canvas until he clicks Submit. Match the assignment by course, name, and due date. If more than one could fit, ask which one instead of picking. If the file type isn't accepted, say so rather than proposing.
- Messages starting with "(Portal note:" come from the app, not from Saif. They report what happened to a confirmation card.
- The chat renders Markdown. Keep answers easy to skim.`;
}

async function bootMcp() {
  const srv = await startMcp(tools.tools);
  fs.mkdirSync(workDir(), { recursive: true });
  mcpConfigPath = path.join(userData(), 'mcp.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { canvas: { type: 'http', url: srv.url } } }));
  systemPromptPath = path.join(userData(), 'system-prompt.md');
  fs.writeFileSync(systemPromptPath, systemPrompt());
}

/* ── chat ── */
let turn = null;
let notes = [];

function publicState() {
  const c = readCfg();
  return {
    base: c.base || '',
    who: c.who || null,
    savedUser: (c.login && c.login.user) || null,
    canSaveLogin: safeStorage.isEncryptionAvailable(),
    claude: !!claudeExe,
    busy: !!turn,
    sessionId: c.sessionId || null
  };
}

ipcMain.handle('state:get', () => publicState());

ipcMain.handle('canvas:setBase', (_e, raw) => {
  if (!String(raw || '').trim()) { writeCfg({ base: null, who: null }); return { ok: true, base: null }; }
  let base;
  try {
    const s = String(raw || '').trim();
    base = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s).origin;
  } catch (e) { return { ok: false, error: 'That does not look like a web address' }; }
  if (!base.startsWith('https://')) return { ok: false, error: 'Canvas addresses start with https://' };
  writeCfg({ base, who: null });
  return { ok: true, base };
});

ipcMain.handle('canvas:login', () => canvasLogin({ quiet: !!savedLogin() }));

ipcMain.handle('login:save', (_e, { user, pass }) => {
  if (!user || !pass) return { ok: false, error: 'Fill in both' };
  return saveLogin(String(user).trim(), String(pass)) ? { ok: true } : { ok: false, error: 'This computer has no secure place to keep it' };
});
ipcMain.handle('login:forget', () => { writeCfg({ login: null }); return { ok: true }; });

ipcMain.handle('canvas:signout', async () => {
  await session.fromPartition(PARTITION).clearStorageData();
  writeCfg({ who: null });
  return publicState();
});

ipcMain.handle('canvas:upcoming', async () => {
  try { return { ok: true, items: await withLogin(() => tools.upcoming({ days: 14, past_days: 2 })) }; }
  catch (e) { return { ok: false, error: e.message, login: e instanceof NeedsLogin }; }
});

function addFiles(paths) {
  const out = [];
  for (const p of paths || []) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      const ext = path.extname(p), stem = path.basename(p, ext).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      let name = stem + ext, n = 2;
      while (fs.existsSync(path.join(tools.uploadsDir, name))) {
        if (fs.statSync(path.join(tools.uploadsDir, name)).size === st.size) break;  // same file again
        name = `${stem} (${n++})${ext}`;
      }
      fs.copyFileSync(p, path.join(tools.uploadsDir, name));
      out.push({ name, size: st.size });
    } catch (e) {}
  }
  return out;
}
ipcMain.handle('files:add', (_e, paths) => addFiles(paths));
ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : addFiles(r.filePaths);
});

ipcMain.handle('chat:send', async (_e, { text, files }) => {
  if (turn) return { ok: false, error: 'Still answering' };
  if (!claudeExe) return { ok: false, error: 'Claude Code is not installed on this computer' };
  if (!mcpConfigPath) await bootMcp();

  let prompt = '';
  if (notes.length) { prompt += notes.map(n => '(Portal note: ' + n + ')').join('\n') + '\n\n'; notes = []; }
  if (files && files.length)
    prompt += 'Attached: ' + files.map(f => `uploads/${f.name}`).join(', ') + '\n\n';
  prompt += text;

  const t = runTurn({
    exe: claudeExe,
    prompt,
    sessionId: readCfg().sessionId,
    cwd: workDir(),
    mcpConfig: mcpConfigPath,
    systemPromptFile: systemPromptPath,
    onEvent: ev => {
      if (ev.type === 'session') writeCfg({ sessionId: ev.id });
      if (ev.type === 'done') {
        if (ev.sessionId) writeCfg({ sessionId: ev.sessionId });
        turn = null;
      }
      sendUI('chat:event', ev);
    }
  });
  turn = t;
  return { ok: true };
});

ipcMain.handle('chat:stop', () => { if (turn) turn.cancel(); return true; });
ipcMain.handle('chat:new', () => { if (turn) turn.cancel(); writeCfg({ sessionId: null }); notes = []; return true; });

ipcMain.handle('proposal:alive', (_e, id) => tools.hasProposal(id));
ipcMain.handle('proposal:confirm', async (_e, id) => {
  try {
    const r = await withLogin(() => tools.submitProposal(id));
    notes.push(`Saif clicked Submit. "${r.card.assignment}" (${r.card.course}) now has ${r.card.files.map(f => f.name).join(', ')}` +
      (r.attempt ? `, attempt ${r.attempt}` : '') + ` at ${r.submitted_at}${r.late ? ', marked late' : ''}.`);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('proposal:dismiss', (_e, id) => {
  const c = tools.dismissProposal(id);
  if (c) notes.push(`Saif chose not to submit ${c.files.map(f => f.name).join(', ')} to "${c.assignment}".`);
  return true;
});

ipcMain.handle('open:external', (_e, url) => {
  if (/^https:\/\//i.test(String(url))) shell.openExternal(url);
});

/* ── window ── */
const boundsPath = () => path.join(userData(), 'window.json');
function createWindow() {
  let b = {};
  try { b = JSON.parse(fs.readFileSync(boundsPath(), 'utf8')); } catch (e) {}
  win = new BrowserWindow({
    width: b.width || 1180, height: b.height || 820, x: b.x, y: b.y,
    minWidth: 720, minHeight: 520,
    title: 'Canvas Portal',
    autoHideMenuBar: true,
    backgroundColor: '#f7f6f3',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (/^https:\/\//i.test(url)) shell.openExternal(url); }
  });
  win.on('close', () => { try { fs.writeFileSync(boundsPath(), JSON.stringify(win.getBounds())); } catch (e) {} });
  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(async () => {
  await bootMcp();
  createWindow();
});
app.on('window-all-closed', () => { if (turn) turn.cancel(); app.quit(); });
