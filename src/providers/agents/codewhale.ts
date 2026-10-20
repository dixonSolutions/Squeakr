/**
 * Codewhale CLI (`codewhale`, also installed as `codew`) provider.
 *
 * Codewhale is a Rust coding agent with a first-class headless surface:
 *
 *   codewhale exec --auto --output-format stream-json "<prompt>"
 *
 * Auth is *provider-scoped* rather than app-scoped — Codewhale routes to
 * DeepSeek, OpenAI, Anthropic, OpenRouter, Ollama and ~35 others, and each has
 * its own key. `codewhale auth status` reports the active provider plus a table
 * of every known one, which is the only auth question this bridge has to
 * answer: "can the CLI make a model call right now?".
 *
 * Two quirks drove the shape of this file. Both are Codewhale behaviours, not
 * Squeakr ones, and both are covered in docs/24-agent-providers.md:
 *
 *  1. The session id in stream-json is REDACTED. `session_capture.content` and
 *     `metadata.session_id` are both FNV fingerprints (`<redacted:…>`), so the
 *     id `--resume` needs can never be read off the stream. It is recovered
 *     from Codewhale's own session store instead — see resolveSessionId().
 *  2. There is no run-start event. Every other CLI opens with a
 *     `system/init`-shaped line; Codewhale's first line is whatever the model
 *     produced. `turn_usage` carries a 1-based `turn`, so `turn === 1` is the
 *     one stateless run-start marker available — see parseCodewhaleEvent().
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { childLogger } from '../../log.js';
import type { Project, SessionState } from '../../state/registry.js';
import { buildAgentPrompt, buildAskPrompt } from '../../executor/agentPrompt.js';
import { formatPathForLog, resolveUserHome } from '../../mcp/hostPaths.js';
import { createBinResolver } from '../binResolve.js';
import { AGENT_BIN_SPECS } from '../binSpecs.js';
import { runLoginCommand } from './authFlowRunner.js';
import {
  describeAction,
  isOlderVersion,
  readJsonConfig,
  registrationFailure,
  writeJsonConfig,
  type JsonMcpEntry,
  type McpRegistrationAction,
  type McpRegistrationContext,
  type McpRegistrationResult,
} from './mcpRegistration.js';
import {
  logUnhandledEvent,
  normalizeToolCall,
  type AgentStreamEvent,
} from './events.js';
import type {
  AgentMode,
  AgentProvider,
  AuthCheckResult,
  AuthFlowDescriptor,
  AuthFlowId,
  AuthStartResult,
  ModelEntry,
  PermissionModeDescriptor,
  SpawnOptions,
  StoredSessionSummary,
} from './types.js';

const execFileAsync = promisify(execFile);
const log = childLogger('provider:codewhale');

/**
 * Env var Codewhale's `bearer_token_env_var` points at, so APP_TOKEN never has
 * to be written into mcp.json in plaintext. Same trick as the Codex provider —
 * Codewhale's own docs warn that a literal `headers` value "lives in plain text
 * in ~/.codewhale/mcp.json", and users paste that file into issues.
 */
export const CODEWHALE_TOKEN_ENV_VAR = 'SQUEAKR_MCP_TOKEN';

const resolver = createBinResolver(AGENT_BIN_SPECS.codewhale);

/**
 * Codewhale reads provider keys from its own config + OS keyring + env, and
 * routes across many vendors at once. Stripping any vendor key here would break
 * a route the user deliberately configured, so nothing is stripped — we only
 * add the MCP bearer token.
 */
function codewhaleEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    HOME: base.HOME ?? homedir(),
    [CODEWHALE_TOKEN_ENV_VAR]: base.APP_TOKEN ?? process.env.APP_TOKEN,
  };
}

// ── Paths ─────────────────────────────────────────────────────────────────

function codewhaleHome(): string {
  return process.env.CODEWHALE_HOME?.trim() || join(resolveUserHome(), '.codewhale');
}

/**
 * `~/.codewhale/mcp.json`, unless the documented override is set. The legacy
 * `~/.deepseek/mcp.json` is only read when the Codewhale file is absent, so
 * writing the Codewhale path always wins — we never touch the legacy file.
 */
function resolveMcpConfigPath(): string {
  const override = process.env.DEEPSEEK_MCP_CONFIG?.trim();
  if (override) return override;
  return join(codewhaleHome(), 'mcp.json');
}

function sessionsDir(): string {
  return join(codewhaleHome(), 'sessions');
}

// ── Auth ──────────────────────────────────────────────────────────────────

/**
 * Parse `codewhale auth status`:
 *
 *   active provider: deepseek (set via config or CODEWHALE_PROVIDER)
 *
 *   provider       config   keyring    env      status
 *   ----------------------------------------------------------------------
 *   deepseek       set      set        -        config *
 *   openai         -        -          -        unset
 *
 * "Authenticated" means the *active* provider has a key from some layer. A
 * configured-but-keyless active provider is the exact state that makes every
 * spawn fail, so it must read as unauthenticated rather than as "some provider
 * somewhere has a key".
 */
function parseAuthStatus(stdout: string): AuthCheckResult {
  const active = stdout.match(/^active provider:\s*(\S+)/im)?.[1];
  if (!active) {
    return { authenticated: false, email: null, detail: 'Could not read the active Codewhale provider.' };
  }

  const row = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${active} `) || line === active);

  if (!row) {
    return { authenticated: false, email: null, detail: `Codewhale reported no credential row for "${active}".` };
  }

  // Last column is the status; `*` marks the active row.
  const status = row.replace(/\s*\*\s*$/, '').split(/\s{2,}|\s+/).slice(1).pop() ?? '';
  const authenticated = status !== '' && !/^unset$/i.test(status);

  return {
    authenticated,
    email: null,
    detail: authenticated
      ? `Active provider "${active}" (key from ${status}).`
      : `Active provider "${active}" has no API key configured.`,
  };
}

async function checkAuth(): Promise<AuthCheckResult> {
  try {
    const { stdout } = await execFileAsync(resolver.resolve(), ['auth', 'status'], {
      timeout: 15_000,
      env: codewhaleEnv(process.env),
    });
    return parseAuthStatus(stdout);
  } catch (err) {
    return { authenticated: false, email: null, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Active provider id, needed to target `codewhale auth set --provider`. */
async function activeProviderId(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(resolver.resolve(), ['auth', 'status'], {
      timeout: 15_000,
      env: codewhaleEnv(process.env),
    });
    return stdout.match(/^active provider:\s*(\S+)/im)?.[1] ?? null;
  } catch {
    return null;
  }
}

// ── Stream parsing ────────────────────────────────────────────────────────

/**
 * Codewhale's exec stream is a flat `{"type": …}` NDJSON dialect
 * (`ExecStreamEvent` in crates/tui/src/lib.rs):
 *
 *   {"type":"content","content":"…"}
 *   {"type":"tool_use","name":"Bash","id":"…","input":{…},"started_at":"…"}
 *   {"type":"tool_result","id":"…","name":"Bash","status":"ok",…}
 *   {"type":"agent_spawned","id":"…","model":"…","spawn_depth":1}
 *   {"type":"sandbox_denied","tool_name":"Bash","reason":"…","outcome":"…"}
 *   {"type":"turn_usage","turn":1,"input_tokens":…,"output_tokens":…}
 *   {"type":"session_capture","content":"<redacted:…>"}
 *   {"type":"metadata","meta":{"receipt_kind":"terminal","workspace":"/…",…}}
 *   {"type":"done"}
 *   {"type":"error","error":"…"}
 */
function parseCodewhaleEvent(raw: Record<string, unknown>): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  const type = raw['type'];

  switch (type) {
    case 'content': {
      const text = typeof raw['content'] === 'string' ? raw['content'].trim() : '';
      if (text) events.push({ kind: 'assistant_text', text });
      return events;
    }

    case 'tool_use': {
      const name = typeof raw['name'] === 'string' ? raw['name'] : 'tool';
      const input =
        typeof raw['input'] === 'object' && raw['input'] !== null
          ? (raw['input'] as Record<string, unknown>)
          : undefined;
      events.push({ kind: 'tool_start', tool: normalizeToolCall(name, input) });
      return events;
    }

    case 'tool_result': {
      const name = typeof raw['name'] === 'string' ? raw['name'] : 'tool';
      const status = typeof raw['status'] === 'string' ? raw['status'] : '';
      events.push({
        kind: 'tool_done',
        tool: normalizeToolCall(name, undefined),
        // Codewhale reports a free-form status string; only an explicit
        // success spelling counts as success, so an unrecognised value is
        // never silently narrated as "worked".
        success: /^(ok|success|succeeded|completed)$/i.test(status),
      });
      return events;
    }

    case 'agent_spawned': {
      // Subagent spawns feed the ghost-agent budget guard, which keys off
      // `action: 'task'`. The model the child was launched on is the useful
      // label — Codewhale emits it precisely because a child can be billed on
      // a different route than its parent.
      const model = typeof raw['model'] === 'string' ? raw['model'] : undefined;
      events.push({
        kind: 'tool_start',
        tool: { name: 'agent_spawned', action: 'task', ...(model ? { subagent: model } : {}) },
      });
      return events;
    }

    case 'sandbox_denied': {
      const tool = typeof raw['tool_name'] === 'string' ? raw['tool_name'] : 'tool';
      events.push({ kind: 'tool_done', tool: normalizeToolCall(tool, undefined), success: false });
      return events;
    }

    case 'turn_usage': {
      // The only stateless run-start marker Codewhale offers (see file header).
      // It fires after the first model call rather than at spawn, so the
      // "started working" line lands a few seconds late — which is still
      // vastly better than the silence a missing `init` produces.
      if (raw['turn'] === 1) events.push({ kind: 'init' });
      return events;
    }

    case 'metadata': {
      const meta =
        typeof raw['meta'] === 'object' && raw['meta'] !== null
          ? (raw['meta'] as Record<string, unknown>)
          : null;
      if (!meta || meta['receipt_kind'] !== 'terminal') return events;

      // `meta.session_id` is a redacted fingerprint and `meta.resume_command`
      // is the literal string "codewhale exec --resume <redacted-session-id>".
      // `meta.workspace` is NOT redacted, which is what makes recovery from
      // the on-disk store possible.
      const workspace = typeof meta['workspace'] === 'string' ? meta['workspace'] : null;
      const sessionId = workspace ? resolveSessionId(workspace) : null;
      if (sessionId) events.push({ kind: 'session', sessionId });

      const error = typeof meta['error'] === 'string' ? meta['error'] : null;
      if (error) events.push({ kind: 'error', message: error });
      return events;
    }

    case 'session_capture':
      // Deliberately ignored: the payload is `<redacted:…>`, never a usable id.
      return events;

    case 'done':
      // Codewhale streams the final answer as `content`; there is no separate
      // summary field to attach here.
      events.push({ kind: 'result', text: null });
      return events;

    case 'error': {
      const message = typeof raw['error'] === 'string' ? raw['error'] : 'Codewhale reported an error';
      events.push({ kind: 'error', message });
      return events;
    }

    // `workflow_service_released` / `service_released` and any future event
    // are liveness-only; nothing downstream needs them.
    default:
      logUnhandledEvent('codewhale', raw);
      return events;
  }
}

// ── Session store ─────────────────────────────────────────────────────────

interface StoredSession {
  id: string;
  workspace: string;
  updatedAt: number;
}

/**
 * Read `~/.codewhale/sessions/*.json`. Each file is
 * `{ metadata: { id, workspace, updated_at, … }, messages: [...] }`.
 *
 * Only the metadata block is parsed; transcripts can be megabytes and this runs
 * on every terminal receipt.
 */
function readSessions(): StoredSession[] {
  const dir = sessionsDir();
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }

  const sessions: StoredSession[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
        metadata?: { id?: unknown; workspace?: unknown; updated_at?: unknown };
      };
      const meta = parsed.metadata;
      if (typeof meta?.id !== 'string' || typeof meta.workspace !== 'string') continue;
      const stamp =
        typeof meta.updated_at === 'string' ? Date.parse(meta.updated_at) : Number.NaN;
      sessions.push({
        id: meta.id,
        workspace: meta.workspace,
        // A malformed timestamp must not sort as "newest"; fall back to mtime.
        updatedAt: Number.isFinite(stamp) ? stamp : safeMtime(path),
      });
    } catch {
      // A half-written or corrupt session file is skipped, never fatal.
    }
  }
  return sessions;
}

/**
 * Past Codewhale conversations for a project — the existing `readSessions()`
 * store reader, filtered by workspace and shaped for the session directory.
 */
function codewhaleListSessions(project: Project, limit = 30): StoredSessionSummary[] {
  return readSessions()
    .filter((session) => session.workspace === project.path)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((session) => ({
      id: session.id,
      updatedAt: session.updatedAt,
      path: join(sessionsDir(), `${session.id}.json`),
      preview: null,
    }));
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The newest session Codewhale saved for `workspace`.
 *
 * This is the recovery path for the redacted stream id. It is a heuristic: two
 * concurrent runs in the same workspace could race, and the loser would resume
 * the winner's thread. That is bounded by how Squeakr already works — one
 * voice session per project — and the alternative (no resume at all) is worse,
 * because every turn would start a cold thread. executor/resumeGuard.ts still
 * recovers at runtime if the id turns out to be wrong.
 */
function resolveSessionId(workspace: string): string | null {
  const matches = readSessions().filter((session) => session.workspace === workspace);
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.updatedAt - a.updatedAt);
  return matches[0]!.id;
}

/**
 * Codewhale accepts a session id *or a unique prefix*, and `codewhale sessions`
 * displays 8-char prefixes — so a user-supplied resume id may legitimately be
 * shorter than the stored uuid.
 */
function codewhaleSessionStatus(
  _project: Project,
  sessionId: string,
): 'present' | 'absent' | 'unknown' {
  if (!existsSync(sessionsDir())) return 'unknown';
  const sessions = readSessions();
  if (sessions.length === 0) return 'unknown';
  return sessions.some((session) => session.id === sessionId || session.id.startsWith(sessionId))
    ? 'present'
    : 'absent';
}

// ── MCP registration ──────────────────────────────────────────────────────

/**
 * Codewhale's mcp.json root key is `servers`, with `mcpServers` declared as a
 * serde *alias* — one field, two spellings. Writing both would make the file
 * fail to parse as a duplicate field, so the entry goes into whichever key the
 * file already uses, defaulting to the canonical `servers`.
 */
function serverMapKey(file: Record<string, unknown> | null): 'servers' | 'mcpServers' {
  if (file && typeof file['mcpServers'] === 'object' && file['mcpServers'] !== null) {
    return 'mcpServers';
  }
  return 'servers';
}

/**
 * Codewhale honours `bearer_token_env_var` for URL servers and resolves it at
 * request time, so the bridge token stays out of the config file entirely.
 */
function buildCodewhaleMcpEntry(ctx: McpRegistrationContext): JsonMcpEntry {
  return {
    url: ctx.url,
    bearer_token_env_var: CODEWHALE_TOKEN_ENV_VAR,
    enabled: true,
    disabled: false,
    squeakr: { version: ctx.version, enabled: true },
  };
}

async function ensureCodewhaleMcpRegistration(
  ctx: McpRegistrationContext,
): Promise<McpRegistrationResult> {
  const configPath = resolveMcpConfigPath();
  const label = formatPathForLog(configPath);
  ctx.log('check', 'info', `Checking Codewhale MCP config (${label})…`);

  const existing = readJsonConfig(configPath) as Record<string, unknown> | null;
  const key = serverMapKey(existing);
  const servers: Record<string, JsonMcpEntry> = {
    ...((existing?.[key] as Record<string, JsonMcpEntry> | undefined) ?? {}),
  };

  for (const legacy of ctx.legacyServerNames) {
    if (legacy !== ctx.serverName && servers[legacy]) {
      delete servers[legacy];
      ctx.log('update', 'info', `Removed stale "${legacy}" MCP entry from ${label}.`);
    }
  }

  const current = servers[ctx.serverName];
  const entry = buildCodewhaleMcpEntry(ctx);

  let action: McpRegistrationAction;
  if (!current) {
    action = 'installed';
  } else if (isOlderVersion((current.squeakr ?? current.agentVoice)?.version, ctx.version) || current.url !== entry.url) {
    action = 'updated';
  } else if (current.disabled === true || current['enabled'] === false) {
    action = 'enabled';
  } else {
    action = 'unchanged';
  }

  servers[ctx.serverName] = { ...current, ...entry };

  const file: Record<string, unknown> = { ...(existing ?? {}) };
  file[key] = servers;
  // Never leave both spellings behind — Codewhale would refuse to parse it.
  if (key === 'servers') delete file['mcpServers'];
  else delete file['servers'];

  try {
    writeJsonConfig(configPath, file);
  } catch (err) {
    return registrationFailure(ctx, configPath, err);
  }

  ctx.log(
    'done',
    'info',
    `${ctx.serverName} registered in ${label} — the bridge token is read from ` +
      `$${CODEWHALE_TOKEN_ENV_VAR} at request time, not stored in the file.`,
  );
  return { ok: true, configPath, action, message: describeAction(action, 'Codewhale') };
}

// ── Argv ──────────────────────────────────────────────────────────────────

/**
 * Global Codewhale flags must precede the subcommand; `exec` flags follow it.
 * cwd (project path or worktree) is set by executor/agentProcess.ts, so no
 * `-C/--workspace` is passed here — the registry owns that, never the caller.
 */
function baseArgs(session: SessionState, mode: AgentMode): string[] {
  const args = ['exec'];

  // `--auto` is what turns exec into a tool-backed agent. Withholding it is
  // how `ask` is enforced: a plain `codewhale exec` is a one-shot model
  // response with no filesystem or shell access at all.
  if (mode !== 'ask') args.push('--auto');

  args.push('--output-format', 'stream-json');

  if (session.activeModel && session.activeModel !== 'auto') {
    args.push('--model', session.activeModel);
  }

  // Belt and braces for read-only: even if a future exec grows tools without
  // --auto, the sandbox policy still refuses writes.
  if (mode === 'ask') args.push('--sandbox', 'read-only');

  return args;
}

export const codewhaleProvider: AgentProvider = {
  id: 'codewhale',
  displayName: 'Codewhale',

  resolveBin: () => resolver.resolve(),
  isInstalled: () => resolver.isInstalled(),
  binEnvVar: () => resolver.envVar(),
  env: codewhaleEnv,
  checkAuth,

  authFlows(): AuthFlowDescriptor[] {
    return [
      {
        id: 'browser-url',
        label: 'Sign in to Codewhale',
        description:
          'Codewhale opens a browser device flow — tap the link on your phone and approve it.',
      },
      {
        id: 'api-key',
        label: 'Use a provider API key',
        description:
          'Paste the API key for whichever provider Codewhale is routed to (DeepSeek, OpenAI, Anthropic, OpenRouter…). It is stored by Codewhale itself, not in Squeakr.',
        pasteLabel: 'Provider API key',
        pastePlaceholder: 'sk-…',
      },
    ];
  },

  async startLogin(flowId: AuthFlowId, opts): Promise<AuthStartResult> {
    if (flowId === 'api-key') {
      const pasted = opts?.pasted?.trim();
      if (!pasted || pasted.length < 8) {
        throw new Error('Paste a valid provider API key.');
      }

      const provider = await activeProviderId();
      if (!provider) {
        throw new Error(
          'Could not determine the active Codewhale provider. Run "codewhale auth status" on the host.',
        );
      }

      // Hand the key to Codewhale rather than writing it into Squeakr's
      // .env: Codewhale keys are per-provider and live in its own config +
      // keyring, so .env would be both the wrong shape and the wrong scope.
      // --api-key-stdin keeps the value out of argv and shell history.
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          resolver.resolve(),
          ['auth', 'set', '--provider', provider, '--api-key-stdin'],
          { timeout: 20_000, env: codewhaleEnv(process.env) },
          (err) => (err ? reject(err) : resolve()),
        );
        child.stdin?.end(`${pasted}\n`);
      });

      const result = await checkAuth();
      return {
        flow: flowId,
        instructions: `Key saved for Codewhale provider "${provider}".`,
        done: Promise.resolve(result),
        cancel: () => {},
      };
    }

    if (flowId !== 'browser-url') {
      throw new Error(`Codewhale does not support the "${flowId}" login flow.`);
    }

    return runLoginCommand({
      bin: resolver.resolve(),
      args: ['login'],
      env: codewhaleEnv(process.env),
      urlPattern: /https?:\/\/\S+/,
      verify: checkAuth,
      instructions: 'Open the link on your phone and approve the sign-in.',
      flowId,
      totalTimeoutMs: 3 * 60_000,
    });
  },

  isAuthError(exitCode: number, stderr: string): boolean {
    if (exitCode === 0) return false;
    return /no api key|api key not set|unset|not authenticated|unauthorized|invalid.*key|authentication|\b401\b|\b403\b|insufficient balance|\b402\b/i.test(
      stderr,
    );
  },

  /**
   * `codewhale model list` prints `"<model-id> (<provider>)"` per line across
   * every configured provider — an offline, instant read of Codewhale's own
   * catalogue. (`codewhale models` hits the live provider API and needs a
   * working key, so it is only the fallback.)
   *
   * Entries are keyed by bare model id, not `provider/model`: `--model` takes
   * an id and lets Codewhale resolve the route itself, which is the whole point
   * of its provider-neutral routing. The provider name rides along in the
   * display label so the picker still says where a model comes from.
   */
  async listModels(): Promise<ModelEntry[]> {
    const models: ModelEntry[] = [{ id: 'auto', displayName: 'Auto (Codewhale default route)' }];
    const seen = new Set<string>(['auto']);

    for (const args of [['model', 'list'], ['models']]) {
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(resolver.resolve(), args, {
          timeout: 30_000,
          env: codewhaleEnv(process.env),
          maxBuffer: 4 * 1024 * 1024,
        }));
      } catch (err) {
        log.debug({ args, err }, 'codewhale model listing failed');
        continue;
      }

      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\S+)(?:\s+\(([^)]+)\))?$/);
        if (!match) continue;
        const id = match[1]!;
        if (seen.has(id)) continue;
        seen.add(id);
        models.push({ id, displayName: match[2] ? `${id} — ${match[2]}` : id });
      }

      if (models.length > 1) break;
    }

    return models;
  },

  supportsModelSelection: () => true,

  /** `exec --auto` is the only headless agent mode Codewhale has: auto-approve everything. */
  permissionModes: (): readonly PermissionModeDescriptor[] => [
    {
      id: 'auto',
      label: 'Run everything',
      description: '--auto — tool-backed agent mode with auto-approvals; the sandbox policy still applies.',
      prompts: 'never',
      yolo: true,
    },
  ],

  /**
   * `agent` and `ask` only.
   *
   * `codewhale exec` reaches AppMode::Agent (with `--auto`) or a plain one-shot
   * response (without) — there is no plan mode on the headless path. Declaring
   * `plan` would mean `agent_ask`-style callers silently got a *writing* agent
   * under a read-only-sounding name, which is exactly the failure the mode
   * contract exists to prevent.
   */
  supportedModes: (): readonly AgentMode[] => ['agent', 'ask'],
  // Not known to forward MCP image blocks to the model — declared off, so
  // inline sends fall back to paths, which Codewhale opens like any file.
  mediaInput: () => ({ mcpImageResults: false, note: 'Pictures are handed over by path — Codewhale opens them as files.' }),

  parseStreamEvent: parseCodewhaleEvent,
  ensureMcpRegistration: ensureCodewhaleMcpRegistration,
  sessionStatus: codewhaleSessionStatus,
  listSessions: codewhaleListSessions,
  /**
   * `codewhale mcp list` / `codewhale mcp tools`. The tools command has no
   * per-server argument — it lists everything discovered — so the result says
   * so rather than pretending the filter was applied.
   */
  mcpInspectCommands: () => ({
    list: ['mcp', 'list'],
    tools: () => ['mcp', 'tools'],
    toolsListsEverything: true,
  }),

  /** Codewhale branches a conversation with its own `fork` subcommand. */
  forkSessionArgs(_project: Project, sessionId: string, prompt: string): string[] {
    return ['fork', sessionId, '--prompt', prompt];
  },

  buildWorkerArgs(opts: SpawnOptions): string[] {
    const { project, session, prompt, mode = 'agent', oneShot = false, browser } = opts;
    const args = baseArgs(session, mode);

    if (project.resumeId && !oneShot && mode !== 'ask') {
      args.push('--resume', project.resumeId);
    }

    // The prompt is a trailing var-arg with allow_hyphen_values, so it goes
    // last and needs no `--` separator (Codewhale's own documented examples
    // pass it exactly this way).
    args.push(mode === 'ask' ? buildAskPrompt(prompt) : buildAgentPrompt(prompt, { browser }));
    return args;
  },

  buildVoiceArgs(
    project: Project,
    session: SessionState,
    _pendingTurn: string | undefined,
    bootPrompt = '',
  ): string[] {
    const args = baseArgs(session, 'agent');
    if (project.resumeId) args.push('--resume', project.resumeId);
    args.push(bootPrompt);
    return args;
  },
};

log.debug({ bin: resolver.resolve() }, 'codewhale provider ready');
