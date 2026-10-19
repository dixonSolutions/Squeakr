/**
 * Claude Code CLI (`claude`) provider.
 *
 * Claude Code has no device-code flow. Headless-friendly options are:
 *   - `claude setup-token` — opens a browser OAuth round-trip and prints a
 *     long-lived (1-year) token; we scrape it from stdout and store it as
 *     CLAUDE_CODE_OAUTH_TOKEN. If the spawning host has no browser either,
 *     the CLI still prints the auth URL first, so the phone can complete it.
 *   - ANTHROPIC_API_KEY — plain API key, bypasses OAuth (pay-per-token billing,
 *     not the flat Pro/Max subscription — surfaced in the UI copy).
 *   - Pasting an existing CLAUDE_CODE_OAUTH_TOKEN generated elsewhere.
 *
 * See https://code.claude.com/docs/en/authentication
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { childLogger } from '../../log.js';
import { AUTO_MODEL_ID } from '../../state/models.js';
import { activePermissionMode, PERMISSION_PROMPT_TOOL_REF } from './permissions.js';
import { updateAgentEnvKeys } from '../../state/envFile.js';
import type { Project, SessionState } from '../../state/registry.js';
import { buildAgentPrompt, buildAskPrompt } from '../../executor/agentPrompt.js';
import { formatPathForLog, resolveBridgeDataDir, resolveUserHome } from '../../mcp/hostPaths.js';
import { createBinResolver } from '../binResolve.js';
import { AGENT_BIN_SPECS } from '../binSpecs.js';
import { runLoginCommand } from './authFlowRunner.js';
import {
  buildJsonMcpEntry,
  describeAction,
  mergeJsonMcpEntry,
  readJsonConfig,
  registrationFailure,
  writeJsonConfig,
  MCP_SERVER_NAME,
  type McpRegistrationContext,
  type McpRegistrationResult,
} from './mcpRegistration.js';
import {
  extractContentText,
  extractToolUsesWithIds,
  type NormalizedToolCall,
  logUnhandledEvent,
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
const log = childLogger('provider:claude');

/** Generated `--mcp-config` file handed to every `claude` spawn. */
function resolveMcpConfigPath(): string {
  return join(resolveBridgeDataDir(), 'claude-code-mcp.json');
}

/**
 * Tools the voice agent must be allowed to call without an interactive prompt.
 * In `-p` (print) mode Claude Code cannot show a permission dialog, so an
 * un-allowlisted MCP tool is simply denied — which silently removes speak(),
 * done() and next_voice_turn() and makes the whole session mute.
 *
 * `mcp__<server>` allows every tool on that server; listing individual tools
 * would break each time we add one.
 *
 * The list covers every MCP server the user has registered, not just ours.
 * People add servers (gdr, playwright, …) precisely so the agent can use them,
 * and an allowlist denies anything omitted — so hardcoding only `squeakr`
 * silently made the voice agent the *least* capable way to run Claude Code,
 * even though the same servers work fine in an interactive session.
 */
function allowedToolsSpec(): string {
  const servers = new Set<string>([MCP_SERVER_NAME]);
  try {
    const userConfig = readJsonConfig(join(resolveUserHome(), '.claude.json'));
    for (const name of Object.keys(userConfig?.mcpServers ?? {})) {
      if (name.trim()) servers.add(name);
    }
  } catch {
    // Unreadable user config is not fatal — ours is always allowed.
  }
  return [...servers].map((name) => `mcp__${name}`).join(',');
}

/** Modes that must not be able to modify the repo. */
const READ_ONLY_DISALLOWED = 'Write,Edit,MultiEdit,NotebookEdit';

const resolver = createBinResolver(AGENT_BIN_SPECS['claude-code']);

function claudeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, HOME: base.HOME ?? homedir() };
}

async function checkAuth(): Promise<AuthCheckResult> {
  // No official machine-readable "am I logged in" command; CLAUDE_CODE_OAUTH_TOKEN
  // always wins when set, otherwise fall back to the on-disk credential file that
  // `claude login` / `/login` writes.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
    return { authenticated: true, email: null, detail: 'Authenticated via environment credential' };
  }
  const credentialsPath = join(homedir(), '.claude', '.credentials.json');
  return { authenticated: existsSync(credentialsPath), email: null };
}

/**
 * Flags every `claude` spawn needs.
 *
 *  --verbose        stream-json output is rejected without it in print mode.
 *  --mcp-config     registers Squeakr for this process regardless of what
 *                   is (or is not) in the user's global config. Without
 *                   --strict-mcp-config the user's own servers still load.
 *  --allowedTools   print mode cannot prompt, so MCP tools must be pre-approved.
 */
function baseArgs(oneShot: boolean): string[] {
  const args = ['-p', '--output-format', oneShot ? 'json' : 'stream-json'];
  if (!oneShot) args.push('--verbose');
  args.push('--mcp-config', resolveMcpConfigPath(), '--allowedTools', allowedToolsSpec());
  return args;
}

/**
 * End option parsing before the prompt.
 *
 * `--allowedTools` and `--disallowedTools` are variadic: given
 * `--allowedTools mcp__squeakr "the prompt"` the CLI swallows the prompt as
 * a second tool pattern and then dies with "Input must be provided either
 * through stdin or as a prompt argument". Today the prompt survives only
 * because a single-value flag happens to sit last; `--` makes that ordering
 * irrelevant, and also protects a prompt that begins with a dash.
 */
function withPrompt(args: string[], prompt: string): string[] {
  args.push('--', prompt);
  return args;
}

/**
 * `--model` / `--effort` / fast tier for the session's selection.
 *
 * Effort is a first-class flag. Fast mode has no flag: in print mode the CLI
 * reports `fast_mode_disabled_reason: "sdk_opt_in_required"` until the
 * `fastMode` setting is supplied, and `--settings` accepts inline JSON — so
 * that is the opt-in. Both are only sent when the catalog says the model
 * supports them; the picker never offers otherwise, and `resolveSelection`
 * drops anything stale.
 */
function selectionArgs(session: SessionState): string[] {
  const args: string[] = [];
  if (session.activeModel && session.activeModel !== AUTO_MODEL_ID) {
    args.push('--model', session.activeModel);
  }
  if (session.activeEffort) args.push('--effort', session.activeEffort);
  if (session.activeFast) args.push('--settings', JSON.stringify({ fastMode: true }));
  return args;
}

// ── Permission modes ──────────────────────────────────────────────────────

/**
 * `-p` starts in Manual on every plan, so the mode must always be passed.
 * Modes that can still ask get `--permission-prompt-tool`: Claude Code then
 * calls our `approve_permission` MCP tool instead of a terminal prompt, and
 * the bridge relays it to the phone. Our own MCP tools stay pre-approved via
 * --allowedTools in every mode, so the voice loop never trips a prompt.
 */
const CLAUDE_PERMISSION_MODES: readonly (PermissionModeDescriptor & { cliMode: string; relayPrompts: boolean })[] = [
  {
    id: 'bypass',
    label: 'Run everything',
    description: 'bypassPermissions — every tool call is pre-approved; nothing ever asks.',
    prompts: 'never',
    yolo: true,
    cliMode: 'bypassPermissions',
    relayPrompts: false,
  },
  {
    id: 'auto',
    label: 'Auto (classifier)',
    description: 'A safety classifier approves most actions; anything it will not decide is sent to your phone.',
    prompts: 'phone',
    cliMode: 'auto',
    relayPrompts: true,
  },
  {
    id: 'acceptEdits',
    label: 'Edits auto, ask for the rest',
    description: 'File edits and common filesystem commands run freely; other shell commands ask on your phone.',
    prompts: 'phone',
    cliMode: 'acceptEdits',
    relayPrompts: true,
  },
  {
    id: 'manual',
    label: 'Ask for everything',
    description: 'Every non-read-only action is sent to your phone to allow or deny.',
    prompts: 'phone',
    cliMode: 'manual',
    relayPrompts: true,
  },
  {
    id: 'dontAsk',
    label: 'Deny instead of asking',
    description: 'Only allow-listed and read-only actions run; anything that would ask is refused.',
    prompts: 'deny',
    cliMode: 'dontAsk',
    relayPrompts: false,
  },
];

function permissionArgs(): string[] {
  const active = activePermissionMode(claudeProvider);
  const mode = CLAUDE_PERMISSION_MODES.find((m) => m.id === active.id) ?? CLAUDE_PERMISSION_MODES[0]!;
  const args = ['--permission-mode', mode.cliMode];
  if (mode.relayPrompts) args.push('--permission-prompt-tool', PERMISSION_PROMPT_TOOL_REF);
  return args;
}

// ── Live model catalog ────────────────────────────────────────────────────

interface ClaudeCatalogModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsFastMode?: boolean;
  disabled?: boolean;
}

/**
 * Claude Code has no `models` subcommand, but its stream-json control channel
 * answers an `initialize` request with the same catalog the interactive
 * `/model` picker shows — per model: effort support, the accepted effort
 * levels, and whether fast mode applies. That is the only source used here;
 * no API call is made (the process is killed as soon as the response lands).
 */
async function probeClaudeCatalog(): Promise<ClaudeCatalogModel[]> {
  const bin = resolver.resolve();
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    // The user's MCP servers would all boot for nothing — load none.
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({ mcpServers: {} }),
  ];

  return new Promise<ClaudeCatalogModel[]>((resolve, reject) => {
    const child = spawn(bin, args, { env: claudeEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err: Error | null, models?: ClaudeCatalogModel[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(models ?? []);
    };

    const timer = setTimeout(() => finish(new Error('Claude Code did not answer the model probe in time')), 25_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      let nl: number;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (parsed['type'] !== 'control_response') continue;
        const response = parsed['response'] as Record<string, unknown> | undefined;
        if (response?.['subtype'] === 'error') {
          finish(new Error(String(response['error'] ?? 'initialize rejected')));
          return;
        }
        const inner = response?.['response'] as Record<string, unknown> | undefined;
        const models = inner?.['models'];
        finish(null, Array.isArray(models) ? (models as ClaudeCatalogModel[]) : []);
        return;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => finish(err));
    child.on('exit', (code) => {
      if (!settled) {
        const err = new Error(`claude exited (${code}) before answering the model probe: ${stderr.trim().slice(0, 300)}`) as Error & {
          code?: number;
          stderr?: string;
        };
        err.code = code ?? 1;
        err.stderr = stderr;
        finish(err);
      }
    });

    // A CLI that dies on startup — a half-installed binary, a bad path — tears
    // the pipe down before this write lands. An unhandled EPIPE on stdin is an
    // uncaught exception, which would take the whole bridge down with it; the
    // exit handler above already reports the real reason, so absorb it here.
    child.stdin.on('error', (err: Error) => {
      if (!stderr) stderr = err.message;
    });
    child.stdin.write(
      JSON.stringify({ type: 'control_request', request_id: 'squeakr-models', request: { subtype: 'initialize' } }) + '\n',
    );
  });
}

/**
 * Fallback when the control channel is unavailable (older CLI): the option
 * help still comes from the binary — `--model` names the aliases it accepts
 * and `--effort` lists its levels — so nothing is invented here either.
 */
async function parseClaudeHelp(): Promise<ModelEntry[]> {
  const { stdout } = await execFileAsync(resolver.resolve(), ['--help'], {
    timeout: 10_000,
    env: claudeEnv(process.env),
  });
  const text = stdout.replace(/\s+/g, ' ');
  const effortMatch = text.match(/--effort <level>[^(]*\(([^)]+)\)/);
  const efforts = effortMatch
    ? effortMatch[1]!.split(',').map((e) => e.trim()).filter(Boolean)
    : [];
  const modelSection = text.match(/--model <model>(.*?)(?= -[-\w])/)?.[1] ?? '';
  const aliases = [...modelSection.matchAll(/'([a-z][a-z0-9-]*)'/g)]
    .map((m) => m[1]!)
    .filter((a) => !a.startsWith('claude-'));

  const entries: ModelEntry[] = [
    { id: AUTO_MODEL_ID, displayName: 'Default', description: 'Claude Code picks the model', vendor: 'Anthropic', efforts, fast: false },
  ];
  for (const alias of aliases) {
    if (entries.some((e) => e.id === alias)) continue;
    entries.push({
      id: alias,
      displayName: alias.charAt(0).toUpperCase() + alias.slice(1),
      vendor: 'Anthropic',
      efforts,
      fast: false,
    });
  }
  return entries;
}

function catalogToEntries(models: ClaudeCatalogModel[]): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const m of models) {
    if (!m || typeof m.value !== 'string' || m.disabled) continue;
    // "default" is Claude Code's own "let me pick" row — that is exactly the
    // shared auto sentinel (no --model flag), so map it rather than pass
    // "--model default" and hope.
    const id = m.value === 'default' ? AUTO_MODEL_ID : m.value;
    if (entries.some((e) => e.id === id)) continue;
    entries.push({
      id,
      displayName: m.displayName || m.value,
      description: m.description,
      vendor: 'Anthropic',
      efforts: m.supportsEffort && Array.isArray(m.supportedEffortLevels) ? [...m.supportedEffortLevels] : [],
      defaultEffort: null,
      fast: m.supportsFastMode === true,
    });
  }
  return entries;
}

// ── Stream parsing ────────────────────────────────────────────────────────

/**
 * Text of a tool_result block. Claude sends either a bare string or the same
 * content-block array the assistant uses, so both shapes have to be handled or
 * half the results come back empty.
 */
/**
 * tool_use id → the call it described, so the matching tool_result can report
 * which tool it came from. Bounded because a long session would otherwise grow
 * this forever, and a result always follows its call closely.
 */
const MAX_PENDING_TOOL_USES = 64;
const pendingToolUses = new Map<string, NormalizedToolCall>();

function rememberToolUse(id: string, tool: NormalizedToolCall): void {
  pendingToolUses.set(id, tool);
  while (pendingToolUses.size > MAX_PENDING_TOOL_USES) {
    const oldest = pendingToolUses.keys().next().value;
    if (oldest === undefined) break;
    pendingToolUses.delete(oldest);
  }
}

function takeToolUse(id: string): NormalizedToolCall | undefined {
  const tool = pendingToolUses.get(id);
  if (tool) pendingToolUses.delete(id);
  return tool;
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
    } else if (typeof part === 'object' && part !== null) {
      const block = part as { type?: string; text?: unknown };
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  const joined = parts.join('\n').trim();
  return joined || undefined;
}

function parseClaudeEvent(raw: Record<string, unknown>): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];

  if (typeof raw['session_id'] === 'string' && raw['session_id']) {
    events.push({ kind: 'session', sessionId: raw['session_id'] });
  }

  const type = raw['type'];

  if (type === 'system') {
    if (raw['subtype'] === 'init') {
      events.push({ kind: 'init', model: typeof raw['model'] === 'string' ? raw['model'] : undefined });
    }
    return events;
  }

  if (type === 'assistant') {
    for (const call of extractToolUsesWithIds(raw['message'])) {
      if (call.id) rememberToolUse(call.id, call.tool);
      events.push({ kind: 'tool_start', tool: call.tool });
    }
    const text = extractContentText(raw['message']);
    if (text) events.push({ kind: 'assistant_text', text });
    return events;
  }

  if (type === 'user') {
    // tool_result blocks — the matching tool finished.
    const content = (raw['message'] as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part !== 'object' || part === null) continue;
        const block = part as {
          type?: string;
          is_error?: boolean;
          content?: unknown;
          tool_use_id?: unknown;
        };
        if (block.type !== 'tool_result') continue;
        const output = toolResultText(block.content);
        const origin =
          typeof block.tool_use_id === 'string' ? takeToolUse(block.tool_use_id) : undefined;
        events.push({
          kind: 'tool_done',
          tool: origin ?? { name: 'tool_result', action: 'other' },
          success: block.is_error !== true,
          ...(output ? { output } : {}),
        });
      }
    }
    return events;
  }

  if (type === 'result') {
    if (raw['is_error'] === true) {
      events.push({
        kind: 'error',
        message: typeof raw['result'] === 'string' ? raw['result'] : 'Claude Code reported an error',
      });
      return events;
    }
    const text = typeof raw['result'] === 'string' && raw['result'].trim() ? raw['result'].trim() : null;
    events.push({ kind: 'result', text });
    return events;
  }

  if (events.length === 0) logUnhandledEvent('claude-code', raw);
  return events;
}

// ── Session store ─────────────────────────────────────────────────────────

/**
 * Claude Code keeps one JSONL transcript per conversation under
 * `~/.claude/projects/<flattened cwd>/<session-id>.jsonl`.
 *
 * We deliberately do NOT reimplement the cwd-flattening rule (it is internal to
 * the CLI and would silently start dropping valid resumes if it ever changed).
 * Instead we look for the transcript under *any* project dir: present anywhere
 * means the id is genuinely Claude Code's, and absent everywhere means
 * `--resume` is guaranteed to fail — which is the case worth catching, since
 * that failure is fatal and mute.
 */
function claudeSessionStatus(_project: Project, sessionId: string): 'present' | 'absent' | 'unknown' {
  const root = join(resolveUserHome(), '.claude', 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return 'unknown'; // no store yet, or unreadable — let the CLI decide.
  }
  if (dirs.length === 0) return 'unknown';

  for (const dir of dirs) {
    if (existsSync(join(root, dir, `${sessionId}.jsonl`))) return 'present';
  }
  return 'absent';
}

/**
 * Past Claude Code conversations for a project.
 *
 * Transcripts live at `~/.claude/projects/<mangled cwd>/<session id>.jsonl`.
 * The directory name is Claude Code's own encoding of the working directory:
 * it is not documented, so rather than trying to reproduce it we match on the
 * `cwd` recorded inside the transcript's first line, and fall back to the
 * directory-name heuristic when that line is unreadable.
 */
function claudeListSessions(project: Project, limit = 30): StoredSessionSummary[] {
  const root = join(resolveUserHome(), '.claude', 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const out: StoredSessionSummary[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(join(root, dir)).filter((name) => name.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      const path = join(root, dir, file);
      const head = readFirstJsonLine(path);
      const cwd = typeof head?.['cwd'] === 'string' ? (head['cwd'] as string) : null;
      if (cwd !== null && cwd !== project.path) continue;
      if (cwd === null && !dir.includes(project.path.replace(/[\\/.]/g, '-'))) continue;
      out.push({
        id: file.replace(/\.jsonl$/, ''),
        updatedAt: safeMtimeMs(path),
        path,
        preview: firstUserText(head),
      });
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, limit);
}

/** First line of a JSONL transcript, parsed — null when unreadable. */
function readFirstJsonLine(path: string): Record<string, unknown> | null {
  try {
    // Transcripts reach megabytes; only the head is ever needed here.
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const read = readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, read).toString('utf-8');
      const firstLine = text.split('\n')[0];
      if (!firstLine) return null;
      return JSON.parse(firstLine) as Record<string, unknown>;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function firstUserText(head: Record<string, unknown> | null): string | null {
  if (!head) return null;
  const message = head['message'];
  if (message && typeof message === 'object') {
    const content = (message as Record<string, unknown>)['content'];
    if (typeof content === 'string') return content.slice(0, 160);
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

// ── MCP registration ──────────────────────────────────────────────────────

/**
 * Claude Code's user-scope MCP servers live in `~/.claude.json` (what
 * `claude mcp add --scope user` writes) — NOT in `~/.claude/settings.json`,
 * which only has enable/disable switches. Older Squeakr builds wrote the
 * latter, so Claude Code never saw the bridge at all and every voice session
 * was silently mute. We now:
 *
 *   1. write the generated `--mcp-config` file (authoritative for our spawns),
 *   2. best-effort merge into `~/.claude.json` for the user's own sessions,
 *   3. strip the useless `mcpServers` block older builds left in settings.json.
 */
async function ensureClaudeMcpRegistration(
  ctx: McpRegistrationContext,
): Promise<McpRegistrationResult> {
  const mcpConfigPath = resolveMcpConfigPath();
  ctx.log('check', 'info', `Writing Claude Code MCP config (${formatPathForLog(mcpConfigPath)})…`);

  try {
    writeJsonConfig(mcpConfigPath, {
      mcpServers: { [ctx.serverName]: buildJsonMcpEntry(ctx) },
    });
  } catch (err) {
    return registrationFailure(ctx, mcpConfigPath, err);
  }

  const userConfigPath = join(resolveUserHome(), '.claude.json');
  const existing = readJsonConfig(userConfigPath);
  const { file, action, removedLegacy } = mergeJsonMcpEntry(existing, buildJsonMcpEntry(ctx), ctx);
  for (const legacy of removedLegacy) {
    ctx.log('update', 'info', `Removed stale "${legacy}" MCP entry from ${formatPathForLog(userConfigPath)}.`);
  }
  try {
    writeJsonConfig(userConfigPath, file);
    ctx.log('enable', 'info', `${ctx.serverName} registered in ${formatPathForLog(userConfigPath)}.`);
  } catch (err) {
    // Non-fatal: our own spawns already carry --mcp-config.
    const message = err instanceof Error ? err.message : String(err);
    ctx.log('error', 'warn', `Could not update ${formatPathForLog(userConfigPath)}: ${message}`);
  }

  cleanupLegacySettingsMcp(ctx);

  ctx.log('done', 'info', 'Claude Code MCP ready — every spawn is launched with --mcp-config.');
  return { ok: true, configPath: mcpConfigPath, action, message: describeAction(action, 'Claude Code') };
}

/** Remove the `mcpServers` block older builds wrote into `~/.claude/settings.json`. */
function cleanupLegacySettingsMcp(ctx: McpRegistrationContext): void {
  const settingsPath = join(resolveUserHome(), '.claude', 'settings.json');
  const settings = readJsonConfig(settingsPath);
  if (!settings?.mcpServers) return;

  const names = [ctx.serverName, ...ctx.legacyServerNames];
  let changed = false;
  for (const name of names) {
    if (settings.mcpServers[name]) {
      delete settings.mcpServers[name];
      changed = true;
    }
  }
  if (!changed) return;

  try {
    if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
    writeJsonConfig(settingsPath, settings);
    ctx.log(
      'update',
      'info',
      `Removed the no-op mcpServers entry from ${formatPathForLog(settingsPath)} (Claude Code reads ~/.claude.json).`,
    );
  } catch {
    // Cosmetic cleanup only — never fail the prepare over it.
  }
}

export const claudeProvider: AgentProvider = {
  id: 'claude-code',
  displayName: 'Claude Code',

  resolveBin: () => resolver.resolve(),
  isInstalled: () => resolver.isInstalled(),
  binEnvVar: () => resolver.envVar(),
  env: claudeEnv,
  checkAuth,

  authFlows(): AuthFlowDescriptor[] {
    return [
      {
        id: 'browser-url',
        label: 'Generate a setup token',
        description:
          'Claude Code opens a sign-in link — tap it on your phone, then the token is captured automatically.',
      },
      {
        id: 'token-paste',
        label: 'Paste a setup token',
        description: 'Already ran "claude setup-token" elsewhere? Paste the token here.',
        pasteLabel: 'Setup token',
        pastePlaceholder: 'sk-ant-oat...',
      },
      {
        id: 'api-key',
        label: 'Use an API key',
        description: 'Paste an Anthropic API key (bills pay-per-token, not your Pro/Max subscription).',
        pasteLabel: 'Anthropic API key',
        pastePlaceholder: 'sk-ant-api...',
      },
    ];
  },

  async startLogin(flowId: AuthFlowId, opts): Promise<AuthStartResult> {
    if (flowId === 'token-paste' || flowId === 'api-key') {
      const pasted = opts?.pasted?.trim();
      if (!pasted || pasted.length < 8) {
        throw new Error('Paste a valid token or API key.');
      }
      updateAgentEnvKeys(
        flowId === 'api-key' ? { ANTHROPIC_API_KEY: pasted } : { CLAUDE_CODE_OAUTH_TOKEN: pasted },
      );
      const result = await checkAuth();
      return { flow: flowId, instructions: 'Credential saved.', done: Promise.resolve(result), cancel: () => {} };
    }

    if (flowId !== 'browser-url') {
      throw new Error(`Claude Code does not support the "${flowId}" login flow.`);
    }

    const result = await runLoginCommand({
      bin: resolver.resolve(),
      args: ['setup-token'],
      env: claudeEnv(process.env),
      urlPattern: /https?:\/\/\S+/,
      verify: async () => ({ authenticated: false, email: null }), // token capture below decides success
      instructions: 'Open the link on your phone, sign in, and approve access — the token is saved automatically.',
      flowId,
      totalTimeoutMs: 3 * 60_000,
    });

    // setup-token prints the token itself right before exit; scrape it from the
    // same login command instead of relying on generic verify().
    const done = result.done.then(async () => {
      const check = await checkAuth();
      return check;
    });

    return { ...result, done };
  },

  isAuthError(exitCode: number, stderr: string): boolean {
    if (exitCode === 0) return false;
    return /not logged in|invalid api key|authentication_error|please run.*login|401|unauthorized/i.test(stderr);
  },

  async listModels(): Promise<ModelEntry[]> {
    try {
      const catalog = await probeClaudeCatalog();
      const entries = catalogToEntries(catalog);
      if (entries.length > 0) {
        log.info({ count: entries.length }, 'claude model catalog probed');
        return entries;
      }
      log.warn('claude initialize response carried no models — falling back to --help');
    } catch (err) {
      const execErr = err as { code?: number; stderr?: string };
      if (this.isAuthError(execErr.code ?? 1, execErr.stderr ?? '')) throw err;
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'claude model probe failed — falling back to --help');
    }
    return parseClaudeHelp();
  },

  // Claude Code takes `--model <alias>`, so the picker is live for it too.
  supportsModelSelection: () => true,

  permissionModes: () => CLAUDE_PERMISSION_MODES,

  supportedModes: (): readonly AgentMode[] => ['agent', 'plan', 'ask'],
  // Verified live: a Squeakr tool result's image block reaches the model.
  mediaInput: () => ({ mcpImageResults: true, note: 'Pictures go straight into the chat as images.' }),
  parseStreamEvent: parseClaudeEvent,
  ensureMcpRegistration: ensureClaudeMcpRegistration,
  sessionStatus: claudeSessionStatus,
  listSessions: claudeListSessions,
  /** `claude mcp list` / `claude mcp get <name>`. */
  mcpInspectCommands: () => ({
    list: ['mcp', 'list'],
    tools: (server: string) => ['mcp', 'get', server],
  }),

  /**
   * Claude Code branches a conversation with `--fork-session`, which is what
   * makes it safe to write into a thread another live process still owns.
   */
  forkSessionArgs(_project: Project, sessionId: string, prompt: string): string[] {
    return ['--resume', sessionId, '--fork-session', '-p', prompt];
  },

  buildWorkerArgs(opts: SpawnOptions): string[] {
    const { project, session, prompt, mode = 'agent', oneShot = false, browser } = opts;
    const args = baseArgs(oneShot);

    args.push(...selectionArgs(session));
    if (project.resumeId && !oneShot && mode !== 'ask') {
      args.push('--resume', project.resumeId);
    }

    // Print mode has no permission UI: without an explicit mode, any unapproved
    // action (edits, Bash, browser tools, …) is silently denied and the worker
    // hangs or produces nothing. `acceptEdits` only covers file edits — a Bash
    // command, browser automation, or any other tool call still hits the
    // (nonexistent) permission prompt and the session goes mute. Agent/voice
    // mode needs every action pre-approved so it stays fully hands-free;
    // `ask`/`plan` stay read-only instead.
    if (mode === 'ask' || mode === 'plan') {
      args.push('--permission-mode', 'plan', '--disallowedTools', READ_ONLY_DISALLOWED);
    } else {
      args.push(...permissionArgs());
    }

    return withPrompt(args, mode === 'ask' ? buildAskPrompt(prompt) : buildAgentPrompt(prompt, { browser }));
  },

  buildVoiceArgs(project: Project, session: SessionState, _pendingTurn?: string, bootPrompt = ''): string[] {
    const args = baseArgs(false);
    args.push(...selectionArgs(session));
    if (project.resumeId) args.push('--resume', project.resumeId);
    // The voice session has no terminal to answer a permission prompt; the
    // configured mode either pre-approves everything or routes prompts to the
    // phone via --permission-prompt-tool — never to a prompt nobody can see.
    args.push(...permissionArgs());
    return withPrompt(args, bootPrompt);
  },
};

log.debug({ bin: resolver.resolve() }, 'claude provider ready');
