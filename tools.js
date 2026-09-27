/* The Canvas tools Claude can call, plus the hand-in flow.

   Everything here reads, except propose_submission — and that one only puts a
   card in front of Saif. The actual upload runs from submitProposal(), which
   only the Submit button on that card can reach. */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MAX_DOWNLOAD = 40e6;
const MAX_TEXT = 24000;

/* ── text helpers ── */

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function htmlToText(html) {
  if (!html) return '';
  return decodeEntities(String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => {
      const label = t.replace(/<[^>]+>/g, '').trim();
      return label && label !== href ? `${label} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol|blockquote)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* File links inside descriptions and pages point at /courses/1/files/123 or
   /api/v1/courses/1/files/123; surfacing the ids lets Claude open them. */
function fileIdsIn(html) {
  const ids = new Set();
  for (const m of String(html || '').matchAll(/\/files\/(\d+)/g)) ids.add(m[1]);
  return [...ids];
}

const clip = (s, n = MAX_TEXT) => (s && s.length > n ? s.slice(0, n) + '\n…(cut off)' : s);

/* ── .docx / .pptx: they are zip files of XML, and Read cannot open them ── */

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out[name] = () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function officeText(buf, ext) {
  const z = unzip(buf);
  const xmlText = (xml, para) => decodeEntities(xml
    .replace(new RegExp(`</${para}>`, 'g'), '\n')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
  if (ext === '.docx' && z['word/document.xml']) return xmlText(z['word/document.xml'](), 'w:p');
  if (ext === '.pptx') {
    const slides = Object.keys(z).filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
    return slides.map((k, i) => `--- Slide ${i + 1} ---\n` + xmlText(z[k](), 'a:p')).join('\n\n');
  }
  return null;
}

const MIME = {
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.html': 'text/html',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.heic': 'image/heic',
  '.zip': 'application/zip', '.py': 'text/x-python', '.java': 'text/x-java', '.js': 'text/javascript',
  '.c': 'text/x-c', '.cpp': 'text/x-c++', '.ipynb': 'application/x-ipynb+json', '.r': 'text/plain', '.rmd': 'text/plain'
};
const mimeOf = name => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

const safeName = s => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150);

/* ── the tools ── */

function createTools({ canvas, workDir, onProposal }) {
  const uploadsDir = path.join(workDir, 'uploads');
  const downloadsDir = path.join(workDir, 'downloads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });

  const courseNames = new Map();
  const proposals = new Map();

  async function courses() {
    const list = await canvas.getAll('/api/v1/courses?enrollment_state=active&per_page=100&include[]=term');
    const out = list.filter(c => c && c.name).map(c => ({
      id: c.id, name: c.name, code: c.course_code, term: c.term && c.term.name
    }));
    out.forEach(c => courseNames.set(String(c.id), c.name));
    return out;
  }

  async function courseName(id) {
    if (!courseNames.has(String(id))) {
      try { const c = await canvas.get(`/api/v1/courses/${id}`); courseNames.set(String(id), c.name); } catch (e) {}
    }
    return courseNames.get(String(id)) || 'Course ' + id;
  }

  async function upcoming({ days = 14, past_days = 3 } = {}) {
    const start = new Date(Date.now() - past_days * 864e5).toISOString();
    const end = new Date(Date.now() + days * 864e5).toISOString();
    const items = await canvas.getAll(`/api/v1/planner/items?start_date=${start}&end_date=${end}&per_page=100`);
    return items.filter(it => it.plannable_type !== 'planner_note' || it.plannable).map(it => {
      const p = it.plannable || {};
      const sub = it.submissions || {};
      return {
        type: it.plannable_type,
        title: p.title || p.name,
        course: it.context_name,
        course_id: it.course_id,
        assignment_id: it.plannable_type === 'assignment' ? it.plannable_id : (p.assignment_id || null),
        due: it.plannable_date,
        points: p.points_possible,
        submitted: !!sub.submitted, missing: !!sub.missing, late: !!sub.late, graded: !!sub.graded,
        plannable_id: it.plannable_id,
        done: !!(it.planner_override && it.planner_override.marked_complete),
        override_id: it.planner_override ? it.planner_override.id : null,
        url: it.html_url ? canvas.base() + it.html_url : null
      };
    });
  }

  /* Canvas's own planner checkbox (the one on the dashboard's list view), so
     "done" shows up on the website and the phone app too. It never submits
     anything; it is for work that is finished some other way, like a group
     project one teammate handed in. */
  async function setDone({ type, plannable_id, override_id, done }) {
    if (override_id)
      return canvas.send(`/api/v1/planner/overrides/${override_id}`, 'PUT', [['marked_complete', done ? 'true' : 'false']]);
    return canvas.send('/api/v1/planner/overrides', 'POST', [
      ['plannable_type', type], ['plannable_id', plannable_id], ['marked_complete', done ? 'true' : 'false']
    ]);
  }

  async function assignment(courseId, assignmentId) {
    return canvas.get(`/api/v1/courses/${courseId}/assignments/${assignmentId}?include[]=submission`);
  }

  function uploadsList() {
    return fs.readdirSync(uploadsDir).map(name => {
      const st = fs.statSync(path.join(uploadsDir, name));
      return { name, size: st.size, path: path.join(uploadsDir, name) };
    }).filter(f => f.size >= 0);
  }

  async function fetchFile(fileId) {
    const meta = await canvas.get(`/api/v1/files/${fileId}`);
    const name = meta.display_name || meta.filename || 'file-' + fileId;
    const ext = path.extname(name).toLowerCase();
    const buf = await canvas.download(meta.url, MAX_DOWNLOAD);
    const local = path.join(downloadsDir, `${fileId}-${safeName(name)}`);
    fs.writeFileSync(local, buf);
    let readPath = local;
    let note = 'Open it with the Read tool.';
    if (ext === '.docx' || ext === '.pptx') {
      try {
        const text = officeText(buf, ext);
        if (text) {
          fs.writeFileSync(local + '.txt', text);
          readPath += '.txt';
          note = 'Converted to plain text; open it with the Read tool.';
        }
      } catch (e) {}
    }
    return { name, size: buf.length, content_type: meta['content-type'], path: readPath, note };
  }

  async function propose({ course_id, assignment_id, files, comment, source }) {
    if (!Array.isArray(files) || !files.length) throw new Error('Name at least one attached file to hand in.');
    const a = await assignment(course_id, assignment_id);
    const types = a.submission_types || [];
    if (!types.includes('online_upload'))
      throw new Error(`"${a.name}" does not take file uploads (it takes: ${types.join(', ') || 'nothing online'}).`);
    if (a.locked_for_user)
      throw new Error(`"${a.name}" is locked: ${htmlToText(a.lock_explanation) || 'Canvas is not accepting submissions.'}`);

    const picked = files.map(f => {
      let name = path.basename(String(f).replace(/^uploads[\\/]/, ''));
      if (path.isAbsolute(String(f)) && fs.existsSync(String(f)) && path.dirname(path.resolve(String(f))) !== uploadsDir) {
        if (fs.existsSync(path.join(uploadsDir, name)) && fs.statSync(path.join(uploadsDir, name)).size !== fs.statSync(String(f)).size)
          name = Date.now().toString(36) + '-' + name;
        fs.copyFileSync(String(f), path.join(uploadsDir, name));
      }
      const full = path.join(uploadsDir, name);
      if (!fs.existsSync(full)) throw new Error(`"${name}" is not one of Saif's attached files. Attached: ${uploadsList().map(u => u.name).join(', ') || 'none'}`);
      const ext = path.extname(name).slice(1).toLowerCase();
      const allowed = (a.allowed_extensions || []).map(x => x.toLowerCase());
      if (allowed.length && !allowed.includes(ext))
        throw new Error(`"${a.name}" only accepts ${allowed.map(x => '.' + x).join(', ')}, and ${name} is .${ext || '(none)'}.`);
      return { name, size: fs.statSync(full).size };
    });

    const sub = a.submission || {};
    const card = {
      id: crypto.randomBytes(8).toString('hex'),
      course_id, assignment_id,
      course: await courseName(course_id),
      assignment: a.name,
      due_at: a.due_at,
      points: a.points_possible,
      url: a.html_url,
      files: picked,
      comment: comment || '',
      source: source || 'claude',
      previous: sub.workflow_state && sub.workflow_state !== 'unsubmitted'
        ? { attempt: sub.attempt, submitted_at: sub.submitted_at, state: sub.workflow_state } : null,
      attempts_left: a.allowed_attempts > 0 ? a.allowed_attempts - (sub.attempt || 0) : null
    };
    proposals.set(card.id, card);
    onProposal(card);
    return 'A confirmation card is now showing in the Canvas Portal window. Nothing has been submitted: Canvas only gets the file if Saif clicks "Submit" on the card. Tell him briefly what the card will hand in, and stop there.';
  }

  async function submitProposal(id) {
    const card = proposals.get(id);
    if (!card) throw new Error('That hand-in request has expired. Ask again.');
    const a = await assignment(card.course_id, card.assignment_id);
    if (a.locked_for_user) throw new Error(`"${a.name}" locked since this was set up.`);
    const files = card.files.map(f => ({
      name: f.name, type: mimeOf(f.name), data: fs.readFileSync(path.join(uploadsDir, f.name))
    }));
    const sub = await canvas.submitFiles(card.course_id, card.assignment_id, files, card.comment);
    proposals.delete(id);
    return {
      card,
      attempt: sub && sub.attempt,
      submitted_at: (sub && sub.submitted_at) || new Date().toISOString(),
      late: !!(sub && sub.late)
    };
  }

  /* Rendered notebooks (Quarto, R Markdown, Jupyter) inline every image and
     font as base64, so a 2 MB page is mostly unreadable lines. The readable
     copy keeps the text, code and headings, marks where images were, and
     sits beside the original, which stays untouched for handing in. */
  function readableCopy(name) {
    const ext = path.extname(name).toLowerCase();
    if (ext !== '.html' && ext !== '.htm') return null;
    const src = path.join(uploadsDir, name);
    let html;
    try { html = fs.readFileSync(src, 'utf8'); } catch (e) { return null; }
    const text = htmlToText(html
      .replace(/<head[\s\S]*?<\/head>/i, '')
      .replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, '')
      .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, (_, alt) => `\n[image${alt ? ': ' + alt : ''}]\n`)
      .replace(/<img[^>]*>/gi, '\n[image]\n')
      .replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]+/g, '[embedded data]'));
    const dir = path.join(workDir, 'readable');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, name.replace(/\.html?$/i, '') + '.txt');
    fs.writeFileSync(out, text);
    return out;
  }

  /* ── tabs ── */

  /* Which tool reads a tab. Home depends on what the course set as its home
     page; external tools (Ed aside) can only be rendered. */
  function readerFor(tab, homeView) {
    const BY_ID = {
      announcements: 'list_announcements', assignments: 'list_assignments, then get_assignment',
      discussions: 'list_discussions, then get_discussion', grades: 'get_grades', people: 'list_people',
      pages: 'list_pages, then get_page', files: 'list_files, then get_file', syllabus: 'get_syllabus',
      quizzes: 'list_quizzes', modules: 'list_modules'
    };
    const HOME = {
      wiki: 'get_page with page_url "front_page"', modules: 'list_modules', assignments: 'list_assignments',
      syllabus: 'get_syllabus', feed: 'open_tab'
    };
    if (tab.id === 'home') return HOME[homeView] || 'open_tab';
    if (tab.type === 'external') return /\bed\b|edstem/i.test(tab.label) ? 'ed_threads, then ed_thread' : 'open_tab';
    return BY_ID[tab.id] || 'open_tab';
  }

  /* /view is the whole threaded discussion in one go. Canvas builds it in the
     background and says 503 until it is ready, and it is 403 when the topic
     wants Saif's own post first. */
  async function discussion(courseId, topicId) {
    const t = await canvas.get(`/api/v1/courses/${courseId}/discussion_topics/${topicId}`);
    const out = {
      title: t.title, author: t.author && t.author.display_name || t.user_name, posted_at: t.posted_at,
      due_at: (t.assignment && t.assignment.due_at) || undefined,
      prompt: clip(htmlToText(t.message), 8000),
      linked_file_ids: fileIdsIn(t.message),
      attachments: (t.attachments || []).map(a => ({ file_id: a.id, name: a.display_name })),
      url: t.html_url
    };
    let view = null;
    for (let i = 0; i < 3 && !view; i++) {
      try { view = await canvas.get(`/api/v1/courses/${courseId}/discussion_topics/${topicId}/view?include_new_entries=1`); }
      catch (e) {
        if (/503/.test(e.message) && i < 2) { await new Promise(r => setTimeout(r, 1500)); continue; }
        if (/403|initial_post|must post/i.test(e.message)) { out.replies = 'Hidden until Saif posts his own reply (the topic is set up that way).'; return out; }
        throw e;
      }
    }
    const who = new Map((view.participants || []).map(p => [p.id, p.display_name]));
    const entries = [...(view.view || []), ...(view.new_entries || [])];
    const lines = [];
    let budget = MAX_TEXT;
    const walk = (list, depth) => {
      for (const e of list || []) {
        if (budget <= 0) return;
        const pad = '  '.repeat(depth);
        const body = e.deleted ? '(deleted)' : htmlToText(e.message).replace(/\n+/g, '\n' + pad + '  ');
        const line = `${pad}- ${who.get(e.user_id) || 'Someone'} (${(e.created_at || '').slice(0, 10)}): ${body}`;
        lines.push(line);
        budget -= line.length;
        for (const f of fileIdsIn(e.message)) out.linked_file_ids.push(f);
        walk(e.replies, depth + 1);
      }
    };
    walk(entries, 0);
    out.reply_count = lines.length;
    out.replies = lines.join('\n') + (budget <= 0 ? '\n…(more replies cut off)' : '') || '(no replies yet)';
    out.linked_file_ids = [...new Set(out.linked_file_ids)];
    return out;
  }

  /* Plenty of courses switch the Files tab off and post files through
     modules instead; those files still open by id. */
  async function files({ course_id, search, folder }) {
    try {
      const q = search && search.trim().length >= 2 ? '&search_term=' + encodeURIComponent(search.trim()) : '';
      const [list, folders] = await Promise.all([
        canvas.getAll(`/api/v1/courses/${course_id}/files?per_page=100&sort=updated_at&order=desc${q}`, 1000),
        canvas.getAll(`/api/v1/courses/${course_id}/folders?per_page=100`, 1000).catch(() => [])
      ]);
      const where = new Map(folders.map(f => [f.id, String(f.full_name || f.name || '').replace(/^course files\/?/, '') || '(top)']));
      let out = list.map(f => ({
        file_id: f.id, name: f.display_name, folder: where.get(f.folder_id) || undefined,
        size_kb: Math.round((f.size || 0) / 1024), updated_at: f.updated_at,
        locked: f.locked_for_user || undefined
      }));
      if (folder) out = out.filter(f => String(f.folder || '').toLowerCase().includes(folder.toLowerCase()));
      return out.length > 250
        ? { note: `${out.length} files; showing the 250 newest. Narrow it with search or folder.`, files: out.slice(0, 250) }
        : out;
    } catch (e) {
      if (e.code !== 'forbidden' && !/40[34]/.test(e.message)) throw e;
      const mods = await canvas.getAll(`/api/v1/courses/${course_id}/modules?include[]=items&per_page=50`);
      let out = [];
      for (const m of mods) for (const i of m.items || [])
        if (i.type === 'File') out.push({ file_id: i.content_id, name: i.title, module: m.name });
      if (search) out = out.filter(f => f.name.toLowerCase().includes(search.toLowerCase()));
      if (folder) out = out.filter(f => f.module.toLowerCase().includes(folder.toLowerCase()));
      return { note: 'This course hides its Files tab from students, so these are the files posted in its modules.', files: out };
    }
  }

  async function grades({ course_id }) {
    const [course, enr, groups] = await Promise.all([
      canvas.get(`/api/v1/courses/${course_id}`),
      canvas.getAll(`/api/v1/courses/${course_id}/enrollments?user_id=self&type[]=StudentEnrollment&per_page=10`).catch(() => []),
      canvas.getAll(`/api/v1/courses/${course_id}/assignment_groups?include[]=assignments&include[]=submission&per_page=50`)
    ]);
    const g = (enr[0] && enr[0].grades) || {};
    const weighted = !!course.apply_assignment_group_weights;
    return {
      course: course.name,
      current_score: g.current_score != null ? g.current_score : null,
      current_grade: g.current_grade || null,
      note: g.current_score == null ? 'Canvas is not showing a course total for this class (the instructor may hide it).' : undefined,
      weighted_by_group: weighted,
      groups: groups.map(gr => ({
        group: gr.name,
        weight_percent: weighted ? gr.group_weight : undefined,
        drop_lowest: gr.rules && gr.rules.drop_lowest || undefined,
        assignments: (gr.assignments || []).map(a => {
          const s = a.submission || {};
          return {
            name: a.name, assignment_id: a.id, due_at: a.due_at, points: a.points_possible,
            score: s.score != null ? s.score : null, grade: s.grade || undefined,
            missing: s.missing || undefined, late: s.late || undefined, excused: s.excused || undefined,
            submitted: !!s.submitted_at, not_counted: a.omit_from_final_grade || undefined
          };
        })
      }))
    };
  }

  const dismissProposal = id => { const c = proposals.get(id); proposals.delete(id); return c; };
  const hasProposal = id => proposals.has(id);

  const obj = (props, required = []) => ({ type: 'object', properties: props, required });
  const id = { type: ['integer', 'string'] };

  const tools = [
    {
      name: 'list_courses',
      description: "Saif's active Canvas courses with their ids.",
      inputSchema: obj({}),
      run: courses
    },
    {
      name: 'upcoming',
      description: 'Everything on the Canvas planner in a window around today, across all courses: assignments, quizzes, discussions, events, with due dates and whether each is submitted, missing, or graded.',
      inputSchema: obj({
        days: { type: 'integer', description: 'How many days ahead (default 14)' },
        past_days: { type: 'integer', description: 'How many days back (default 3)' }
      }),
      run: upcoming
    },
    {
      name: 'list_assignments',
      description: 'Assignments in one course with due dates, points, submission status, and score.',
      inputSchema: obj({
        course_id: id,
        bucket: { type: 'string', enum: ['upcoming', 'future', 'past', 'overdue', 'unsubmitted', 'ungraded', 'undated'], description: 'Optional filter' }
      }, ['course_id']),
      run: async ({ course_id, bucket }) => {
        const list = await canvas.getAll(`/api/v1/courses/${course_id}/assignments?include[]=submission&order_by=due_at&per_page=100` + (bucket ? '&bucket=' + bucket : ''));
        return list.map(a => ({
          id: a.id, name: a.name, due_at: a.due_at, points: a.points_possible,
          submission_types: a.submission_types,
          status: a.submission ? a.submission.workflow_state : null,
          score: a.submission ? a.submission.score : null,
          late: a.submission ? a.submission.late : null,
          missing: a.submission ? a.submission.missing : null
        }));
      }
    },
    {
      name: 'get_assignment',
      description: 'Full detail for one assignment: instructions, rubric, accepted file types, attempts, lock dates, and Saif\'s current submission and grade. Lists the ids of any Canvas files the instructions link to, which get_file can open.',
      inputSchema: obj({ course_id: id, assignment_id: id }, ['course_id', 'assignment_id']),
      run: async ({ course_id, assignment_id }) => {
        const a = await assignment(course_id, assignment_id);
        const s = a.submission || {};
        return {
          id: a.id, name: a.name, course: await courseName(course_id),
          due_at: a.due_at, unlock_at: a.unlock_at, lock_at: a.lock_at,
          points: a.points_possible, grading_type: a.grading_type,
          submission_types: a.submission_types, allowed_extensions: a.allowed_extensions,
          allowed_attempts: a.allowed_attempts,
          locked: a.locked_for_user, lock_explanation: htmlToText(a.lock_explanation),
          instructions: clip(htmlToText(a.description)),
          linked_file_ids: fileIdsIn(a.description),
          rubric: (a.rubric || []).map(r => ({
            criterion: r.description, points: r.points, detail: r.long_description,
            ratings: (r.ratings || []).map(x => `${x.points}: ${x.description}`)
          })),
          submission: {
            state: s.workflow_state, submitted_at: s.submitted_at, attempt: s.attempt,
            score: s.score, grade: s.grade, late: s.late, missing: s.missing
          },
          url: a.html_url
        };
      }
    },
    {
      name: 'get_file',
      description: 'Download a Canvas file by id (from get_assignment, get_page, or list_modules) so you can read it. Returns a local path for the Read tool. Word and PowerPoint files come back as plain text.',
      inputSchema: obj({ file_id: id }, ['file_id']),
      run: ({ file_id }) => fetchFile(file_id)
    },
    {
      name: 'get_syllabus',
      description: 'The syllabus page of a course.',
      inputSchema: obj({ course_id: id }, ['course_id']),
      run: async ({ course_id }) => {
        const c = await canvas.get(`/api/v1/courses/${course_id}?include[]=syllabus_body`);
        return { course: c.name, syllabus: clip(htmlToText(c.syllabus_body)) || '(empty)', linked_file_ids: fileIdsIn(c.syllabus_body) };
      }
    },
    {
      name: 'list_modules',
      description: 'The modules of a course and what is in each (pages, files, assignments, links). Instructions often live here.',
      inputSchema: obj({ course_id: id }, ['course_id']),
      run: async ({ course_id }) => {
        const mods = await canvas.getAll(`/api/v1/courses/${course_id}/modules?include[]=items&per_page=50`);
        return mods.map(m => ({
          module: m.name,
          items: (m.items || []).map(i => ({
            title: i.title, type: i.type,
            file_id: i.type === 'File' ? i.content_id : undefined,
            assignment_id: i.type === 'Assignment' ? i.content_id : undefined,
            discussion_id: i.type === 'Discussion' ? i.content_id : undefined,
            quiz_id: i.type === 'Quiz' ? i.content_id : undefined,
            page_url: i.page_url, external_url: i.external_url,
            /* an external tool item (a video, Gradescope) has nothing to read
               through the API; open_canvas_page can render it */
            open_url: i.type === 'ExternalTool' ? i.html_url : undefined
          }))
        }));
      }
    },
    {
      name: 'get_page',
      description: 'Read a course page by its page_url (from list_pages or list_modules). Use page_url "front_page" for the course home page.',
      inputSchema: obj({ course_id: id, page_url: { type: 'string' } }, ['course_id', 'page_url']),
      run: async ({ course_id, page_url }) => {
        const p = await canvas.get(page_url === 'front_page'
          ? `/api/v1/courses/${course_id}/front_page`
          : `/api/v1/courses/${course_id}/pages/${encodeURIComponent(page_url)}`);
        return { title: p.title, body: clip(htmlToText(p.body)), linked_file_ids: fileIdsIn(p.body), updated_at: p.updated_at };
      }
    },
    {
      name: 'list_tabs',
      description: "The tabs in a course's left-hand menu on Canvas (Home, Discussions, Files, Grades, Ed Discussion, Gradescope…) and which tool reads each one. Start here when Saif asks about a part of a course that isn't an assignment.",
      inputSchema: obj({ course_id: id }, ['course_id']),
      run: async ({ course_id }) => {
        const [tabs, course] = await Promise.all([
          canvas.getAll(`/api/v1/courses/${course_id}/tabs?per_page=100`),
          canvas.get(`/api/v1/courses/${course_id}`).catch(() => ({}))
        ]);
        return tabs.map(t => ({ tab: t.id, label: t.label, external: t.type === 'external', read_with: readerFor(t, course.default_view) }));
      }
    },
    {
      name: 'list_discussions',
      description: "A course's Discussions tab (Canvas discussions, not Ed): topics with reply and unread counts, due dates for graded ones, and whether Saif has to post before he can see replies.",
      inputSchema: obj({
        course_id: id,
        search: { type: 'string', description: 'Optional words to look for in titles' }
      }, ['course_id']),
      run: async ({ course_id, search }) => {
        const q = search ? '&search_term=' + encodeURIComponent(search) : '';
        const list = await canvas.getAll(`/api/v1/courses/${course_id}/discussion_topics?per_page=100&order_by=recent_activity${q}`, 200);
        return list.map(t => ({
          id: t.id, title: t.title,
          author: t.author && t.author.display_name || t.user_name,
          posted_at: t.posted_at, last_reply_at: t.last_reply_at,
          replies: t.discussion_subentry_count, unread: t.unread_count,
          graded: !!t.assignment_id, assignment_id: t.assignment_id || undefined,
          due_at: (t.assignment && t.assignment.due_at) || t.todo_date || undefined,
          must_post_first: !!t.require_initial_post || undefined,
          locked: t.locked_for_user || undefined, pinned: t.pinned || undefined,
          preview: clip(htmlToText(t.message), 300)
        }));
      }
    },
    {
      name: 'get_discussion',
      description: 'Read one Canvas discussion: the prompt and every reply, threaded, with who wrote what and when. Lists the ids of any files it links to or has attached.',
      inputSchema: obj({ course_id: id, discussion_id: id }, ['course_id', 'discussion_id']),
      run: ({ course_id, discussion_id }) => discussion(course_id, discussion_id)
    },
    {
      name: 'list_files',
      description: "A course's Files tab: every file with its folder, size and date, newest first. If the course hides its Files tab, this falls back to the files posted in modules. get_file opens any of them.",
      inputSchema: obj({
        course_id: id,
        search: { type: 'string', description: 'Optional part of a file name (2+ letters)' },
        folder: { type: 'string', description: 'Optional part of a folder name, e.g. "Lecture"' }
      }, ['course_id']),
      run: files
    },
    {
      name: 'list_pages',
      description: "A course's Pages tab: every page with its page_url, newest first. Read one with get_page.",
      inputSchema: obj({
        course_id: id,
        search: { type: 'string', description: 'Optional words to look for in titles' }
      }, ['course_id']),
      run: async ({ course_id, search }) => {
        const q = search ? '&search_term=' + encodeURIComponent(search) : '';
        const list = await canvas.getAll(`/api/v1/courses/${course_id}/pages?per_page=100&sort=updated_at&order=desc${q}`, 300);
        return list.map(p => ({ title: p.title, page_url: p.url, updated_at: p.updated_at, home_page: p.front_page || undefined }));
      }
    },
    {
      name: 'get_grades',
      description: "A course's Grades tab: Saif's current overall grade, each assignment group with its weight, and every assignment's score, with missing, late and excused flags.",
      inputSchema: obj({ course_id: id }, ['course_id']),
      run: grades
    },
    {
      name: 'list_quizzes',
      description: "A course's Quizzes tab (classic Canvas quizzes): due and lock dates, time limit, attempts, question count, and the instructions. New Quizzes show up in list_assignments instead.",
      inputSchema: obj({ course_id: id }, ['course_id']),
      run: async ({ course_id }) => {
        const list = await canvas.getAll(`/api/v1/courses/${course_id}/quizzes?per_page=100`, 200);
        return list.map(z => ({
          id: z.id, title: z.title, type: z.quiz_type, assignment_id: z.assignment_id || undefined,
          due_at: z.due_at, unlock_at: z.unlock_at, lock_at: z.lock_at,
          time_limit_minutes: z.time_limit, allowed_attempts: z.allowed_attempts,
          questions: z.question_count, points: z.points_possible,
          locked: z.locked_for_user || undefined,
          lock_explanation: z.locked_for_user ? htmlToText(z.lock_explanation) : undefined,
          instructions: clip(htmlToText(z.description), 800) || undefined
        }));
      }
    },
    {
      name: 'list_people',
      description: "A course's People tab. By default the instructors and TAs (to find who teaches it or whom to ask); pass role \"student\" with a search to find a classmate.",
      inputSchema: obj({
        course_id: id,
        role: { type: 'string', enum: ['staff', 'student', 'all'], description: 'Default staff (teachers and TAs)' },
        search: { type: 'string', description: 'Optional part of a name' }
      }, ['course_id']),
      run: async ({ course_id, role = 'staff', search }) => {
        const types = { staff: ['teacher', 'ta'], student: ['student'], all: [] }[role] || ['teacher', 'ta'];
        const q = types.map(t => '&enrollment_type[]=' + t).join('') + (search ? '&search_term=' + encodeURIComponent(search) : '');
        const list = await canvas.getAll(`/api/v1/courses/${course_id}/users?per_page=100&include[]=enrollments&include[]=email${q}`, 300);
        const ROLE = { TeacherEnrollment: 'teacher', TaEnrollment: 'TA', StudentEnrollment: 'student', DesignerEnrollment: 'designer', ObserverEnrollment: 'observer' };
        return list.map(u => ({
          name: u.name, pronouns: u.pronouns || undefined, email: u.email || undefined,
          roles: [...new Set((u.enrollments || []).map(e => e.role && !ROLE[e.role] ? e.role : ROLE[e.type] || e.type))]
        }));
      }
    },
    {
      name: 'list_inbox',
      description: "Saif's Canvas Inbox: recent conversations with the subject, who is in them, the course, the last message, and whether it is unread. Read one with get_conversation.",
      inputSchema: obj({
        scope: { type: 'string', enum: ['inbox', 'unread', 'sent', 'starred', 'archived'], description: 'Default inbox' },
        course_id: { ...id, description: 'Optional: only this course' }
      }),
      run: async ({ scope = 'inbox', course_id }) => {
        const list = await canvas.getAll(`/api/v1/conversations?per_page=50&scope=${encodeURIComponent(scope)}` +
          (course_id ? '&filter[]=course_' + course_id : ''), 50);
        return list.map(c => ({
          id: c.id, subject: c.subject || '(no subject)', course: c.context_name,
          with: (c.participants || []).map(p => p.name).join(', '),
          unread: c.workflow_state === 'unread', messages: c.message_count,
          last_at: c.last_message_at, last_message: clip(c.last_message || '', 300)
        }));
      }
    },
    {
      name: 'get_conversation',
      description: 'Read one Canvas Inbox conversation in full, oldest message first. Does not mark it read. Attachments come with file ids for get_file.',
      inputSchema: obj({ conversation_id: id }, ['conversation_id']),
      run: async ({ conversation_id }) => {
        const c = await canvas.get(`/api/v1/conversations/${conversation_id}?auto_mark_as_read=false`);
        const who = new Map((c.participants || []).map(p => [p.id, p.name]));
        return {
          subject: c.subject, course: c.context_name,
          messages: (c.messages || []).slice().reverse().map(m => ({
            from: who.get(m.author_id) || 'Someone', at: m.created_at, text: clip(m.body || '', 6000),
            attachments: (m.attachments || []).map(a => ({ file_id: a.id, name: a.display_name })),
            media_comment: m.media_comment ? true : undefined
          }))
        };
      }
    },
    {
      name: 'list_announcements',
      description: 'Recent announcements, from one course or from all of them.',
      inputSchema: obj({
        course_id: { ...id, description: 'Leave out for every course' },
        days: { type: 'integer', description: 'How far back (default 21)' }
      }),
      run: async ({ course_id, days = 21 }) => {
        const ids = course_id ? [course_id] : (await courses()).map(c => c.id);
        if (!ids.length) return [];
        const start = new Date(Date.now() - days * 864e5).toISOString();
        const q = ids.map(i => 'context_codes[]=course_' + i).join('&');
        const list = await canvas.getAll(`/api/v1/announcements?${q}&start_date=${start}&per_page=50`, 60);
        return list.map(x => ({
          course: courseNames.get(String((x.context_code || '').replace('course_', ''))) || x.context_code,
          title: x.title, posted_at: x.posted_at, message: clip(htmlToText(x.message), 1500)
        }));
      }
    },
    {
      name: 'mark_done',
      description: "Tick (or untick) an item on Saif's Canvas planner, the same checkbox as Canvas's list view. It does not submit anything. Use it for work finished another way, like a group project a teammate handed in, and only when he asks. Takes the type, plannable_id and override_id from upcoming.",
      inputSchema: obj({
        type: { type: 'string', description: 'Item type from upcoming, e.g. assignment, quiz, discussion_topic' },
        plannable_id: id,
        override_id: { ...id, description: 'From upcoming, if present' },
        done: { type: 'boolean', description: 'true to tick, false to untick (default true)' }
      }, ['type', 'plannable_id']),
      run: async a => { await setDone({ ...a, done: a.done !== false }); return a.done === false ? 'Unticked.' : 'Ticked on the Canvas planner.'; }
    },
    {
      name: 'list_attached_files',
      description: 'Files Saif has attached in this app, which you can Read and which propose_submission can hand in.',
      inputSchema: obj({}),
      run: async () => uploadsList()
    },
    {
      name: 'propose_submission',
      description: 'Set up handing in attached files to an assignment. This does NOT submit. It shows Saif a confirmation card, and Canvas only receives the files if he clicks Submit on it. Only call this when he has asked you to hand something in.',
      inputSchema: obj({
        course_id: id,
        assignment_id: id,
        files: { type: 'array', items: { type: 'string' }, description: 'Names of attached files (see list_attached_files), or full paths to files on this computer' },
        comment: { type: 'string', description: 'Optional submission comment, only if Saif asked for one' }
      }, ['course_id', 'assignment_id', 'files']),
      run: propose
    }
  ];

  return { tools, upcoming, setDone, propose, readableCopy, submitProposal, dismissProposal, hasProposal, uploadsDir };
}

module.exports = { createTools };
