/**
 * AgentProvider — the abstraction every coding-CLI (Cursor, Codex, Claude Code)
 * implements. This is the ONLY contract the rest of the app depends on; CLI
 * quirks (flags, auth commands, output formats) are isolated inside each
 * provider file (cursor.ts / codex.ts / claude.ts).
 *
 * Open/Closed: adding a fourth CLI means adding one new file + one registry
 * entry — nothing else in the app changes.
 */

import type { AgentClient } from '../../config.js';
import type { Project, SessionState } from '../../state/registry.js';
import type { AgentStreamEvent } from './events.js';
import type { McpRegistrationContext, McpRegistrationResult } from './mcpRegistration.js';

export type { AgentClient };
export type { AgentStreamEvent };

// ── Spawn contract (shared with executor/agentProcess.ts) ─────────────────

export type AgentMode = 'agent' | 'plan' | 'ask' | 'debug';

export interface SpawnOptions {
  project: Project;
  session: SessionState;
  prompt: string;
  mode?: AgentMode;
  /** If true, use one-shot JSON output (no streaming) — for ask/oneshot calls. */
  oneShot?: boolean;
  /** Run in an isolated git worktree (parallel agents on the same project). */
  worktree?: string;
  /** Append browser snapshot instructions to the worker prompt. */
  browser?: boolean;
}

/**
 * One selectable model, exactly as the CLI reports it.
 *
 * Nothing here is hardcoded by Squeakr: every provider builds these from a
 * live probe of its own CLI (`cursor-agent models`, Claude Code's `initialize`
 * control response, `codex debug models`, `codewhale model list`). Effort
 * levels and speed tiers therefore differ per model — Haiku has no effort
 * knob, Codex's GPT-6 goes up to `ultra`, Cursor only ships `high` for some
 * thinking models — and the picker shows only what the CLI actually accepts.
 */
export interface ModelEntry {
  /** What gets stored as the active model and handed back to the provider. */
  id: string;
  displayName: string;
  /** One-line blurb from the CLI catalog (context window, tier, "recommended"…). */
  description?: string;
  /** Vendor / family the picker groups under (Anthropic, OpenAI, Cursor, …). */
  vendor?: string;
  /**
   * Effort levels this model accepts, in the CLI's own order. Empty (or absent)
   * means the CLI exposes no effort knob for this model.
   */
  efforts?: string[];
  /** Level the CLI applies when none is passed — null when it does not say. */
  defaultEffort?: string | null;
  /** True when a fast / priority speed tier exists for this model. */
  fast?: boolean;
  /**
   * Cursor bakes effort and speed into the model id (`gpt-5.3-codex-high-fast`).
   * When present, this is the exhaustive list of (effort, fast) pairs the CLI
   * offers and the concrete id each one maps to. Providers that take real
   * `--effort` / speed flags leave it out — every combination of `efforts` ×
   * `fast` is then valid.
   */
  variants?: ModelVariant[];
}

export interface ModelVariant {
  /** null = the model's unsuffixed default. */
  effort: string | null;
  fast: boolean;
  /** The id to pass on the command line for this combination. */
  id: string;
}

/**
 * What the user picked: a model plus the effort / speed knobs that apply to
 * it. `effort: null` means "let the CLI decide", `fast: false` the standard
 * tier. Stored per session and as the bridge default.
 */
export interface ModelSelection {
  model: string;
  effort: string | null;
  fast: boolean;
}

export interface AgentAbout {
  cliVersion: string;
  model: string;
  osPlatform: string;
  osArch: string;
}

// ── Permission modes ────────────────────────────────────────────────────────

/**
 * One way a CLI can be told how much to do without asking. Every CLI has a
 * "run everything" option; what else exists — a classifier, edits-only, ask
 * for everything — differs per CLI, so each provider declares its own list
 * and owns the argv for each entry.
 */
export interface PermissionModeDescriptor {
  id: string;
  label: string;
  description: string;
  /**
   * What happens when the CLI would normally ask:
   *  - phone: the prompt is relayed to the phone (Claude Code --permission-prompt-tool)
   *  - deny:  the CLI is headless and simply refuses that action
   *  - never: nothing asks in this mode (run-everything / auto-reviewed)
   */
  prompts: 'phone' | 'deny' | 'never';
  /** The run-everything option — the default unless the user picks otherwise. */
  yolo?: boolean;
}

// ── Auth contract ───────────────────────────────────────────────────────────

/**
 * Every auth flow a provider can offer. The PWA renders a different card per
 * flow, but never needs provider-specific knowledge — it just follows the
 * descriptor.
 *
 *  - browser-url:  CLI prints a URL; open it on the phone, CLI polls/exits on success.
 *  - device-code:  CLI prints a URL + short code; open URL + enter code on the phone.
 *  - token-paste:  User generates a long-lived token elsewhere and pastes it into the PWA.
 *  - api-key:      User pastes a provider API key into the PWA (stored in .env).
 */
export type AuthFlowId = 'browser-url' | 'device-code' | 'token-paste' | 'api-key';

export interface AuthFlowDescriptor {
  id: AuthFlowId;
  label: string;
  description: string;
  /** Field label + placeholder when the flow needs a pasted value. */
  pasteLabel?: string;
  pastePlaceholder?: string;
}

export interface AuthCheckResult {
  authenticated: boolean;
  email: string | null;
  detail?: string;
}

export interface AuthStartResult {
  flow: AuthFlowId;
  /** Tappable URL for browser-url / device-code flows. */
  url?: string;
  /** Short one-time code for device-code flows. */
  code?: string;
  /** One sentence of guidance to show/speak to the user. */
  instructions: string;
  /** Resolves once the flow concludes (success or failure/timeout). */
  done: Promise<AuthCheckResult>;
  /** Abort an in-flight login attempt (e.g. user cancelled from the phone). */
  cancel(): void;
}

// ── Provider contract ───────────────────────────────────────────────────────

export interface AgentProvider {
  readonly id: AgentClient;
  readonly displayName: string;

  /** Resolve the CLI binary path (env override → common install dirs → PATH fallback). */
  resolveBin(): string;
  /** True if the binary was actually found (not just the bare PATH fallback name). */
  isInstalled(): boolean;
  /**
   * The environment variable that pins this CLI's binary path.
   *
   * Declared per provider so the config screen can render the list from the
   * providers themselves. It used to be a hardcoded pair (CODEX_PATH,
   * CLAUDE_CODE_PATH) that silently omitted CURSOR_AGENT_PATH and
   * CODEWHALE_PATH — docs/39 A7.
   */
  binEnvVar(): string | null;

  /** Build the subprocess environment for this CLI (may strip conflicting provider keys). */
  env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

  /** Ask the CLI whether the user is currently authenticated. */
  checkAuth(): Promise<AuthCheckResult>;
  /** Which login flows this provider supports, in preferred order. */
  authFlows(): AuthFlowDescriptor[];
  /**
   * Start a login flow. For browser-url/device-code this spawns the CLI's own
   * login command; for token-paste/api-key it validates + persists the pasted
   * value and resolves `done` immediately.
   */
  startLogin(flowId: AuthFlowId, opts?: { pasted?: string }): Promise<AuthStartResult>;

  /** True if this exit code + stderr combination looks like an auth failure. */
  isAuthError(exitCode: number, stderr: string): boolean;

  /**
   * Live model list — always probed from the CLI, never hardcoded. Each entry
   * carries the effort levels and speed tiers the CLI reports for it; the
   * result is cached per provider (state/models.ts) for `modelCacheTtlMs`.
   */
  listModels(): Promise<ModelEntry[]>;
  /** False when the CLI manages its own model choice (no --model flag to pass). */
  supportsModelSelection(): boolean;

  /**
   * Permission / approval modes this CLI can run headlessly, run-everything
   * first. `buildWorkerArgs` / `buildVoiceArgs` read the configured mode via
   * providers/agents/permissions.ts; read-only job modes (`ask`, `plan`)
   * always keep their own guarantees regardless of the permission mode.
   */
  permissionModes(): readonly PermissionModeDescriptor[];

  /** Build headless worker argv (jobManager / agent_ask). */
  buildWorkerArgs(opts: SpawnOptions): string[];
  /**
   * Build the conversational voice-agent argv. `bootPrompt` is the fully
   * assembled system/boot text from voiceAgent.ts (Squeakr system prompt +
   * pending-turn block) — providers just place it as the final prompt arg.
   */
  buildVoiceArgs(project: Project, session: SessionState, pendingTurn: string | undefined, bootPrompt: string): string[];

  /**
   * Execution modes this CLI can actually enforce.
   *
   * `agent` is mandatory. A provider that cannot enforce `ask` must say so —
   * `agent_ask` then refuses rather than silently running a *writing* agent
   * against the user's repo under a read-only-sounding tool name.
   */
  supportedModes(): readonly AgentMode[];

  /**
   * Translate one raw NDJSON stdout line into normalized events.
   * Returns `[]` for lines this provider does not care about.
   * See providers/agents/events.ts for why this exists.
   */
  parseStreamEvent(raw: Record<string, unknown>): AgentStreamEvent[];

  /**
   * Register the Squeakr MCP server with this CLI's own configuration.
   * Called on every voice-session prepare — must be idempotent, and must strip
   * `ctx.legacyServerNames` so a stale entry can't register a second server.
   */
  ensureMcpRegistration(ctx: McpRegistrationContext): Promise<McpRegistrationResult>;

  /**
   * How this CLI takes files the user uploads from the phone (docs/46).
   * Uploads always reach the agent by path; this says whether `inline`
   * delivery — pictures as image blocks in a Squeakr tool result — reaches
   * the model too, or has to fall back to the path.
   */
  mediaInput(): MediaInputSupport;

  /** Optional `about`/version probe — not every CLI has an equivalent. */
  getAbout?(): Promise<AgentAbout | null>;

  /**
   * Best-effort: does this CLI still hold `sessionId` for `project`?
   *
   * Resuming a thread the CLI does not have is fatal (exit 1 before a single
   * token is produced), so we check the CLI's own on-disk store first and drop
   * `--resume` when the answer is a confident no.
   *
   * `'unknown'` means "the store could not be inspected" (layout changed, dir
   * missing, permissions) — callers MUST treat that as "try the resume anyway"
   * rather than silently starting a fresh thread. Session stores are internal
   * to each CLI, so this is a heuristic and must never be the only safety net;
   * executor/resumeGuard.ts also recovers from the failure at runtime.
   */
  sessionStatus?(project: Project, sessionId: string): 'present' | 'absent' | 'unknown';

  /**
   * Pre-create a fresh conversation thread and return its id, if the CLI can.
   * When absent (or resolving null) `agent_new_session` just clears resume_id.
   */
  createSession?(project: Project): Promise<string | null>;

  /**
   * Past conversations this CLI holds for `project`, newest first.
   *
   * Reads the CLI's own on-disk store, which is undocumented and internal to
   * each vendor — so this is best-effort by construction. An unreadable or
   * restructured store returns `[]`, never throws, and the caller treats that
   * as "no past sessions found", exactly as `sessionStatus` treats `unknown`.
   *
   * Used by the session directory (docs/37 §1 kind C) so the phone can list
   * and resume threads that Squeakr did not start.
   */
  listSessions?(project: Project, limit?: number): StoredSessionSummary[];

  /**
   * Commands for inspecting this CLI's own MCP configuration, or null when the
   * CLI offers none. Declaring null is a real answer, not a gap.
   */
  mcpInspectCommands?(): McpInspectCommands | null;

  /**
   * Fork a past conversation into a new branch, if the CLI supports it.
   *
   * Forking is the safe way into a session that a live process may still own:
   * resuming a session id concurrently corrupts its transcript, so the
   * directory forks instead (docs/37 §2). A provider without a fork flag
   * declares it by leaving this undefined.
   */
  forkSessionArgs?(project: Project, sessionId: string, prompt: string): string[] | null;
}

/** What a CLI does with uploaded media — see `AgentProvider.mediaInput`. */
export interface MediaInputSupport {
  /** The CLI hands image blocks from MCP tool results to its model. */
  mcpImageResults: boolean;
  /** One line for the phone: how pictures reach this CLI. */
  note: string;
}

/**
 * How to ask this CLI what MCP servers *it* has configured.
 *
 * `agent_mcp_list` used to shell out to `cursor-agent` no matter which client
 * was active, so the answer described a CLI that was not running the work.
 * Every provider now either declares its own commands or says it cannot —
 * the provider rule: implemented for all four, or explicitly unsupported.
 */
export interface McpInspectCommands {
  /** Argv after the binary that lists configured servers. */
  list: string[];
  /**
   * Argv that lists one server's tools, or a fixed argv that lists them all.
   * Null when the CLI has no equivalent.
   */
  tools: ((server: string) => string[]) | null;
  /** Set when the CLI lists every server's tools at once, ignoring the name. */
  toolsListsEverything?: boolean;
}

/** One past conversation as read from a CLI's own session store. */
export interface StoredSessionSummary {
  /** The CLI's own session / chat / rollout id. */
  id: string;
  /** Epoch ms of the last activity, from metadata or the file's mtime. */
  updatedAt: number;
  /** Absolute path of the backing file or directory, for mtime and liveness. */
  path: string;
  /** First user message, when the store makes it cheap to read. */
  preview?: string | null;
}
