/**
 * Cursor CLI (`cursor-agent`) provider.
 *
 * Auth: `NO_OPEN_BROWSER=1 cursor-agent login` prints a plain login URL instead
 * of trying to open a local browser (there is none on a headless bridge host);
 * the phone opens that URL and the CLI process exits once the account links.
 * Fallback: CURSOR_API_KEY env var (no browser round-trip at all).
 *
 * See https://cursor.com/docs/cli/reference/authentication
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import stripAnsi from 'strip-ansi';
import { getConfig } from '../../config.js';
import { childLogger } from '../../log.js';
import { AUTO_MODEL_ID, getCachedModelsAnyAge, resolveVariantId, sortEfforts } from '../../state/models.js';
import { activePermissionMode } from './permissions.js';
import { updateAgentEnvKeys } from '../../state/envFile.js';
import { sessionSelection, type Project, type SessionState } from '../../state/registry.js';
import { buildAgentPrompt, buildAskPrompt } from '../../executor/agentPrompt.js';
import { formatPathForLog, resolveUserHome } from '../../mcp/hostPaths.js';
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
  type McpRegistrationContext,
  type McpRegistrationResult,
} from './mcpRegistration.js';
import {
  extractContentText,
  logUnhandledEvent,
  normalizeToolCall,
  type AgentStreamEvent,
  type NormalizedToolCall,
} from './events.js';
import type {
  AgentAbout,
  AgentMode,
  AgentProvider,
  AuthCheckResult,
  AuthFlowDescriptor,
  AuthFlowId,
  AuthStartResult,
  ModelEntry,
  ModelVariant,
  PermissionModeDescriptor,
  SpawnOptions,
  StoredSessionSummary,
} from './types.js';

const execFileAsync = promisify(execFile);
const log = childLogger('provider:cursor');

const resolver = createBinResolver(AGENT_BIN_SPECS.cursor);

interface RawCursorModel {
  id: string;
  displayName: string;
}

function parseModelsOutput(raw: string): RawCursorModel[] {
  return stripAnsi(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes(' - ') && !l.startsWith('Tip:') && !l.startsWith('Available models') && l.length > 0)
    .map((l) => {
      const dashIdx = l.indexOf(' - ');
      return { id: l.slice(0, dashIdx).trim(), displayName: l.slice(dashIdx + 3).trim() };
    })
    .filter((m) => m.id.length > 0);
}

/**
 * Effort suffixes Cursor uses in model ids, longest first so `-xhigh` is not
 * read as `-high`. `extra-high` is Cursor's older spelling of `xhigh`; `none`
 * is a real tier (reasoning off). The set is only a tokenizer for the *live*
 * list — a model is offered at a level only when `cursor-agent models`
 * printed that id.
 */
const CURSOR_EFFORT_SUFFIXES: Array<[suffix: string, effort: string]> = [
  ['extra-high', 'xhigh'],
  ['minimal', 'minimal'],
  ['medium', 'medium'],
  ['xhigh', 'xhigh'],
  ['ultra', 'ultra'],
  ['high', 'high'],
  ['none', 'none'],
  ['low', 'low'],
  ['max', 'max'],
];
const CURSOR_LABEL_TOKENS = /\b(Extra High|Extra high|Minimal|Medium|Ultra|High|None|Low|Max|Fast)\b/g;

/**
 * `<family>[-<effort>][-fast]`, with one wrinkle: older Anthropic rows put
 * `-thinking` *after* the effort (`claude-4.6-opus-high-thinking`) while newer
 * ones put it before (`claude-opus-5-thinking-high`). Peel a trailing
 * `-thinking` off first and re-attach it to the family so both spellings land
 * in one "… Thinking" family.
 */
function splitCursorId(id: string): { family: string; effort: string | null; fast: boolean } {
  let rest = id;
  let fast = false;
  if (rest.endsWith('-fast')) {
    fast = true;
    rest = rest.slice(0, -'-fast'.length);
  }
  let thinkingTail = false;
  if (rest.endsWith('-thinking')) {
    thinkingTail = true;
    rest = rest.slice(0, -'-thinking'.length);
  }
  let effort: string | null = null;
  for (const [suffix, level] of CURSOR_EFFORT_SUFFIXES) {
    if (rest.endsWith(`-${suffix}`)) {
      effort = level;
      rest = rest.slice(0, -(suffix.length + 1));
      break;
    }
  }
  return { family: thinkingTail ? `${rest}-thinking` : rest, effort, fast };
}

function cursorVendor(family: string): string {
  if (family.startsWith('claude')) return 'Anthropic';
  if (/^(gpt|o\d|codex)/.test(family)) return 'OpenAI';
  if (family.startsWith('gemini')) return 'Google';
  if (family.includes('grok')) return 'xAI';
  if (family.startsWith('composer') || family.startsWith('cursor')) return 'Cursor';
  if (family.includes('kimi') || family.includes('deepseek') || family.includes('qwen')) return 'Open weights';
  return 'Other';
}

/**
 * `cursor-agent models` prints one row per (model, effort, speed) combination:
 *
 *   gpt-5.3-codex-low, gpt-5.3-codex, gpt-5.3-codex-high-fast, …
 *
 * Thirty near-identical rows make a poor picker and hide that effort/fast are
 * knobs. Group them into families and keep every printed id as a variant, so
 * the picker offers "Codex 5.3" with exactly the levels Cursor ships for it
 * (some families have only `high`, some have fast on one level only) and the
 * spawn path maps the choice back to the printed id.
 */
export function groupCursorModels(raw: RawCursorModel[]): ModelEntry[] {
  const families = new Map<string, { displayNames: string[]; variants: ModelVariant[] }>();
  const order: string[] = [];
  const entries: ModelEntry[] = [];

  for (const m of raw) {
    if (m.id === AUTO_MODEL_ID) {
      entries.push({ id: AUTO_MODEL_ID, displayName: m.displayName || 'Auto', description: 'Cursor picks the model', efforts: [], fast: false });
      continue;
    }
    const { family, effort, fast } = splitCursorId(m.id);
    let group = families.get(family);
    if (!group) {
      group = { displayNames: [], variants: [] };
      families.set(family, group);
      order.push(family);
    }
    group.variants.push({ effort, fast, id: m.id });
    group.displayNames.push(m.displayName);
  }

  for (const family of order) {
    const group = families.get(family)!;
    // The plain row ("Codex 5.3") names the family best; otherwise strip the
    // effort/speed words from whichever row came first.
    const plain = group.variants.findIndex((v) => v.effort === null && !v.fast);
    const source = plain >= 0 ? group.displayNames[plain]! : group.displayNames[0]!;
    const displayName = source.replace(CURSOR_LABEL_TOKENS, '').replace(/\s{2,}/g, ' ').replace(/\s+\(/g, ' (').trim() || family;

    const single = group.variants.length === 1 ? group.variants[0]! : null;
    entries.push({
      id: single && single.effort === null && !single.fast ? single.id : family,
      displayName,
      vendor: cursorVendor(family),
      variants: group.variants,
      description: describeCursorVariants(group.variants),
    });
  }

  return entries;
}

function describeCursorVariants(variants: ModelVariant[]): string | undefined {
  const efforts = sortEfforts([...new Set(variants.map((v) => v.effort).filter((e): e is string => Boolean(e)))]);
  const parts: string[] = [];
  if (efforts.length > 0) parts.push(`effort ${efforts.join(' / ')}`);
  if (variants.some((v) => v.fast)) parts.push('fast tier');
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

// ── Permission modes ──────────────────────────────────────────────────────

/**
 * Cursor's print mode cannot show its approval prompt and has no hook to
 * relay one, so anything not auto-approved is skipped. `--force` (aka
 * `--yolo`) used to ride in settings.preRunFlags; the mode owns it now and
 * the flag list is scrubbed of it (config migration + filter below).
 */
const CURSOR_PERMISSION_MODES: readonly (PermissionModeDescriptor & { args: string[] })[] = [
  {
    id: 'yolo',
    label: 'Run everything',
    description: '--force — every command runs unless a deny rule in cli-config.json matches.',
    prompts: 'never',
    yolo: true,
    args: ['--force'],
  },
  {
    id: 'auto-review',
    label: 'Auto-review (Smart Auto)',
    description: "Cursor's server classifier runs safe tool calls; the rest would prompt, which print mode cannot show, so they are skipped.",
    prompts: 'deny',
    args: ['--auto-review'],
  },
  {
    id: 'default',
    label: "Cursor's own rules",
    description:
      'No launch flag — Cursor falls back to the allow rules in its own cli-config.json; anything else is skipped (no prompt is possible headlessly).',
    prompts: 'deny',
    args: [],
  },
];

const FORCE_FLAGS = new Set(['--force', '-f', '--yolo']);

function permissionArgs(): string[] {
  const active = activePermissionMode(cursorProvider);
  return (CURSOR_PERMISSION_MODES.find((m) => m.id === active.id) ?? CURSOR_PERMISSION_MODES[0]!).args;
}

/** The printed id for the session's (family, effort, fast) — see groupCursorModels. */
function resolvedModelArg(session: SessionState): string | null {
  if (!session.activeModel || session.activeModel === AUTO_MODEL_ID) return null;
  return resolveVariantId(getCachedModelsAnyAge('cursor') ?? [], sessionSelection(session));
}

async function checkAuth(): Promise<AuthCheckResult> {
  try {
    const { stdout } = await execFileAsync(resolver.resolve(), ['status', '--format', 'json'], {
      timeout: 10_000,
      env: cursorEnv(process.env),
    });
    const parsed = JSON.parse(stripAnsi(stdout).trim()) as Record<string, unknown>;
    const userInfo = (parsed['userInfo'] ?? {}) as Record<string, unknown>;
    return {
      authenticated: parsed['isAuthenticated'] === true,
      email: typeof userInfo['email'] === 'string' ? userInfo['email'] : null,
    };
  } catch (err) {
    return { authenticated: false, email: null, detail: err instanceof Error ? err.message : String(err) };
  }
}

function cursorEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    HOME: base.HOME ?? homedir(),
    // Cursor's own auth owns the session — never leak other providers' keys into it.
    OPENAI_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
  };
}

function buildWorkerArgs(opts: SpawnOptions): string[] {
  const { project, session, prompt, mode = 'agent', oneShot = false, worktree, browser } = opts;
  const { settings } = getConfig();

  const args: string[] = [
    '-p',
    '--output-format',
    oneShot ? 'json' : 'stream-json',
    '--workspace',
    project.path,
  ];

  if (worktree) args.push('-w', worktree);
  const model = resolvedModelArg(session);
  if (model) args.push('--model', model);
  if (project.resumeId && !oneShot && mode !== 'ask' && !worktree) {
    args.push('--resume', project.resumeId);
  }
  if (mode === 'plan') args.push('--mode', 'plan');
  else if (mode === 'ask') args.push('--mode', 'ask');

  args.push(...permissionArgs());
  for (const flag of settings.preRunFlags) {
    if (!FORCE_FLAGS.has(flag)) args.push(flag);
  }

  args.push(mode === 'ask' ? buildAskPrompt(prompt) : buildAgentPrompt(prompt, { browser }));
  return args;
}

function buildVoiceArgs(project: Project, session: SessionState, pendingTurn?: string, bootPrompt = ''): string[] {
  const { settings } = getConfig();
  const args: string[] = ['-p', '--output-format', 'stream-json', '--workspace', project.path, '--approve-mcps'];

  const model = resolvedModelArg(session);
  if (model) args.push('--model', model);
  if (project.resumeId) args.push('--resume', project.resumeId);
  args.push(...permissionArgs());
  for (const flag of settings.preRunFlags) {
    if (!FORCE_FLAGS.has(flag) && !args.includes(flag)) args.push(flag);
  }
  args.push(bootPrompt);
  void pendingTurn;
  return args;
}

// ── Stream parsing ────────────────────────────────────────────────────────

/**
 * Cursor packs the tool name into the *key* of the tool_call object
 * (`{ writeToolCall: { args: { path } } }`), so the name and args come out of
 * the same object rather than separate fields.
 */
function normalizeCursorToolCall(toolCall: Record<string, unknown>): NormalizedToolCall | null {
  for (const key of Object.keys(toolCall)) {
    const value = toolCall[key] as Record<string, unknown> | null;
    const args = (value?.['args'] ?? value) as Record<string, unknown> | undefined;
    const call = normalizeToolCall(key, args);
    if (call.action !== 'other' || call.subagent) return call;
  }
  const first = Object.keys(toolCall)[0];
  return first ? normalizeToolCall(first, undefined) : null;
}

function parseCursorEvent(raw: Record<string, unknown>): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];

  if (typeof raw['session_id'] === 'string' && raw['session_id']) {
    events.push({ kind: 'session', sessionId: raw['session_id'] });
  }

  const type = raw['type'];
  const subtype = raw['subtype'];

  if (type === 'system' && subtype === 'init') {
    events.push({ kind: 'init', model: typeof raw['model'] === 'string' ? raw['model'] : undefined });
    return events;
  }

  // Both the legacy (`assistant`/`tool_use_start`) and current (`tool_call`) shapes.
  const isToolStart =
    (type === 'assistant' && subtype === 'tool_use_start') ||
    (type === 'tool_call' && subtype === 'started');
  const isToolDone =
    (type === 'assistant' && subtype === 'tool_use_done') ||
    (type === 'tool_call' && subtype === 'completed');

  if (isToolStart || isToolDone) {
    const payload = raw['tool_call'];
    const call =
      typeof payload === 'object' && payload !== null
        ? normalizeCursorToolCall(payload as Record<string, unknown>)
        : null;
    if (call) {
      events.push(
        isToolStart
          ? { kind: 'tool_start', tool: call }
          : { kind: 'tool_done', tool: call, success: raw['success'] !== false },
      );
    }
    return events;
  }

  if (type === 'assistant') {
    const text = extractContentText(raw['message']);
    if (text) events.push({ kind: 'assistant_text', text });
    return events;
  }

  if (type === 'result') {
    const direct = typeof raw['result'] === 'string' && raw['result'].trim() ? raw['result'].trim() : null;
    events.push({ kind: 'result', text: direct ?? extractContentText(raw['message']) });
    return events;
  }

  if (type === 'error') {
    events.push({
      kind: 'error',
      message: typeof raw['message'] === 'string' ? raw['message'] : 'an unknown error',
    });
    return events;
  }

  if (events.length === 0) logUnhandledEvent('cursor', raw);
  return events;
}

// ── MCP registration (~/.cursor/mcp.json + ~/.cursor/rules) ───────────────

function resolveCursorMcpJsonPath(): string {
  return join(resolveUserHome(), '.cursor', 'mcp.json');
}

const RULE_FILE = 'squeakr.mdc';
const LEGACY_RULE_FILES = ['agent-voice.mdc', 'cursor-voice.mdc'];

/**
 * Cursor reads project/user rules from `.mdc` files. Writing one means the
 * voice system prompt is present even on `--resume`, where we cannot re-send
 * the full boot prompt without confusing the resumed thread.
 */
function ensureSqueakrRule(ctx: McpRegistrationContext): void {
  const rulesDir = join(resolveUserHome(), '.cursor', 'rules');
  const rulePath = join(rulesDir, RULE_FILE);
  const label = formatPathForLog(rulePath);
  const content = `---
description: >
  Squeakr — use only during an active phone/PWA voice session.
  When a voice session is connected, all communication MUST go through ${ctx.serverName} MCP tools:
  speak() to talk, done() to re-arm the mic, next_voice_turn() to receive requests.
  If speak() returns NO_VOICE_SESSION, respond with normal IDE text instead.
  Text-only replies are invisible to the hands-free user.
alwaysApply: false
---

${ctx.ruleBody()}
`;

  try {
    mkdirSync(dirname(rulePath), { recursive: true });
    const exists = existsSync(rulePath);
    writeFileSync(rulePath, content, 'utf-8');
    for (const legacy of LEGACY_RULE_FILES) {
      const legacyPath = join(rulesDir, legacy);
      if (existsSync(legacyPath)) {
        // Leave the file in place but blank the body so an enabled stale rule
        // cannot keep injecting the old cursor-voice tool names.
        writeFileSync(legacyPath, `---\ndescription: Superseded by ${RULE_FILE}.\nalwaysApply: false\n---\n`, 'utf-8');
        ctx.log('update', 'info', `Retired legacy Cursor rule ${formatPathForLog(legacyPath)}.`);
      }
    }
    ctx.log(
      exists ? 'update' : 'install',
      'info',
      exists
        ? `Updated Cursor rule ${label} — enable in Settings → Rules when running voice`
        : `Installed Cursor rule ${label} — enable in Settings → Rules for voice mode`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log('error', 'warn', `Could not write ${label}: ${message}`);
  }
}

async function ensureCursorMcpRegistration(
  ctx: McpRegistrationContext,
): Promise<McpRegistrationResult> {
  const configPath = resolveCursorMcpJsonPath();
  const label = formatPathForLog(configPath);
  ctx.log('check', 'info', `Checking global Cursor MCP config (${label})…`);

  const existing = readJsonConfig(configPath);
  const { file, action, removedLegacy } = mergeJsonMcpEntry(existing, buildJsonMcpEntry(ctx), ctx);

  for (const legacy of removedLegacy) {
    ctx.log('update', 'info', `Removed stale "${legacy}" MCP entry from ${label}.`);
  }
  ctx.log(
    action === 'unchanged' ? 'check' : action === 'installed' ? 'install' : 'update',
    'info',
    action === 'unchanged'
      ? `${ctx.serverName} MCP server found (version ${ctx.version}).`
      : `${action === 'installed' ? 'Adding' : 'Updating'} ${ctx.serverName} in ${label}…`,
  );

  try {
    // Always rewrite: removedLegacy and the enable flag both need to land even
    // when the version matched.
    writeJsonConfig(configPath, file);
    ensureSqueakrRule(ctx);
  } catch (err) {
    return registrationFailure(ctx, configPath, err);
  }

  ctx.log('done', 'info', 'Global MCP ready for all projects — restart Cursor if the server list did not refresh.');
  return { ok: true, configPath, action, message: describeAction(action, 'Cursor') };
}

/**
 * cursor-agent stores each chat as `~/.cursor/chats/<workspace hash>/<chat id>/`.
 * The workspace hash is internal to Cursor, so we search every workspace: found
 * anywhere means the id really is a Cursor chat, found nowhere means `--resume`
 * would fail. See AgentProvider.sessionStatus for why 'unknown' is not 'absent'.
 */
function cursorSessionStatus(_project: Project, sessionId: string): 'present' | 'absent' | 'unknown' {
  const root = join(resolveUserHome(), '.cursor', 'chats');
  let workspaces: string[];
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return 'unknown';
  }
  if (workspaces.length === 0) return 'unknown';

  for (const workspace of workspaces) {
    if (existsSync(join(root, workspace, sessionId))) return 'present';
  }
  return 'absent';
}

/**
 * Past Cursor chats for a project.
 *
 * Chats live at `~/.cursor/chats/<workspace hash>/<chat id>/`. The hash is
 * Cursor's internal encoding of the workspace path and is not reproducible
 * from outside, so every workspace directory is scanned and each chat is
 * matched on the cwd recorded in its own metadata where one exists. Without
 * that, the chat is still listed — the directory has no other identifying
 * mark, and hiding it would be worse than showing it unattributed.
 */
function cursorListSessions(project: Project, limit = 30): StoredSessionSummary[] {
  const root = join(resolveUserHome(), '.cursor', 'chats');
  let workspaces: string[];
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const out: StoredSessionSummary[] = [];
  for (const workspace of workspaces) {
    let chats: string[];
    try {
      chats = readdirSync(join(root, workspace), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const chat of chats) {
      const path = join(root, workspace, chat);
      const cwd = cursorChatCwd(path);
      if (cwd !== null && cwd !== project.path) continue;
      out.push({ id: chat, updatedAt: safeMtimeMs(path), path, preview: null });
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, limit);
}

/** Cursor's chat metadata is undocumented — read it if present, shrug if not. */
function cursorChatCwd(chatDir: string): string | null {
  for (const name of ['metadata.json', 'chat.json', 'session.json']) {
    const file = join(chatDir, name);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
      for (const key of ['cwd', 'workspace', 'workspacePath', 'rootPath']) {
        const value = parsed[key];
        if (typeof value === 'string') return value;
      }
    } catch {
      // Unreadable metadata is not a reason to hide the chat.
    }
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

export const cursorProvider: AgentProvider = {
  id: 'cursor',
  displayName: 'Cursor',

  resolveBin: () => resolver.resolve(),
  isInstalled: () => resolver.isInstalled(),
  binEnvVar: () => resolver.envVar(),
  env: cursorEnv,
  checkAuth,

  authFlows(): AuthFlowDescriptor[] {
    return [
      {
        id: 'browser-url',
        label: 'Sign in with browser',
        description: 'Cursor opens a login link — tap it on your phone to link this device.',
      },
      {
        id: 'api-key',
        label: 'Use an API key',
        description: 'Paste a Cursor Dashboard API key instead of signing in interactively.',
        pasteLabel: 'Cursor API key',
        pastePlaceholder: 'key_...',
      },
    ];
  },

  async startLogin(flowId: AuthFlowId, opts): Promise<AuthStartResult> {
    if (flowId === 'api-key') {
      const key = opts?.pasted?.trim();
      if (!key || key.length < 8) {
        throw new Error('Paste a valid Cursor API key (from cursor.com/dashboard/api).');
      }
      updateAgentEnvKeys({ CURSOR_API_KEY: key });
      const result = await checkAuth();
      return {
        flow: flowId,
        instructions: 'API key saved.',
        done: Promise.resolve(result),
        cancel: () => {},
      };
    }

    if (flowId !== 'browser-url') {
      throw new Error(`Cursor does not support the "${flowId}" login flow.`);
    }

    return runLoginCommand({
      bin: resolver.resolve(),
      args: ['login'],
      env: { ...cursorEnv(process.env), NO_OPEN_BROWSER: '1' },
      urlPattern: /https?:\/\/\S+/,
      verify: checkAuth,
      instructions: 'Open the link on your phone and sign in to Cursor — this device links automatically.',
      flowId,
    });
  },

  isAuthError(exitCode: number, stderr: string): boolean {
    if (exitCode === 0) return false;
    return /authentication required|not authenticated|not logged in|please (run|log ?in)|cursor-agent login|401|unauthorized/i.test(
      stderr,
    );
  },

  async listModels(): Promise<ModelEntry[]> {
    const { stdout } = await execFileAsync(resolver.resolve(), ['models'], {
      timeout: 15_000,
      env: cursorEnv(process.env),
    });
    return groupCursorModels(parseModelsOutput(stdout));
  },

  supportsModelSelection: () => true,
  permissionModes: () => CURSOR_PERMISSION_MODES,
  buildWorkerArgs,
  buildVoiceArgs,

  supportedModes: (): readonly AgentMode[] => ['agent', 'plan', 'ask', 'debug'],
  // Cursor's agent accepts images returned by MCP tools.
  mediaInput: () => ({ mcpImageResults: true, note: 'Pictures go straight into the chat as images.' }),
  parseStreamEvent: parseCursorEvent,
  ensureMcpRegistration: ensureCursorMcpRegistration,
  sessionStatus: cursorSessionStatus,
  listSessions: cursorListSessions,
  /** `cursor-agent mcp list` / `mcp list-tools <identifier>`. */
  mcpInspectCommands: () => ({
    list: ['mcp', 'list'],
    tools: (server: string) => ['mcp', 'list-tools', server],
  }),
  /** cursor-agent has no fork flag — `--resume` continues the chat in place. */
  forkSessionArgs: () => null,

  /** `cursor-agent create-chat` mints a thread id we can resume into later. */
  async createSession(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(resolver.resolve(), ['create-chat'], {
        timeout: 10_000,
        env: cursorEnv(process.env),
      });
      return stripAnsi(stdout).trim() || null;
    } catch (err) {
      log.warn({ err }, 'create-chat failed');
      return null;
    }
  },

  async getAbout(): Promise<AgentAbout | null> {
    try {
      const { stdout } = await execFileAsync(resolver.resolve(), ['about', '--format', 'json'], {
        timeout: 10_000,
        env: cursorEnv(process.env),
      });
      const parsed = JSON.parse(stripAnsi(stdout).trim()) as Partial<AgentAbout>;
      if (!parsed.cliVersion) return null;
      return {
        cliVersion: parsed.cliVersion ?? '',
        model: parsed.model ?? '',
        osPlatform: parsed.osPlatform ?? '',
        osArch: parsed.osArch ?? '',
      };
    } catch {
      return null;
    }
  },
};

log.debug({ bin: resolver.resolve() }, 'cursor provider ready');
