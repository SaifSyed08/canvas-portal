/* A small Markdown renderer for chat replies. Everything is escaped first, so
   model output can never become live HTML; only the constructs below are
   turned back into tags. */
(function () {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2">$2</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[+i] + '</code>');
  }

  const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));

  function render(src) {
    const lines = esc(String(src || '')).replace(/\r/g, '').split('\n');
    const listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];

      const fence = l.match(/^\s*```(\S*)/);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
        i++;
        out.push('<pre><code>' + body.join('\n') + '</code></pre>');
        continue;
      }
      if (/^\s*$/.test(l)) { i++; continue; }

      const h = l.match(/^(#{1,4})\s+(.*)$/);
      if (h) { const n = Math.min(h[1].length + 1, 5); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }

      if (/^\s*(---|\*\*\*|___)\s*$/.test(l)) { out.push('<hr>'); i++; continue; }

      if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(l);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push('<div class="tbl"><table><thead><tr>' + head.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
          rows.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
        continue;
      }

      if (/^\s*&gt;\s?/.test(l)) {
        const body = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*&gt;\s?/, ''));
        out.push('<blockquote>' + render.fromEscaped(body.join('\n')) + '</blockquote>');
        continue;
      }

      if (listRe.test(l)) {
        out.push(list());
        continue;
      }

      const para = [];
      while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) &&
             !listRe.test(lines[i]) && !/^\s*&gt;/.test(lines[i]) &&
             !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])))
        para.push(lines[i++]);
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    }
    return out.join('');

    function list() {
      const first = lines[i].match(listRe);
      const indent = first[1].length;
      const ordered = /\d/.test(first[2]);
      const start = ordered ? parseInt(first[2], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(listRe);
        if (m && m[1].length === indent && /\d/.test(m[2]) === ordered) {
          items.push({ text: [m[3]], sub: [] });
          i++;
        } else if (m && m[1].length > indent && items.length) {
          items[items.length - 1].sub.push(list());
        } else if (!m && lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1].text.push(lines[i].trim());
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      return `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>` +
        items.map(it => '<li>' + it.text.map(inline).join('<br>') + it.sub.join('') + '</li>').join('') + `</${tag}>`;
    }
  }

  /* blockquotes recurse on text that is already escaped */
  render.fromEscaped = s => render(s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));

  window.renderMarkdown = render;
})();
