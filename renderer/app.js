const P = window.portal;
const $ = s => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

const kb = n => n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

/* ── dates ── */
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
function dayLabel(d) {
  const diff = Math.round((startOfDay(d) - startOfDay(new Date())) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
const timeOf = d => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function whenText(iso) {
  if (!iso) return 'No due date';
  const d = new Date(iso);
  const ms = d - Date.now();
  const abs = Math.abs(ms);
  const rel = abs < 36e5 ? Math.max(1, Math.round(abs / 6e4)) + ' min'
    : abs < 864e5 * 2 ? Math.round(abs / 36e5) + ' hours' : Math.round(abs / 864e5) + ' days';
  return `${dayLabel(d)}, ${timeOf(d)} (${ms >= 0 ? 'in ' + rel : rel + ' ago'})`;
}

/* ── state ── */
let state = {};
let thread = [];
let pending = [];          // attached, not yet sent
let busy = false;
const STORE = 'portal.chat.v1';

function save() { try { localStorage.setItem(STORE, JSON.stringify(thread.slice(-200))); } catch (e) {} }
function load() { try { thread = JSON.parse(localStorage.getItem(STORE)) || []; } catch (e) { thread = []; } }

/* ── account (sidebar) ── */
function renderAccount() {
  const box = $('#account');
  box.replaceChildren();
  if (!state.base || !state.who) {
    box.append(h('div', { class: 'acct-card acct-out' },
      h('div', { class: 'acct-name' }, 'Not signed in'),
      h('div', { class: 'acct-sub' }, state.base ? state.school : 'Connect your Canvas to start'),
      h('button', { class: 'btn wide', style: 'margin-top:10px', onclick: () => { gateDismissed = false; syncGate(); } },
        state.base ? 'Sign in' : 'Connect Canvas')));
    return;
  }
  const host = new URL(state.base).host;
  box.append(h('div', { class: 'acct-card' },
    h('div', { class: 'acct-row' },
      h('div', { class: 'avatar' }, (state.who || '?').trim().charAt(0).toUpperCase()),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'acct-name' }, state.who),
        h('div', { class: 'acct-sub' }, state.school || host))),
    h('div', { class: 'acct-actions' },
      h('button', { class: 'link-btn', onclick: () => P.open(state.base) }, 'Open Canvas'),
      state.savedUser
        ? h('button', { class: 'link-btn', onclick: async () => { await P.forgetLogin(); state = await P.state(); renderAccount(); } }, 'Forget saved login')
        : null,
      h('button', { class: 'link-btn', onclick: async () => { state = await P.signOut(); renderAccount(); renderUpcoming([]); syncGate(); } }, 'Sign out'))));
}

/* ── the sign-in gate ──
   Full-window, over a blurred and dimmed app. It opens whenever there is no
   school or no session, moves between steps with a slide, and dissolves
   once Canvas answers. */
let gate = null;
let gateDismissed = false;
const STEPS = ['school', 'signin', 'done'];

function gateStep() { return !state.base ? 'school' : !state.who ? 'signin' : null; }

function syncGate() {
  const step = gateStep();
  if (step && !gateDismissed) openGate(step);
  else if (!step && gate && gate.step !== 'done') showStep('done');
}

const icon = svg => h('span', { class: 'ico', html: svg });
const ICON_X = '<svg viewBox="0 0 20 20" width="16" height="16"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_SEARCH = '<svg viewBox="0 0 20 20" width="18" height="18"><circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13.2 13.2 17 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_KEY = '<svg viewBox="0 0 20 20" width="14" height="14"><circle cx="7" cy="10" r="3.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.2 10H17m-2.5 0v2.6M17 10v2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_EYE = '<svg viewBox="0 0 20 20" width="17" height="17"><path d="M1.8 10S4.8 4.5 10 4.5 18.2 10 18.2 10 15.2 15.5 10 15.5 1.8 10 1.8 10Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 20 20" width="17" height="17"><path d="M3 3l14 14M8.2 5a8.6 8.6 0 0 1 1.8-.5c5.2 0 8.2 5.5 8.2 5.5a14 14 0 0 1-2.3 2.9M12.4 14.9a7.8 7.8 0 0 1-2.4.6C4.8 15.5 1.8 10 1.8 10a14.2 14.2 0 0 1 3.3-3.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.2 8.3a2.6 2.6 0 0 0 3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 20 20" width="14" height="14"><path d="M12 5l-5 5 5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function openGate(step) {
  if (!gate) {
    const stage = h('div', { class: 'gate-stage' });
    const el = h('div', { class: 'gate', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'gate-card' },
        h('button', { class: 'gate-x', title: 'Not now', 'aria-label': 'Close', onclick: () => { gateDismissed = true; closeGate(); } }, icon(ICON_X)),
        stage));
    document.body.append(el);
    el.getBoundingClientRect();
    el.classList.add('open');
    gate = { el, stage, step: null };
  }
  if (gate.step !== step) showStep(step);
}

function closeGate() {
  if (!gate) return;
  const g = gate;
  gate = null;
  P.chromeStop();
  g.el.classList.remove('open');
  g.el.classList.add('closing');
  setTimeout(() => g.el.remove(), 520);
}

function showStep(step) {
  const stage = gate.stage;
  const dir = STEPS.indexOf(step) >= STEPS.indexOf(gate.step) ? 1 : -1;
  const prev = stage.querySelector('.gate-step:not(.leaving)');
  const from = stage.offsetHeight;
  const next = h('div', { class: 'gate-step' }, ...BUILD[step]());
  next.style.setProperty('--dir', dir);
  stage.append(next);
  if (prev) {
    prev.style.setProperty('--dir', dir);
    prev.classList.add('leaving');
    setTimeout(() => prev.remove(), 320);
    stage.animate([{ height: from + 'px' }, { height: next.offsetHeight + 'px' }],
      { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)' });
  }
  gate.step = step;
  setTimeout(() => { const f = next.querySelector('input:not([type=checkbox])'); if (f && !f.value) f.focus(); }, 140);
}

const BUILD = {
  school() {
    const input = h('input', { class: 'big-input', placeholder: 'Your school’s name', spellcheck: 'false', autocomplete: 'off' });
    const results = h('div', { class: 'schools' });
    const note = h('div', { class: 'msg' });
    const looksLikeAddress = v => /\.[a-z]{2,}(\/|$)/i.test(v.trim()) && !/\s/.test(v.trim());
    let seq = 0, timer = 0, top = null;

    const pick = async (domain, name, row) => {
      results.querySelectorAll('.school').forEach(b => b.classList.toggle('dim', b !== row));
      if (row) row.classList.add('picked');
      const r = await P.setBase(domain, name);
      if (!r.ok) {
        results.querySelectorAll('.school').forEach(b => b.classList.remove('dim', 'picked'));
        note.className = 'msg err';
        note.textContent = r.error;
        return;
      }
      state = await P.state();
      renderAccount();
      showStep('signin');
    };

    const row = (name, dom, i, onclick) => {
      const b = h('button', { type: 'button', class: 'school', style: `animation-delay:${i * 35}ms` },
        h('div', { class: 'school-name' }, name), h('div', { class: 'school-dom' }, dom));
      b.addEventListener('click', () => onclick(b));
      return b;
    };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      note.textContent = '';
      const v = input.value.trim();
      timer = setTimeout(async () => {
        const mine = ++seq;
        top = null;
        if (looksLikeAddress(v)) {
          results.replaceChildren(row('Use this address', v, 0, b => pick(v, null, b)));
          top = () => pick(v, null, results.firstChild);
          return;
        }
        if (v.length < 2) return results.replaceChildren();
        results.classList.add('loading');
        const list = await P.searchSchools(v);
        if (mine !== seq) return;
        results.classList.remove('loading');
        if (!list.length) {
          results.replaceChildren(h('div', { class: 'schools-note' }, 'No match yet. Try the full name, or paste the address you open Canvas at.'));
          return;
        }
        results.replaceChildren(...list.map((s, i) => row(s.name, s.domain, i, b => pick(s.domain, s.name, b))));
        top = () => pick(list[0].domain, list[0].name, results.firstChild);
      }, looksLikeAddress(v) ? 0 : 260);
    });

    return [
      h('h2', { class: 'gate-title' }, 'Find your school'),
      h('p', { class: 'gate-sub' }, 'Search by name, or paste the address you open Canvas at.'),
      h('form', { class: 'search', onsubmit: e => { e.preventDefault(); if (top) top(); } }, icon(ICON_SEARCH), input),
      results,
      note
    ];
  },

  signin() {
    const eid = /utexas/.test(state.base) ? 'UT EID' : 'Username or school email';
    const user = h('input', { type: 'text', placeholder: eid, value: state.savedUser || '', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
    const pass = h('input', { type: 'password', placeholder: state.savedUser ? 'Saved' : '', autocomplete: 'off' });
    const eye = h('button', { type: 'button', class: 'eye', title: 'Show password', 'aria-label': 'Show password' }, icon(ICON_EYE));
    eye.addEventListener('click', () => {
      const show = pass.type === 'password';
      pass.type = show ? 'text' : 'password';
      eye.classList.toggle('on', show);
      eye.title = show ? 'Hide password' : 'Show password';
      eye.replaceChildren(icon(show ? ICON_EYE_OFF : ICON_EYE));
    });
    const remember = h('input', { type: 'checkbox', checked: state.canSaveLogin });
    const note = h('div', { class: 'msg' });
    const label = h('span', {}, 'Sign in');
    const btn = h('button', { class: 'btn big wide' }, h('span', { class: 'spinner' }), label);

    const busy = (on, text) => {
      btn.disabled = on;
      btn.classList.toggle('busy', on);
      label.textContent = on ? 'Signing in' : 'Sign in';
      if (text != null) { note.className = 'msg'; note.textContent = text; }
    };

    const go = async e => {
      if (e) e.preventDefault();
      P.chromeStop();
      if (remember.checked && user.value && pass.value) {
        const r = await P.saveLogin(user.value, pass.value);
        if (!r.ok) { note.className = 'msg err'; note.textContent = r.error; return; }
      }
      busy(true, (remember.checked && (pass.value || state.savedUser))
        ? 'Signing in with your details. If your school asks for a code or a phone approval, a window will open for it.'
        : 'Finish signing in in the window that opened.');
      const r = await P.login();
      state = await P.state();
      renderAccount();
      if (r.ok) { loadUpcoming(); showStep('done'); }
      else { busy(false); note.className = 'msg err'; note.textContent = r.error; }
    };

    /* Chrome's copy button → clipboard → here. Main watches the clipboard
       while Chrome's password page is open, and wipes it once it has it. */
    const fromChrome = h('button', { type: 'button', class: 'chrome-btn', title: "Copy it from Chrome's saved passwords" }, icon(ICON_KEY), 'From Chrome');
    fromChrome.addEventListener('click', async () => {
      const r = await P.chromePasswords();
      note.className = 'msg' + (r.ok ? ' wait' : ' err');
      note.textContent = !r.ok ? r.error
        : `Chrome's saved password${r.site ? ' for ' + r.site : 's'} ${r.site ? 'is' : 'are'} open. Click the copy button next to the password and it comes in here by itself.`;
    });
    const stopCapture = P.onChromeCaptured(c => {
      if (!document.body.contains(pass)) return stopCapture();
      if (c.kind === 'copied') {
        pass.value = c.value;
        remember.checked = true;
        pass.classList.remove('flash');
        void pass.offsetWidth;
        pass.classList.add('flash');
        P.chromeStop();
        P.toFront();
        note.className = 'msg ok';
        if (user.value.trim()) { note.textContent = 'Got it from Chrome.'; go(); }
        else {
          note.textContent = `Got your password. Type your ${/utexas/.test(state.base) ? 'UT EID' : 'username'} above, then Sign in.`;
          user.focus();
        }
      } else if (c.kind === 'timeout') {
        note.className = 'msg';
        note.textContent = 'Stopped waiting for Chrome. Click From Chrome to try again.';
      }
    });

    if (state.loggingIn) setTimeout(() => busy(true, 'Signing you back in…'));

    return [
      h('h2', { class: 'gate-title' }, 'Sign in to Canvas'),
      h('p', { class: 'gate-sub' }, state.school || new URL(state.base).host),
      h('form', { class: 'gate-form', onsubmit: go },
        state.canSaveLogin && h('label', { class: 'field' }, h('span', {}, /utexas/.test(state.base) ? 'UT EID' : 'Username'), user),
        state.canSaveLogin && h('div', { class: 'field' }, h('span', { class: 'field-head' }, 'Password', fromChrome),
          h('div', { class: 'pw-wrap' }, pass, eye)),
        state.canSaveLogin && h('label', { class: 'check' }, remember,
          h('span', {}, 'Keep me signed in. Saved encrypted, readable only by your Windows account.')),
        btn,
        note),
      h('div', { class: 'gate-foot' },
        h('button', { type: 'button', class: 'back-btn', onclick: async () => {
          P.chromeStop();
          await P.setBase('');
          state = await P.state();
          renderAccount();
          showStep('school');
        } }, icon(ICON_BACK), 'Different school'),
        state.savedUser && h('button', { type: 'button', class: 'link-btn', onclick: async () => {
          await P.forgetLogin();
          state = await P.state();
          user.value = '';
          pass.placeholder = '';
        } }, 'Forget saved login'))
    ];
  },

  done() {
    setTimeout(closeGate, 1300);
    const first = (state.who || '').split(' ')[0];
    return [
      h('div', { class: 'done-mark', html: '<svg viewBox="0 0 52 52" width="64" height="64"><circle class="ring" cx="26" cy="26" r="24" fill="none" stroke="currentColor" stroke-width="2"/><path class="tick" d="M15 27l7 7 15-16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
      h('h2', { class: 'gate-title center' }, first ? `You’re in, ${first}` : 'You’re in'),
      h('p', { class: 'gate-sub center' }, 'Canvas is connected.')
    ];
  }
};

/* ── upcoming ── */
let upcomingItems = [];
async function loadUpcoming() {
  if (!state.who) return renderUpcoming([], 'Sign in to see what is due.');
  $('#refresh').classList.add('spin');
  const r = await P.upcoming();
  $('#refresh').classList.remove('spin');
  if (!r.ok) {
    if (r.login) { state = await P.state(); renderAccount(); }
    return renderUpcoming([], r.error);
  }
  upcomingItems = r.items;
  renderUpcoming(r.items);
}

function renderUpcoming(items, empty) {
  const list = $('#upcoming');
  list.replaceChildren();
  const now = startOfDay(new Date());
  const show = items
    .filter(i => i.due && i.type !== 'calendar_event' && (new Date(i.due) >= now || (i.missing && !i.submitted)))
    .sort((a, b) => new Date(a.due) - new Date(b.due));
  if (!show.length) {
    list.append(h('div', { class: 'up-empty' }, empty || 'Nothing due in the next two weeks.'));
    return;
  }
  let day = '';
  for (const it of show) {
    const d = new Date(it.due);
    const overdue = d < new Date() && !it.submitted;
    const label = overdue ? 'Overdue' : dayLabel(d);
    if (label !== day) { day = label; list.append(h('div', { class: 'up-day' }, label)); }
    const pill = it.submitted ? h('span', { class: 'pill done' }, 'Done')
      : it.missing || overdue ? h('span', { class: 'pill missing' }, 'Missing')
      : null;
    list.append(h('button', {
      class: 'up-item',
      title: 'Ask about this',
      onclick: () => ask(`What do I need to do for "${it.title}" in ${it.course}?`)
    },
      h('div', { class: 'up-title' }, it.title),
      h('div', { class: 'up-meta' }, h('span', {}, timeOf(d)), h('span', {}, '·'), h('span', { class: 'course' }, it.course || ''), pill)));
  }
}

/* ── thread rendering ── */
const TOOL_LABELS = {
  list_courses: 'Checked your courses',
  upcoming: "Looked at what's coming up",
  list_assignments: 'Listed assignments',
  get_assignment: 'Read the assignment',
  get_file: 'Downloaded a course file',
  get_syllabus: 'Read the syllabus',
  list_modules: 'Looked through the modules',
  get_page: 'Read a course page',
  list_announcements: 'Checked announcements',
  list_attached_files: 'Checked your attached files',
  propose_submission: 'Set up a hand-in'
};
function toolLabel(name, input) {
  if (name === 'Read') {
    const f = String((input && input.file_path) || '').split(/[\\/]/).pop();
    return f ? 'Read ' + f.replace(/^\d+-/, '').replace(/\.txt$/, '') : 'Read a file';
  }
  return TOOL_LABELS[name.replace(/^mcp__canvas__/, '')] || name.replace(/^mcp__canvas__/, '').replace(/_/g, ' ');
}

function renderThread() {
  const root = $('#thread');
  root.replaceChildren();
  if (!thread.length) {
    const s = (b, t, q) => h('button', { onclick: () => send(q) }, h('b', {}, b), h('span', {}, t));
    root.append(h('div', { class: 'empty' },
      h('h1', {}, state.who ? `Hey ${state.who.split(' ')[0]}, what's up?` : 'Ask about your classes'),
      h('p', {}, 'Ask about deadlines, instructions, rubrics, or your grades.'),
      h('div', { class: 'suggest' },
        s("What's due this week?", 'Everything across your courses, in order', "What's due this week? Put it in order of when it's due."),
        s('Plan my week', 'Turn deadlines into a schedule', 'Look at everything due in the next 7 days and help me plan when to work on each one.'),
        s('Explain my next assignment', 'Instructions and rubric, simplified', 'Find my next assignment that is not submitted yet, and explain what it is asking for and how it is graded.'),
        s('Anything I missed?', 'Missing work and new announcements', 'Do I have any missing or late work, and are there any announcements from the last week I should know about?'))));
    return;
  }
  for (const item of thread) root.append(renderItem(item));
}

function renderItem(item) {
  if (item.role === 'user') {
    return h('div', { class: 'turn-user' },
      item.files && item.files.length ? h('div', { class: 'bubble-files' }, item.files.map(f => h('span', { class: 'file-chip' }, f.name, h('small', {}, kb(f.size))))) : null,
      item.text ? h('div', { class: 'bubble' }, item.text) : null);
  }
  const el = h('div', { class: 'turn-ai' });
  item.el = el;
  fillAi(item);
  return el;
}

function fillAi(item) {
  const el = item.el;
  el.replaceChildren();
  let any = false;
  const parts = item.parts || [];
  parts.forEach((p, i) => {
    if (p.kind === 'text' && p.text.trim()) { el.append(h('div', { class: 'md', html: renderMarkdown(p.text) })); any = true; }
    if (p.kind === 'tool') {
      const live = item.live && i === parts.length - 1;
      el.append(h('div', { class: 'tool' + (live ? ' live' : '') }, p.label));
      any = true;
    }
    if (p.kind === 'card') { el.append(renderCard(p, item)); any = true; }
    if (p.kind === 'error') { el.append(h('div', { class: 'err-line' }, p.text)); any = true; }
  });
  if (item.live && !any) el.append(h('div', { class: 'thinking' }, 'Thinking'));
}

function renderCard(p, item) {
  const c = p.card;
  const rows = h('div', { class: 'card-rows' },
    h('div', { class: 'card-row' }, h('span', {}, 'Files'),
      h('div', {}, c.files.map(f => h('span', { class: 'file-chip' }, f.name, h('small', {}, kb(f.size)))))),
    c.comment ? h('div', { class: 'card-row' }, h('span', {}, 'Comment'), h('div', {}, c.comment)) : null);

  const past = c.due_at && new Date(c.due_at) < new Date();
  if (past) rows.append(h('div', { class: 'note warn' }, 'The due date has passed, so Canvas may mark this late.'));
  if (c.previous) rows.append(h('div', { class: 'note warn' },
    `You already submitted this${c.previous.attempt ? ' (attempt ' + c.previous.attempt + ')' : ''}. This hands in a new attempt.` +
    (c.attempts_left != null ? ` ${c.attempts_left} attempt${c.attempts_left === 1 ? '' : 's'} left.` : '')));
  if (c.attempts_left === 0) rows.append(h('div', { class: 'note bad' }, 'Canvas says you have no attempts left, so it will probably refuse this.'));

  const foot = h('div', { class: 'card-foot' });
  const setStatus = (status, extra) => { Object.assign(p, { status }, extra || {}); save(); item.el && fillAi(item); };

  if (p.status === 'pending' || p.status === 'error') {
    const submit = h('button', { class: 'btn', onclick: async () => {
      setStatus('submitting');
      const r = await P.confirm(c.id);
      if (r.ok) { setStatus('submitted', { attempt: r.attempt, at: r.submitted_at, late: r.late }); loadUpcoming(); }
      else setStatus('error', { error: r.error });
    } }, p.status === 'error' ? 'Try again' : 'Submit to Canvas');
    const cancel = h('button', { class: 'btn ghost', onclick: async () => { await P.dismiss(c.id); setStatus('dismissed'); } }, "Don't submit");
    foot.append(submit, cancel);
    if (p.status === 'error') foot.append(h('div', { class: 'note bad', style: 'flex-basis:100%' }, p.error));
  } else if (p.status === 'submitting') {
    foot.append(h('div', { class: 'card-state muted' }, 'Uploading to Canvas…'));
  } else if (p.status === 'submitted') {
    foot.append(h('div', { class: 'card-state ok' },
      '✓ Submitted' + (p.attempt ? ' · attempt ' + p.attempt : '') + ' · ' + timeOf(new Date(p.at)) + (p.late ? ' · marked late' : '')),
      c.url ? h('button', { class: 'link-btn', onclick: () => P.open(c.url) }, 'View on Canvas') : null);
  } else if (p.status === 'dismissed') {
    foot.append(h('div', { class: 'card-state muted' }, 'Not submitted.'));
  } else if (p.status === 'expired') {
    foot.append(h('div', { class: 'card-state muted' }, 'This expired when the app closed. Ask again to hand it in.'));
  }

  return h('div', { class: 'card' },
    h('div', { class: 'card-top' },
      h('div', { class: 'card-kicker' }, p.status === 'submitted' ? 'Handed in' : 'Ready to hand in'),
      h('div', { class: 'card-title' }, c.assignment),
      h('div', { class: 'card-sub' }, `${c.course} · Due ${whenText(c.due_at)}` + (c.points != null ? ` · ${c.points} pts` : ''))),
    rows, foot);
}

/* ── scrolling ── */
const scroller = () => $('#scroller');
let stick = true;
function scrollDown(force) {
  const s = scroller();
  if (force || stick) s.scrollTop = s.scrollHeight;
}

/* ── sending ── */
let liveItem = null;
let frame = 0;
const repaint = () => {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; if (liveItem) fillAi(liveItem); scrollDown(); });
};

function setBusy(v) {
  busy = v;
  $('#composer').classList.toggle('busy', v);
  updateSend();
}
function updateSend() {
  $('#send').disabled = !busy && !$('#input').value.trim() && !pending.length;
}

async function send(text) {
  text = (text || '').trim();
  if (busy || (!text && !pending.length)) return;
  if (!text) text = 'I attached ' + (pending.length === 1 ? 'a file' : 'some files') + '.';
  const files = pending;
  pending = [];
  renderChips();
  $('#input').value = '';
  autosize();

  if (!thread.length) $('#thread').replaceChildren();
  const u = { role: 'user', text, files };
  thread.push(u);
  $('#thread').append(renderItem(u));

  liveItem = { role: 'ai', parts: [], live: true };
  thread.push(liveItem);
  $('#thread').append(renderItem(liveItem));
  stick = true;
  scrollDown(true);
  setBusy(true);
  save();

  const r = await P.send(text, files);
  if (!r.ok) finishTurn(r.error);
}

function finishTurn(error, stopped) {
  if (!liveItem) return;
  if (error) liveItem.parts.push({ kind: 'error', text: error });
  if (stopped) liveItem.parts.push({ kind: 'error', text: 'Stopped.' });
  liveItem.live = false;
  fillAi(liveItem);
  liveItem = null;
  setBusy(false);
  save();
  scrollDown();
}

P.onChat(ev => {
  if (!liveItem) return;
  const parts = liveItem.parts;
  const last = parts[parts.length - 1];
  if (ev.type === 'text-start') {
    if (!last || last.kind !== 'text') parts.push({ kind: 'text', text: '' });
    else if (last.text.trim()) last.text += '\n\n';
  } else if (ev.type === 'text') {
    if (!last || last.kind !== 'text') parts.push({ kind: 'text', text: ev.text });
    else last.text += ev.text;
  } else if (ev.type === 'tool') {
    const label = toolLabel(ev.name, ev.input);
    if (!(last && last.kind === 'tool' && last.label === label)) parts.push({ kind: 'tool', label });
  } else if (ev.type === 'proposal') {
    parts.push({ kind: 'card', card: ev.card, status: 'pending' });
  } else if (ev.type === 'done') {
    return finishTurn(ev.error, ev.stopped);
  }
  repaint();
});

/* ── attachments ── */
function renderChips() {
  const box = $('#chips');
  box.replaceChildren(...pending.map((f, i) => h('span', { class: 'chip' },
    f.name, h('small', {}, kb(f.size)),
    h('button', { type: 'button', title: 'Remove', onclick: () => { pending.splice(i, 1); renderChips(); } }, '×'))));
  updateSend();
}
function addPending(list) {
  for (const f of list) if (!pending.some(p => p.name === f.name)) pending.push(f);
  renderChips();
  $('#input').focus();
}

/* ── composer ── */
function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 220) + 'px';
  updateSend();
}
function ask(text) {
  const t = $('#input');
  t.value = text;
  autosize();
  t.focus();
  t.setSelectionRange(t.value.length, t.value.length);
}

async function init() {
  state = await P.state();
  load();
  for (const item of thread) {
    if (item.live) { item.live = false; (item.parts = item.parts || []).push({ kind: 'error', text: 'Interrupted.' }); }
    for (const p of item.parts || [])
      if (p.kind === 'card' && (p.status === 'pending' || p.status === 'submitting' || p.status === 'error'))
        if (!(await P.proposalAlive(p.card.id))) p.status = 'expired';
  }
  renderAccount();
  renderThread();
  syncGate();
  scrollDown(true);
  loadUpcoming();

  if (!state.claude) {
    thread.length || $('#thread').prepend(h('div', { class: 'err-line' },
      'Claude Code is not installed on this computer, so chat cannot work yet.'));
  }

  $('#composer').addEventListener('submit', e => { e.preventDefault(); busy ? P.stop() : send($('#input').value); });
  $('#input').addEventListener('input', autosize);
  $('#input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) send($('#input').value); }
  });
  $('#attach').addEventListener('click', async () => addPending(await P.pickFiles()));
  $('#refresh').addEventListener('click', loadUpcoming);
  $('#new-chat').addEventListener('click', async () => {
    await P.newChat();
    thread = [];
    liveItem = null;
    setBusy(false);
    save();
    renderThread();
    $('#input').focus();
  });
  scroller().addEventListener('scroll', () => {
    const s = scroller();
    stick = s.scrollHeight - s.scrollTop - s.clientHeight < 60;
  });

  document.addEventListener('click', e => {
    const a = e.target.closest('.md a');
    if (a) { e.preventDefault(); P.open(a.href); }
  });

  let depth = 0;
  const main = document.body;
  main.addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files')) { depth++; main.classList.add('dragging'); } });
  main.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; main.classList.remove('dragging'); } });
  main.addEventListener('dragover', e => e.preventDefault());
  main.addEventListener('drop', async e => {
    e.preventDefault();
    depth = 0;
    main.classList.remove('dragging');
    if (e.dataTransfer.files.length) addPending(await P.addFiles(e.dataTransfer.files));
  });
  document.addEventListener('paste', async e => {
    if (e.clipboardData && e.clipboardData.files.length) { e.preventDefault(); addPending(await P.addFiles(e.clipboardData.files)); }
  });

  P.onState(async s => {
    const had = !!state.who;
    state = s;
    renderAccount();
    if (s.who && !had) loadUpcoming();
    syncGate();
  });
  P.onLoginStatus(text => {
    const note = document.querySelector('.gate-step:not(.leaving) .msg');
    if (note) { note.className = 'msg wait'; note.textContent = text; }
  });

  updateSend();
  $('#input').focus();
}

init();
