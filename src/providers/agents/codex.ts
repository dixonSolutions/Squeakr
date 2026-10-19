/**
 * OpenAI Codex CLI (`codex`) provider.
 *
 * Auth: `codex login --device-auth` prints a URL + short one-time code that
 * can be completed from ANY browser (true RFC 8628-style device flow — no
 * localhost callback), which is exactly what a phone-only user needs. Device
 * code auth must be enabled on the account/workspace; if it is not, the CLI
 * reports that clearly and we surface it as the login instructions.
 * Fallback: OPENAI_API_KEY env var.
 *
 * See https://developers.openai.com/codex/auth
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { childLogger } from '../../log.js';
import { AUTO_MODEL_ID } from '../../state/models.js';
import { activePermissionMode } from './permissions.js';
import { updateAgentEnvKeys } from '../../state/envFile.js';
import type { Project, SessionState } from '../../state/registry.js';
import { buildAgentPrompt, buildAskPrompt } from '../../executor/agentPrompt.js';
import { formatPathForLog, resolveUserHome } from '../../mcp/hostPaths.js';
import { createBinResolver } from '../binResolve.js';
import { AGENT_BIN_SPECS } from '../binSpecs.js';
import { runLoginCommand } from './authFlowRunner.js';
import {
  describeAction,
  isOlderVersion,
  registrationFailure,
  type McpRegistrationAction,
  type McpRegistrationContext,
  type McpRegistrationResult,
} from './mcpRegistration.js';
import {
  logUnhandledEvent,
  normalizeToolCall,
  pickString,
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
const log = childLogger('provider:codex');

const resolver = createBinResolver(AGENT_BIN_SPECS.codex);

function codexEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Codex reads OPENAI_API_KEY itself for API-key auth — never strip it here.
  // SQUEAKR_MCP_TOKEN is what config.toml's bearer_token_env_var points at,
  // so the bridge token never has to be written into a config file.
  return {
    ...base,
    HOME: base.HOME ?? homedir(),
    [CODEX_TOKEN_ENV_VAR]: base.APP_TOKEN ?? process.env.APP_TOKEN,
  };
}

async function checkAuth(): Promise<AuthCheckResult> {
  try {
    const { stdout } = await execFileAsync(resolver.resolve(), ['login', 'status'], {
      timeout: 10_000,
      env: codexEnv(process.env),
    });
    const authenticated = /authenticated:\s*yes/i.test(stdout);
    const emailMatch = stdout.match(/account:\s*(\S+@\S+)/i);
    return { authenticated, email: emailMatch?.[1] ?? null };
  } catch (err) {
    return { authenticated: false, email: null, detail: err instanceof Error ? err.message : String(err) };
  }
}

// ── Permission modes ──────────────────────────────────────────────────────

/**
 * `codex exec` is non-interactive: an approval request nobody can answer is
 * denied. There is no headless hook to relay it, so the choice is between
 * bypassing approvals, letting Codex's own reviewer decide, or accepting the
 * denials. `ask` jobs always run `--sandbox read-only` with no bypass.
 */
const CODEX_PERMISSION_MODES: readonly (PermissionModeDescriptor & { args: string[] })[] = [
  {
    id: 'full',
    label: 'Run everything',
    description: 'No approvals, no sandbox — commands run directly on the host.',
    prompts: 'never',
    yolo: true,
    args: ['--dangerously-bypass-approvals-and-sandbox'],
  },
  {
    id: 'approve-for-me',
    label: 'Auto-review',
    description: 'Codex reviews each approval request itself inside the workspace-write sandbox.',
    prompts: 'never',
    args: ['--approve-for-me', '--sandbox', 'workspace-write'],
  },
  {
    id: 'workspace',
    label: 'Workspace sandbox',
    description: 'Writes stay inside the project; anything that would need approval is refused (no prompt is possible headlessly).',
    prompts: 'deny',
    args: ['--sandbox', 'workspace-write'],
  },
];

function permissionArgs(): string[] {
  const active = activePermissionMode(codexProvider);
  return (CODEX_PERMISSION_MODES.find((m) => m.id === active.id) ?? CODEX_PERMISSION_MODES[0]!).args;
}

// ── Model selection ───────────────────────────────────────────────────────

/**
 * `-m` picks the model; effort and speed have no flags of their own but every
 * config key can be overridden per run with `-c key=value` (value parsed as
 * TOML, hence the quotes). `service_tier = "priority"` is what the CLI's own
 * `/fast` toggle writes.
 */
function selectionArgs(session: SessionState): string[] {
  const args: string[] = [];
  if (session.activeModel && session.activeModel !== AUTO_MODEL_ID) {
    args.push('-m', session.activeModel);
  }
  if (session.activeEffort) args.push('-c', `model_reasoning_effort="${session.activeEffort}"`);
  if (session.activeFast) args.push('-c', 'service_tier="priority"');
  return args;
}

interface CodexCatalogModel {
  slug: string;
  display_name?: string;
  description?: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
  visibility?: string;
  supported_in_api?: boolean;
  priority?: number;
  additional_speed_tiers?: string[];
  service_tiers?: Array<{ id: string; name?: string }>;
  context_window?: number;
}

interface CodexCatalog {
  models: CodexCatalogModel[];
}

function parseCodexCatalog(raw: string): CodexCatalog {
  // Some CLI builds print a log line before the JSON — start at the first brace.
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('codex debug models printed no JSON');
  const parsed = JSON.parse(raw.slice(start)) as { models?: unknown };
  return { models: Array.isArray(parsed.models) ? (parsed.models as CodexCatalogModel[]) : [] };
}

/** `model = "…"` at the top of ~/.codex/config.toml, if the user set one. */
function readCodexConfigModel(): string | null {
  try {
    const text = readFileSync(join(resolveUserHome(), '.codex', 'config.toml'), 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) break; // past the top-level table
      const match = trimmed.match(/^model\s*=\s*"([^"]+)"/);
      if (match) return match[1]!;
    }
  } catch {
    // no config, no default model
  }
  return null;
}

function codexCatalogToEntries(catalog: CodexCatalog): ModelEntry[] {
  const listed = catalog.models
    .filter((m) => typeof m.slug === 'string' && m.slug)
    .filter((m) => (m.visibility ?? 'list') === 'list' && m.supported_in_api !== false)
    .sort((a, b) => (a.priority ?? 1_000) - (b.priority ?? 1_000));

  const toEntry = (m: CodexCatalogModel): ModelEntry => ({
    id: m.slug,
    displayName: m.display_name || m.slug,
    description: [m.description, m.context_window ? `${Math.round(m.context_window / 1000)}k context` : null]
      .filter(Boolean)
      .join(' · ') || undefined,
    vendor: 'OpenAI',
    efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter(Boolean),
    defaultEffort: m.default_reasoning_level ?? null,
    fast:
      (m.service_tiers ?? []).some((t) => t.id === 'priority') ||
      (m.additional_speed_tiers ?? []).includes('fast'),
  });

  // "auto" defers to config.toml. When that names a catalog model, the auto
  // row inherits its knobs so effort/fast still work without picking a model.
  const configModel = readCodexConfigModel();
  const configEntry = configModel ? listed.find((m) => m.slug === configModel) : undefined;
  const auto: ModelEntry = configEntry
    ? {
        ...toEntry(configEntry),
        id: AUTO_MODEL_ID,
        displayName: `Auto (${configEntry.display_name || configEntry.slug})`,
        description: `Config default from ~/.codex/config.toml`,
      }
    : {
        id: AUTO_MODEL_ID,
        displayName: 'Auto (from ~/.codex/config.toml)',
        description: configModel ? `Config names "${configModel}", which the catalog does not list` : 'Codex picks its configured default',
        vendor: 'OpenAI',
        efforts: [],
        fast: false,
      };

  return [auto, ...listed.map(toEntry)];
}

// ── Stream parsing ────────────────────────────────────────────────────────

/**
 * Codex has shipped two `--json` shapes. Both are handled:
 *
 *   legacy   { id, msg: { type: "exec_command_begin", command: [...] } }
 *   current  { type: "item.started", item: { item_type: "command_execution" } }
 *
 * Critically, the session id is NEVER at the top level in either shape — the
 * old code only looked at `raw.session_id`, so Codex resume never worked.
 */
function parseCodexEvent(raw: Record<string, unknown>): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];

  const msg =
    typeof raw['msg'] === 'object' && raw['msg'] !== null
      ? (raw['msg'] as Record<string, unknown>)
      : null;
  const item =
    typeof raw['item'] === 'object' && raw['item'] !== null
      ? (raw['item'] as Record<string, unknown>)
      : null;

  const sessionId =
    pickId(msg, ['session_id', 'thread_id', 'conversation_id']) ??
    pickId(raw, ['session_id', 'thread_id', 'conversation_id']);
  if (sessionId) events.push({ kind: 'session', sessionId });

  const type = String(msg?.['type'] ?? raw['type'] ?? '');

  switch (type) {
    case 'session_configured':
    case 'thread.started':
      events.push({
        kind: 'init',
        model: typeof msg?.['model'] === 'string' ? (msg['model'] as string) : undefined,
      });
      return events;

    case 'agent_message':
    case 'agent_message_delta': {
      const text = typeof msg?.['message'] === 'string' ? msg['message'].trim() : '';
      if (text) events.push({ kind: 'assistant_text', text });
      return events;
    }

    case 'exec_command_begin':
      events.push({ kind: 'tool_start', tool: normalizeToolCall('exec_command', msg ?? undefined) });
      return events;

    case 'exec_command_end': {
      // Codex spells the captured output differently across versions; take the
      // first that is actually there rather than guessing one.
      const output = pickString(msg ?? undefined, [
        'aggregated_output',
        'formatted_output',
        'stdout',
        'output',
      ])?.trim();
      events.push({
        kind: 'tool_done',
        tool: normalizeToolCall('exec_command', msg ?? undefined),
        success: msg?.['exit_code'] === 0,
        ...(output ? { output } : {}),
      });
      return events;
    }

    case 'patch_apply_begin': {
      const changes = msg?.['changes'];
      const paths = typeof changes === 'object' && changes !== null ? Object.keys(changes) : [];
      for (const path of paths.length > 0 ? paths : [undefined]) {
        events.push({ kind: 'tool_start', tool: normalizeToolCall('apply_patch', path ? { path } : undefined) });
      }
      return events;
    }

    case 'mcp_tool_call_begin':
    case 'mcp_tool_call_end': {
      const invocation = msg?.['invocation'] as Record<string, unknown> | undefined;
      const name = typeof invocation?.['tool'] === 'string' ? invocation['tool'] : 'mcp_tool';
      events.push(
        type.endsWith('begin')
          ? { kind: 'tool_start', tool: normalizeToolCall(name, invocation) }
          : { kind: 'tool_done', tool: normalizeToolCall(name, invocation) },
      );
      return events;
    }

    case 'item.started':
    case 'item.completed': {
      const itemType = String(item?.['item_type'] ?? item?.['type'] ?? '');
      if (!itemType) return events;
      if (itemType === 'agent_message') {
        const text = typeof item?.['text'] === 'string' ? item['text'].trim() : '';
        if (text) events.push({ kind: 'assistant_text', text });
        return events;
      }
      events.push(
        type === 'item.started'
          ? { kind: 'tool_start', tool: normalizeToolCall(itemType, item ?? undefined) }
          : { kind: 'tool_done', tool: normalizeToolCall(itemType, item ?? undefined) },
      );
      return events;
    }

    case 'task_complete':
    case 'turn.completed': {
      const text =
        (typeof msg?.['last_agent_message'] === 'string' ? msg['last_agent_message'] : null) ?? null;
      events.push({ kind: 'result', text: text && text.trim() ? text.trim() : null });
      return events;
    }

    case 'error':
    case 'turn.failed': {
      const message =
        (typeof msg?.['message'] === 'string' ? msg['message'] : null) ??
        (typeof raw['message'] === 'string' ? raw['message'] : null) ??
        'Codex reported an error';
      events.push({ kind: 'error', message });
      return events;
    }

    default:
      if (events.length === 0) logUnhandledEvent('codex', raw);
      return events;
  }
}

function pickId(
  source: Record<string, unknown> | null,
  keys: readonly string[],
): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

// ── MCP registration (~/.codex/config.toml) ───────────────────────────────

function resolveCodexConfigPath(): string {
  return join(resolveUserHome(), '.codex', 'config.toml');
}

/**
 * Env var name Codex reads the bearer token from. Passing the token by env var
 * rather than writing it into config.toml keeps the secret out of a file that
 * users routinely paste into issues.
 */
export const CODEX_TOKEN_ENV_VAR = 'SQUEAKR_MCP_TOKEN';

/**
 * Remove `[mcp_servers.<name>]` and any of its sub-tables from a TOML document.
 * Table-header based, so it stops at the next top-level `[` and cannot eat
 * unrelated config the way the previous greedy regex could.
 */
function stripTomlServer(toml: string, name: string): string {
  const lines = toml.split('\n');
  const kept: string[] = [];
  let skipping = false;
  const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\.["']?${escapeRegex(name)}["']?(\\.[^\\]]+)?\\s*\\]`);
  for (const line of lines) {
    if (/^\s*\[/.test(line)) skipping = header.test(line);
    if (!skipping) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const RMCP_FLAG = 'experimental_use_rmcp_client';

/** The `[mcp_servers."squeakr"]` table, appended at the end of the document. */
function buildCodexTomlEntry(ctx: McpRegistrationContext): string {
  return [
    '',
    `# Squeakr MCP registration — version ${ctx.version} (managed by Squeakr, safe to delete)`,
    `[mcp_servers."${ctx.serverName}"]`,
    `url = "${ctx.url}"`,
    `bearer_token_env_var = "${CODEX_TOKEN_ENV_VAR}"`,
    'enabled = true',
    '',
  ].join('\n');
}

/**
 * Ensure `experimental_use_rmcp_client = true` sits at document top level.
 *
 * That flag is what enables streamable-HTTP MCP servers — without it Codex only
 * speaks stdio and ignores a `url` entry entirely. In TOML a bare key belongs to
 * the most recent table header, so appending it at the end of the file would
 * silently make it a key of whatever table came last, not a global setting.
 */
function ensureRmcpFlag(toml: string): string {
  if (new RegExp(`^\\s*${RMCP_FLAG}\\s*=`, 'm').test(toml)) {
    const firstTable = toml.search(/^\s*\[/m);
    const flagIndex = toml.search(new RegExp(`^\\s*${RMCP_FLAG}\\s*=`, 'm'));
    // Already present *and* above every table header — nothing to do.
    if (firstTable === -1 || flagIndex < firstTable) return toml;
    toml = toml.replace(new RegExp(`^\\s*${RMCP_FLAG}\\s*=.*$`, 'gm'), '').replace(/\n{3,}/g, '\n\n');
  }
  return `${RMCP_FLAG} = true\n${toml.startsWith('\n') ? '' : '\n'}${toml.trimStart()}`;
}

async function ensureCodexMcpRegistration(
  ctx: McpRegistrationContext,
): Promise<McpRegistrationResult> {
  const configPath = resolveCodexConfigPath();
  const label = formatPathForLog(configPath);
  ctx.log('check', 'info', `Checking Codex MCP config (${label})…`);

  let content = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  const versionMatch = content.match(/# Squeakr MCP registration — version ([\d.]+)/);
  const installedVersion = versionMatch?.[1] ?? null;
  const registered = content.includes(`[mcp_servers."${ctx.serverName}"]`);

  let action: McpRegistrationAction = 'unchanged';
  if (!registered) action = 'installed';
  else if (isOlderVersion(installedVersion, ctx.version)) action = 'updated';

  for (const legacy of ctx.legacyServerNames) {
    if (content.includes(`mcp_servers.${legacy}`) || content.includes(`mcp_servers."${legacy}"`)) {
      content = stripTomlServer(content, legacy);
      ctx.log('update', 'info', `Removed stale "${legacy}" MCP entry from ${label}.`);
      if (action === 'unchanged') action = 'updated';
    }
  }

  if (action !== 'unchanged') {
    content = stripTomlServer(content, ctx.serverName)
      .replace(/^# Squeakr MCP registration.*$/gm, '')
      .trimEnd();
    try {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, ensureRmcpFlag(`${content}${buildCodexTomlEntry(ctx)}`), 'utf-8');
      ctx.log('done', 'info', `Codex MCP config ${action} at ${label}.`);
    } catch (err) {
      return registrationFailure(ctx, configPath, err);
    }
  } else {
    ctx.log('check', 'info', `${ctx.serverName} already registered in ${label} (version ${installedVersion}).`);
  }

  return { ok: true, configPath, action, message: describeAction(action, 'Codex') };
}

/**
 * Codex writes one rollout transcript per session under
 * `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<session id>.jsonl`,
 * so the id shows up in a filename somewhere in that date tree. The tree is
 * shallow and small, and the walk is depth-capped.
 */
function hasRolloutFile(dir: string, sessionId: string, depth: number): boolean {
  if (depth < 0) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (hasRolloutFile(join(dir, entry.name), sessionId, depth - 1)) return true;
    } else if (entry.name.includes(sessionId)) {
      return true;
    }
  }
  return false;
}

/** See AgentProvider.sessionStatus — 'unknown' means "try the resume anyway". */
function codexSessionStatus(_project: Project, sessionId: string): 'present' | 'absent' | 'unknown' {
  const root = join(resolveUserHome(), '.codex', 'sessions');
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return 'unknown';
  }
  if (entries.length === 0) return 'unknown';
  return hasRolloutFile(root, sessionId, 4) ? 'present' : 'absent';
}

/**
 * Past Codex conversations for a project.
 *
 * Rollouts live at `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<stamp>-<id>.jsonl`.
 * The path carries no workspace, so the cwd recorded in the rollout's first
 * line is what ties a session to a project; a rollout whose head cannot be
 * read is skipped rather than guessed at.
 */
function codexListSessions(project: Project, limit = 30): StoredSessionSummary[] {
  const root = join(resolveUserHome(), '.codex', 'sessions');
  const files: string[] = [];
  collectRollouts(root, 4, files);

  const out: StoredSessionSummary[] = [];
  for (const path of files) {
    const head = readFirstJsonLine(path);
    const cwd = firstString(head, ['cwd', 'workspace', 'workdir']);
    if (cwd !== project.path) continue;
    const id = rolloutId(path);
    if (!id) continue;
    out.push({ id, updatedAt: safeMtimeMs(path), path, preview: null });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, limit);
}

function collectRollouts(dir: string, depth: number, into: string[]): void {
  if (depth < 0 || into.length > 500) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectRollouts(full, depth - 1, into);
    else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) into.push(full);
  }
}

/** `rollout-2026-09-15T10-11-12-<uuid>.jsonl` → the uuid. */
function rolloutId(path: string): string | null {
  const name = path.split('/').pop() ?? '';
  const match = /rollout-.*?-([0-9a-fA-F-]{36})\.jsonl$/.exec(name);
  return match?.[1] ?? null;
}

function readFirstJsonLine(path: string): Record<string, unknown> | null {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const read = readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.subarray(0, read).toString('utf-8').split('\n')[0];
      if (!firstLine) return null;
      return JSON.parse(firstLine) as Record<string, unknown>;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function firstString(obj: Record<string, unknown> | null, keys: string[]): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') return value;
  }
  const payload = obj['payload'];
  if (payload && typeof payload === 'object') {
    return firstString(payload as Record<string, unknown>, keys);
  }
  return null;
}

function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export const codexProvider: AgentProvider = {
  id: 'codex',
  displayName: 'Codex',

  resolveBin: () => resolver.resolve(),
  isInstalled: () => resolver.isInstalled(),
  binEnvVar: () => resolver.envVar(),
  env: codexEnv,
  checkAuth,

  authFlows(): AuthFlowDescriptor[] {
    return [
      {
        id: 'device-code',
        label: 'Sign in with a device code',
        description: 'Open the link on any device, enter the one-time code, and Codex links this machine.',
      },
      {
        id: 'api-key',
        label: 'Use an API key',
        description: 'Paste an OpenAI API key instead of signing in with ChatGPT.',
        pasteLabel: 'OpenAI API key',
        pastePlaceholder: 'sk-...',
      },
    ];
  },

  async startLogin(flowId: AuthFlowId, opts): Promise<AuthStartResult> {
    if (flowId === 'api-key') {
      const key = opts?.pasted?.trim();
      if (!key || key.length < 8) {
        throw new Error('Paste a valid OpenAI API key.');
      }
      updateAgentEnvKeys({ OPENAI_API_KEY: key });
      const result = await checkAuth();
      return { flow: flowId, instructions: 'API key saved.', done: Promise.resolve(result), cancel: () => {} };
    }

    if (flowId !== 'device-code') {
      throw new Error(`Codex does not support the "${flowId}" login flow.`);
    }

    return runLoginCommand({
      bin: resolver.resolve(),
      args: ['login', '--device-auth'],
      env: codexEnv(process.env),
      urlPattern: /https?:\/\/\S+/,
      codePattern: /\b([A-Z0-9]{4}-[A-Z0-9]{4}(?:-[A-Z0-9]{4})?)\b/,
      verify: checkAuth,
      instructions:
        'Open the link on any device signed in to ChatGPT, then enter the one-time code to link this machine. ' +
        'If it fails immediately, device-code login may be disabled in your ChatGPT security settings.',
      flowId,
    });
  },

  isAuthError(exitCode: number, stderr: string): boolean {
    if (exitCode === 0) return false;
    return /not logged in|not authenticated|please run.*login|401|unauthorized|sign in/i.test(stderr);
  },

  /**
   * `codex debug models` renders the CLI's model catalog as JSON — the same
   * data its `/model` picker uses, refreshed from the backend when signed in.
   * Each row carries `supported_reasoning_levels`, `default_reasoning_level`
   * and the speed tiers, so effort and fast availability are per model, from
   * the CLI. `--bundled` (the catalog shipped inside the binary) is the
   * fallback when the refresh cannot run (offline, not signed in).
   */
  async listModels(): Promise<ModelEntry[]> {
    let catalog: CodexCatalog | null = null;
    let lastErr: unknown = null;
    for (const args of [['debug', 'models'], ['debug', 'models', '--bundled']]) {
      try {
        const { stdout } = await execFileAsync(resolver.resolve(), args, {
          timeout: 25_000,
          env: codexEnv(process.env),
          maxBuffer: 16 * 1024 * 1024,
        });
        catalog = parseCodexCatalog(stdout);
        if (catalog.models.length > 0) break;
      } catch (err) {
        lastErr = err;
        log.debug({ args, err }, 'codex model catalog read failed');
      }
    }
    if (!catalog || catalog.models.length === 0) {
      if (lastErr) throw lastErr;
      throw new Error('codex debug models returned no models — update the Codex CLI.');
    }
    return codexCatalogToEntries(catalog);
  },

  // `codex exec -m <model>` overrides the config default per run.
  supportsModelSelection: () => true,

  permissionModes: () => CODEX_PERMISSION_MODES,

  // Codex has no plan mode; `ask` is enforced with a read-only sandbox.
  supportedModes: (): readonly AgentMode[] => ['agent', 'ask'],
  // Codex turns MCP image content into input images for the model.
  mediaInput: () => ({ mcpImageResults: true, note: 'Pictures go straight into the chat as images.' }),
  parseStreamEvent: parseCodexEvent,
  ensureMcpRegistration: ensureCodexMcpRegistration,
  sessionStatus: codexSessionStatus,
  listSessions: codexListSessions,
  /**
   * `codex mcp list`. Codex has no documented per-server tool listing, so that
   * half is declared unsupported rather than guessed at; if `mcp list` is not
   * in the installed build either, the probe reports that honestly.
   */
  mcpInspectCommands: () => ({ list: ['mcp', 'list'], tools: null }),
  /**
   * Codex has no fork flag: `codex exec resume` continues the thread in place.
   * Declared unsupported rather than faked, so the session directory shows the
   * honest delivery method (docs/37 §3) instead of promising a branch it
   * cannot make.
   */
  forkSessionArgs: () => null,

  buildWorkerArgs(opts: SpawnOptions): string[] {
    const { project, session, prompt, mode = 'agent', oneShot = false, worktree, browser } = opts;
    const args: string[] = ['exec'];

    if (project.resumeId && !oneShot && mode !== 'ask' && !worktree) {
      args.push('resume', project.resumeId);
    }
    args.push('--json');
    if (mode === 'ask') args.push('--sandbox', 'read-only');
    else args.push(...permissionArgs());
    // Worktree runs must not touch the main checkout.
    args.push('--cd', worktree ?? project.path);
    args.push(...selectionArgs(session));
    args.push(mode === 'ask' ? buildAskPrompt(prompt) : buildAgentPrompt(prompt, { browser }));
    return args;
  },

  buildVoiceArgs(project: Project, session: SessionState, _pendingTurn?: string, bootPrompt = ''): string[] {
    const args: string[] = ['exec'];
    if (project.resumeId) args.push('resume', project.resumeId);
    args.push('--json', ...permissionArgs(), '--cd', project.path);
    args.push(...selectionArgs(session));
    args.push(bootPrompt);
    return args;
  },
};

log.debug({ bin: resolver.resolve() }, 'codex provider ready');
