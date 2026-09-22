/* A tiny MCP server over HTTP, living inside the app.

   Claude Code connects to it for each turn and gets the Canvas tools. It sits
   on 127.0.0.1 behind a random path, so only the claude process we start
   (which is handed the address) can find it. Replies are plain JSON — the
   streamable HTTP transport allows that when there is nothing to stream. */

const http = require('http');
const crypto = require('crypto');

function startMcp(tools) {
  const token = crypto.randomBytes(18).toString('hex');
  const byName = new Map(tools.map(t => [t.name, t]));

  async function handle(m) {
    const reply = result => ({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize':
        return reply({
          protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'canvas', version: '0.1.0' }
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const t = byName.get(m.params && m.params.name);
        if (!t) return reply({ content: [{ type: 'text', text: 'No such tool' }], isError: true });
        try {
          const out = await t.run((m.params && m.params.arguments) || {});
          const text = typeof out === 'string' ? out : JSON.stringify(out, null, 1);
          return reply({ content: [{ type: 'text', text }] });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
        }
      }
      default:
        return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } };
    }
  }

  const server = http.createServer((req, res) => {
    if (req.url !== '/mcp/' + token) { res.writeHead(404); return res.end(); }
    if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }

    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (e) { res.writeHead(400); return res.end(); }
      const msgs = Array.isArray(parsed) ? parsed : [parsed];
      const replies = [];
      for (const m of msgs) if (m && m.id !== undefined && m.method) replies.push(await handle(m));
      if (!replies.length) { res.writeHead(202); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/mcp/${token}`, close: () => server.close() });
    });
  });
}

module.exports = { startMcp };
