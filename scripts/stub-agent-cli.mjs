#!/usr/bin/env node
/**
 * A stand-in coding-agent CLI, for integration-testing the bridge end to end.
 *
 * Point `CURSOR_AGENT_PATH` / `CLAUDE_CODE_PATH` / `CODEX_PATH` /
 * `CODEWHALE_PATH` at this file and the bridge spawns it exactly as it would
 * the real CLI. Everything downstream
 * is production code: the real spawn, the real argv the provider built, the
 * real MCP Streamable HTTP transport, the real tool handlers, the real
 * interrupt hook. Only the model's judgement is replaced by a fixed script.
 *
 * That makes it able to prove things a unit test cannot:
 *   - the argv each provider builds is actually parseable by a CLI
 *   - the MCP registration each provider writes is actually usable to connect
 *   - a user turn fired mid-tool really does reach the agent process
 *   - each provider's stream parser really does capture the session id it needs
 *     for `--resume`
 *
 * It cannot prove the real CLIs accept these flags or authenticate — that needs
 * a signed-in machine.
 *
 * Behaviour is chosen from argv, the same way a real CLI would read it:
 *   voice mode  — the prompt mentions next_voice_turn
 *   worker mode — anything else (this is what agent_ask spawns)
 *
 * Codewhale note: set `CODEWHALE_HOME` to a scratch directory before running
 * the harness against the codewhale provider. That dialect has to *write* a
 * session file for the id to be recoverable (see below), and without the
 * override it would write into the real `~/.codewhale/sessions/` alongside
 * genuine sessions. The stub refuses to do that and logs instead.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? '';
const isVoice = /next_voice_turn/.test(prompt);

// ── Which CLI are we imitating? Inferred from the argv the provider built. ──

// Codewhale and Codex both lead with `exec`; only Codewhale passes
// `--output-format`, so check that first or every Codewhale run is misread as
// Codex and exercises the wrong parser.
const dialect =
  argv[0] === 'exec' && argv.includes('--output-format')
    ? 'codewhale'
    : argv[0] === 'exec'
      ? 'codex'
      : argv.includes('--workspace')
        ? 'cursor'
        : 'claude';

const log = (...a) => process.stderr.write(`[stub:${dialect}] ${a.join(' ')}\n`);
log('argv:', JSON.stringify(argv.slice(0, -1)));

// ── Emit NDJSON in that CLI's own dialect, so the bridge's provider parser
//    is genuinely exercised (session id capture especially). ────────────────

const sessionId = `stub-${dialect}-${Date.now().toString(36)}`;

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function emitInit() {
  if (dialect === 'codex') {
    emit({ id: '0', msg: { type: 'session_configured', session_id: sessionId, model: 'stub' } });
  } else if (dialect === 'codewhale') {
    // Codewhale has no init event at all. `turn_usage` with a 1-based `turn`
    // is the run-start marker its provider keys off, so that is what the
    // stub emits — reproducing the real gap rather than papering over it.
    emit({ type: 'turn_usage', turn: 1, input_tokens: 1200, output_tokens: 64, duration_ms: 900 });
  } else {
    emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'stub' });
  }
}

function emitToolStart(name, path) {
  if (dialect === 'codewhale') {
    emit({
      type: 'tool_use',
      name: name === 'read' ? 'Read' : 'Write',
      id: `call-${Math.random().toString(36).slice(2, 8)}`,
      input: { file_path: path },
      started_at: new Date().toISOString(),
    });
  } else if (dialect === 'cursor') {
    emit({ type: 'tool_call', subtype: 'started', tool_call: { [`${name}ToolCall`]: { args: { path } } } });
  } else if (dialect === 'codex') {
    emit({ id: '1', msg: { type: 'patch_apply_begin', changes: { [path]: {} } } });
  } else {
    emit({
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: path } }] },
    });
  }
}

function emitResult(text) {
  if (dialect === 'codex') {
    emit({ id: '9', msg: { type: 'task_complete', last_agent_message: text } });
  } else if (dialect === 'codewhale') {
    emit({ type: 'content', content: text });
    // Faithful to the real CLI: the stream id is a redacted fingerprint, and
    // the only way the provider can recover a resumable id is the session
    // store keyed by the (unredacted) workspace.
    writeCodewhaleSession();
    emit({ type: 'session_capture', content: '<redacted:9f2c41ab77e05d13>' });
    emit({
      type: 'metadata',
      meta: {
        receipt_kind: 'terminal',
        provider: 'deepseek',
        model: 'stub',
        route_source: 'stub',
        workspace: process.cwd(),
        session_id: '<redacted:9f2c41ab77e05d13>',
        resume_command: 'codewhale exec --resume <redacted-session-id>',
        approval_posture: 'auto',
        sandbox_posture: 'workspace-write',
        prompt_sha256: 'sha256:stub',
        duration_ms: 1234,
        message_count: 2,
        visible_final_answer_chars: text.length,
        input_analysis: {},
      },
    });
    emit({ type: 'done' });
  } else {
    emit({ type: 'result', subtype: 'success', session_id: sessionId, result: text, is_error: false });
  }
}

/**
 * Write the session file the real `codewhale exec` saves before it emits its
 * terminal receipt. Guarded on CODEWHALE_HOME so the stub can never drop a
 * fake session into a real `~/.codewhale/sessions/`.
 */
function writeCodewhaleSession() {
  const home = process.env.CODEWHALE_HOME?.trim();
  if (!home) {
    log('CODEWHALE_HOME not set — skipping session-store write; --resume capture will not be exercised');
    return;
  }
  const dir = join(home, 'sessions');
  const id = `${sessionId}-0000-4000-8000-000000000000`.slice(0, 36);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify(
      {
        schema_version: 1,
        metadata: {
          id,
          title: 'stub session',
          created_at: now,
          updated_at: now,
          message_count: 2,
          total_tokens: 0,
          model: 'stub',
          workspace: process.cwd(),
          mode: 'agent',
        },
        messages: [],
      },
      null,
      2,
    ),
  );
  log(`wrote session store entry ${id} for workspace ${process.cwd()}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Worker mode: what agent_ask spawns. Must take real wall-clock time so a
//    mid-work interrupt has something to interrupt. ─────────────────────────

async function runWorker() {
  log('worker mode');
  emitInit();
  for (const [i, file] of ['src/one.ts', 'src/two.ts', 'src/three.ts'].entries()) {
    await sleep(2500);
    emitToolStart('read', file);
    log(`worker step ${i + 1}`);
  }
  await sleep(1500);
  emitResult('The narrator module turns watcher events into spoken milestones.');
  log('worker done');
}

// ── Voice mode: connect to the bridge's MCP server the way a real agent does.

function resolveMcpEndpoint() {
  // Claude Code is handed an explicit --mcp-config file by its provider.
  const idx = argv.indexOf('--mcp-config');
  if (idx !== -1 && argv[idx + 1] && existsSync(argv[idx + 1])) {
    const cfg = JSON.parse(readFileSync(argv[idx + 1], 'utf-8'));
    const entry = cfg.mcpServers?.['squeakr'];
    if (entry?.url) return { url: entry.url, token: entry.headers?.Authorization ?? '', from: argv[idx + 1] };
  }
  // Codex reads its own TOML, and takes the token from the env var the
  // provider named in `bearer_token_env_var`.
  const codexCfg = join(homedir(), '.codex', 'config.toml');
  if (dialect === 'codex' && existsSync(codexCfg)) {
    const toml = readFileSync(codexCfg, 'utf-8');
    const block = toml.split('[mcp_servers."squeakr"]')[1] ?? '';
    const url = block.match(/url\s*=\s*"([^"]+)"/)?.[1];
    const envVar = block.match(/bearer_token_env_var\s*=\s*"([^"]+)"/)?.[1];
    const tok = envVar ? process.env[envVar] : undefined;
    if (url && tok) return { url, token: `Bearer ${tok}`, from: `${codexCfg} (token via $${envVar})` };
    if (url) throw new Error(`config.toml points at ${url} but $${envVar} is not set in the spawn env`);
  }

  // Codewhale reads ~/.codewhale/mcp.json (or $CODEWHALE_HOME / the documented
  // $DEEPSEEK_MCP_CONFIG override), under either the canonical `servers` key or
  // its `mcpServers` alias, and takes the token from bearer_token_env_var.
  if (dialect === 'codewhale') {
    const cwCfg =
      process.env.DEEPSEEK_MCP_CONFIG?.trim() ||
      join(process.env.CODEWHALE_HOME?.trim() || join(homedir(), '.codewhale'), 'mcp.json');
    if (existsSync(cwCfg)) {
      const cfg = JSON.parse(readFileSync(cwCfg, 'utf-8'));
      const entry = (cfg.servers ?? cfg.mcpServers ?? {})['squeakr'];
      const envVar = entry?.bearer_token_env_var;
      const tok = envVar ? process.env[envVar] : undefined;
      if (entry?.url && tok) {
        return { url: entry.url, token: `Bearer ${tok}`, from: `${cwCfg} (token via $${envVar})` };
      }
      if (entry?.url) throw new Error(`${cwCfg} points at ${entry.url} but $${envVar} is not set in the spawn env`);
    }
  }

  // Cursor reads its own global config.
  const cursorCfg = join(homedir(), '.cursor', 'mcp.json');
  if (existsSync(cursorCfg)) {
    const cfg = JSON.parse(readFileSync(cursorCfg, 'utf-8'));
    const entry = cfg.mcpServers?.['squeakr'];
    if (entry?.url) return { url: entry.url, token: entry.headers?.Authorization ?? '', from: cursorCfg };
  }
  throw new Error('no squeakr MCP registration found — provider did not write one');
}

async function callTool(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '{}';
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    out = { raw: text };
  }
  // How many pictures rode along (media pipe, docs/46) — not part of the JSON.
  Object.defineProperty(out, 'imageBlocks', { value: (res.content ?? []).filter((c) => c.type === 'image').length });
  return out;
}

async function runVoice() {
  log('voice mode');
  emitInit();

  const { url, token, from } = resolveMcpEndpoint();
  log(`MCP endpoint ${url} (registration read from ${from})`);

  const client = new Client({ name: 'stub-agent', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: token } },
  });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  log(`connected — ${tools.length} tools; agent_ask present: ${tools.includes('agent_ask')}`);

  // The bridge delivered the user's first request inside the boot prompt.
  const quoted = prompt.match(/User just spoke[^"]*"([^"]+)"/);
  log(`boot prompt carried user turn: ${quoted ? JSON.stringify(quoted[1]) : 'none'}`);

  if (process.env.STUB_VOICE_SCRIPT === 'echo') {
    await runEchoVoice(client, quoted ? quoted[1] : '');
    return;
  }

  await callTool(client, 'speak', { text: 'On it — let me look through the repository.' });

  // ── The thing under test ────────────────────────────────────────────────
  // agent_ask blocks for as long as the worker runs. The harness fires a new
  // user turn while we are inside this call. It must come back on THIS result
  // without the research being cancelled.
  log('calling agent_ask (long) — interrupt should land during this');
  const started = Date.now();
  const ask = await callTool(client, 'agent_ask', {
    question: 'What does the narrator module do?',
  });
  const elapsed = Date.now() - started;

  log(`agent_ask returned after ${elapsed}ms`);
  log(`  answer present : ${Boolean(ask.answer)}`);
  log(`  interrupted    : ${ask.interrupted === true}`);
  log(`  user_turn      : ${ask.user_turn ? JSON.stringify(ask.user_turn) : 'none'}`);

  emitToolStart('read', 'src/executor/narrator.ts');

  if (ask.interrupted === true && ask.user_turn) {
    // Exactly what the system prompt tells the agent to do.
    await callTool(client, 'speak', {
      text: `INTERRUPT-OK: research finished and you also asked: ${ask.user_turn}`,
    });
  } else {
    await callTool(client, 'speak', { text: 'INTERRUPT-MISSED: no user turn arrived on the tool result.' });
  }

  await callTool(client, 'done', {});
  emitResult('stub voice turn complete');
  await client.close();
}

/**
 * STUB_VOICE_SCRIPT=echo — repeat every turn back, tagged with how it arrived.
 * Used by scripts/live-pipe-test.mjs to prove streamed audio reaches the agent
 * (source "stream", merged segments) and that its replies reach the pipe.
 */
async function runEchoVoice(client, bootTurn) {
  const maxTurns = Number(process.env.STUB_ECHO_TURNS ?? 6);
  // Media attached to the conversation (docs/46) rides out on any Squeakr
  // result; say so, so the harness can see it arrived.
  const call = async (name, args) => {
    const res = await callTool(client, name, args);
    if (res.attached_media_ids) {
      log(`echo: attached media ${JSON.stringify(res.attached_media_ids)} on ${name}`);
      await callTool(client, 'speak', { text: `ATTACHED ${res.attached_media_ids.length} images=${res.imageBlocks} via ${name}` });
    }
    return res;
  };
  await call('speak', { text: `ECHO boot: ${bootTurn || '(none)'}` });
  await call('done', {});
  for (let i = 0; i < maxTurns; i++) {
    const res = await call('next_voice_turn', { timeout_ms: 15_000 });
    if (!res.turn) {
      log('echo: no more turns');
      break;
    }
    const tag = `${res.source ?? 'voice'}${res.segments > 1 ? ` x${res.segments}` : ''}`;
    log(`echo: turn (${tag}) ${JSON.stringify(res.turn)} hint=${Boolean(res.stream_hint)}`);
    // A turn asking for it holds the reply, leaving a window where the agent
    // is busy and not polling — what a real agent mid-work looks like.
    if (res.turn.includes('STUB_PAUSE')) await sleep(Number(process.env.STUB_PAUSE_MS ?? 3000));
    const media = res.media_ids ? ` [media ${res.media_ids.length} ${res.media_delivery} images=${res.imageBlocks}]` : '';
    // With media the turn text carries a file list; echo only what was typed.
    const said = res.media_ids ? res.turn.split('\n')[0] : res.turn;
    await call('speak', { text: `ECHO ${tag}: ${said}${media}` });
    await call('done', {});
  }
  emitResult('stub echo session complete');
  await client.close();
}

try {
  if (isVoice) await runVoice();
  else await runWorker();
  process.exit(0);
} catch (err) {
  log('ERROR', err?.stack ?? String(err));
  emit({ type: 'error', message: String(err?.message ?? err) });
  process.exit(1);
}
