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
        url: it.html_url ? canvas.base() + it.html_url : null
      };
    });
  }

  async function assignment(courseId, assignmentId) {
    return canvas.get(`/api/v1/courses/${courseId}/assignments/${assignmentId}?include[]=submission`);
  }

  function uploadsList() {
    return fs.readdirSync(uploadsDir).map(name => {
      const st = fs.statSync(path.join(uploadsDir, name));
      return { name, size: st.size, path: 'uploads/' + name };
    }).filter(f => f.size >= 0);
  }

  async function fetchFile(fileId) {
    const meta = await canvas.get(`/api/v1/files/${fileId}`);
    const name = meta.display_name || meta.filename || 'file-' + fileId;
    const ext = path.extname(name).toLowerCase();
    const buf = await canvas.download(meta.url, MAX_DOWNLOAD);
    const local = path.join(downloadsDir, `${fileId}-${safeName(name)}`);
    fs.writeFileSync(local, buf);
    let readPath = 'downloads/' + path.basename(local);
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

  async function propose({ course_id, assignment_id, files, comment }) {
    if (!Array.isArray(files) || !files.length) throw new Error('Name at least one attached file to hand in.');
    const a = await assignment(course_id, assignment_id);
    const types = a.submission_types || [];
    if (!types.includes('online_upload'))
      throw new Error(`"${a.name}" does not take file uploads (it takes: ${types.join(', ') || 'nothing online'}).`);
    if (a.locked_for_user)
      throw new Error(`"${a.name}" is locked: ${htmlToText(a.lock_explanation) || 'Canvas is not accepting submissions.'}`);

    const picked = files.map(f => {
      const name = path.basename(String(f).replace(/^uploads[\\/]/, ''));
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
      previous: sub.workflow_state && sub.workflow_state !== 'unsubmitted'
        ? { attempt: sub.attempt, submitted_at: sub.submitted_at, state: sub.workflow_state } : null,
      attempts_left: a.allowed_attempts > 0 ? a.allowed_attempts - (sub.attempt || 0) : null
    };
    proposals.set(card.id, card);
    onProposal(card);
    return 'A confirmation card is now showing in the chat. Nothing has been submitted: Canvas only gets the file if Saif clicks "Submit" on the card. Tell him briefly what the card will hand in, and stop there.';
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
            page_url: i.page_url, external_url: i.external_url
          }))
        }));
      }
    },
    {
      name: 'get_page',
      description: 'Read a course page by its page_url (from list_modules).',
      inputSchema: obj({ course_id: id, page_url: { type: 'string' } }, ['course_id', 'page_url']),
      run: async ({ course_id, page_url }) => {
        const p = await canvas.get(`/api/v1/courses/${course_id}/pages/${encodeURIComponent(page_url)}`);
        return { title: p.title, body: clip(htmlToText(p.body)), linked_file_ids: fileIdsIn(p.body) };
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
        files: { type: 'array', items: { type: 'string' }, description: 'Names of attached files (see list_attached_files)' },
        comment: { type: 'string', description: 'Optional submission comment, only if Saif asked for one' }
      }, ['course_id', 'assignment_id', 'files']),
      run: propose
    }
  ];

  return { tools, upcoming, submitProposal, dismissProposal, hasProposal, uploadsDir };
}

module.exports = { createTools };
