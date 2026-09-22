/* Each chat turn is one `claude -p` run, resumed by session id, so the portal
   uses the Claude Code login already on this machine — no API key. */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

function findClaude() {
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (fs.existsSync(local)) return local;
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return found.find(f => /\.exe$/i.test(f)) || found[0] || null;
  } catch (e) { return null; }
}

function runTurn({ exe, prompt, sessionId, cwd, mcpConfig, systemPromptFile, onEvent }) {
  const args = [
    '-p',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--tools', 'Read',
    '--allowedTools', 'mcp__canvas,Read',
    '--append-system-prompt-file', systemPromptFile
  ];
  if (sessionId) args.push('--resume', sessionId);

  /* Started from inside another Claude Code session, the child would think it
     is nested; it is not, it is ours. */
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|ELECTRON_)/.test(k)) delete env[k];

  const child = spawn(exe, args, { cwd, env, windowsHide: true });
  child.stdin.end(prompt);

  let stderr = '';
  let gotResult = false;
  let streamedSinceMessage = 0;
  let session = sessionId || null;

  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });

  readline.createInterface({ input: child.stdout }).on('line', line => {
    let ev;
    try { ev = JSON.parse(line); } catch (e) { return; }

    if (ev.session_id && ev.session_id !== session) {
      session = ev.session_id;
      onEvent({ type: 'session', id: session });
    }

    if (ev.type === 'stream_event' && ev.event) {
      const e = ev.event;
      if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'text')
        onEvent({ type: 'text-start' });
      if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
        streamedSinceMessage++;
        onEvent({ type: 'text', text: e.delta.text });
      }
    } else if (ev.type === 'assistant' && ev.message) {
      for (const b of ev.message.content || []) {
        if (b.type === 'tool_use') onEvent({ type: 'tool', name: b.name, input: b.input || {} });
        /* Without partial messages the text only arrives here, whole. */
        if (b.type === 'text' && !streamedSinceMessage) { onEvent({ type: 'text-start' }); onEvent({ type: 'text', text: b.text }); }
      }
      streamedSinceMessage = 0;
    } else if (ev.type === 'result') {
      gotResult = true;
      onEvent({
        type: 'done',
        sessionId: ev.session_id || session,
        error: ev.is_error ? (ev.result || (ev.errors && ev.errors.join('; ')) || 'Claude stopped with an error') : null
      });
    }
  });

  const done = new Promise(resolve => {
    child.on('error', err => {
      if (!gotResult) onEvent({ type: 'done', error: 'Could not start Claude Code: ' + err.message });
      gotResult = true;
      resolve();
    });
    child.on('close', code => {
      if (!gotResult) onEvent({
        type: 'done',
        error: child.killed ? null : ('Claude Code exited (' + code + ')' + (stderr.trim() ? ': ' + stderr.trim().split('\n').slice(-3).join(' ') : '')),
        stopped: child.killed
      });
      resolve();
    });
  });

  return { cancel: () => { try { child.kill(); } catch (e) {} }, done };
}

module.exports = { findClaude, runTurn };
