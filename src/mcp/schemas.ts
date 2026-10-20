/**
 * MCP Tool Schemas — single source of truth for all 16 tools.
 *
 * Each tool exports:
 *   - A zod schema for server-side arg validation.
 *   - A JSON schema object for OpenAI function-tool definitions.
 *
 * From these two sources, both the MCP dispatch layer and the provider
 * function-tool definitions are generated (DRY — one definition, two consumers).
 *
 * Full tool specs: docs/11-mcp-tool-surface.md
 */

import { z } from 'zod';

// ── Shared primitives ─────────────────────────────────────────────────────

/** Non-empty string capped at 32 KB (prompt/question text). */
const promptString = z
  .string()
  .min(1, 'Prompt must not be empty')
  .max(32_768, 'Prompt exceeds 32 KB limit');

/** Optional project name (slug-safe). */
const optionalProject = z.string().optional();

// ── Group: Project ────────────────────────────────────────────────────────

export const AgentListProjectsSchema = z.object({
  query: z.string().optional().describe('Filter projects by name, alias, or description'),
});

export const AgentSetProjectSchema = z.object({
  project: z.string().describe('Project name (or alias) to set as the active project'),
});

export const AgentManageProjectsSchema = z.object({
  action: z
    .enum(['describe', 'list', 'add', 'update', 'remove'])
    .describe(
      'describe = what projects are in Squeakr; list = filter registry; add/update/remove = mutate config',
    ),
  query: z.string().optional().describe('For list: filter by name, alias, or description'),
  enabled: z.boolean().optional().describe('For list: filter by enabled flag'),
  name: z.string().optional().describe('Slug name (required for add, update, remove)'),
  path: z.string().optional().describe('Absolute host path (required for add; optional for update)'),
  description: z.string().max(200).optional().describe('Short human-readable label'),
  aliases: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (Array.isArray(v)) return v;
      return v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    })
    .describe('Spoken aliases for STT routing'),
});

// ── Group: Model ──────────────────────────────────────────────────────────

export const AgentListModelsSchema = z.object({
  query: z.string().optional().describe('Filter models by id or display name (e.g. "claude", "fast")'),
  refresh: z.boolean().optional().describe('Re-probe the CLI instead of using the cached list'),
});

export const AgentSetModelSchema = z.object({
  model_id: z.string().describe('Exact model ID to use (from agent_list_models)'),
  effort: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Effort level — must be one of the model\'s `efforts` from agent_list_models (e.g. low, medium, high, xhigh, max). ' +
        'null / "default" = let the CLI decide. Omit to keep the current level.',
    ),
  fast: z
    .boolean()
    .optional()
    .describe('Fast / priority speed tier — only for models reporting `fast: true`. Omit to keep the current setting.'),
  scope: z
    .enum(['global', 'session'])
    .optional()
    .describe(
      'global (default): default selection, all sessions, and future sessions. ' +
        'session: only this voice/CLI connection — use when the user says "just this session".',
    ),
});

export const AgentPermissionModeSchema = z.object({
  mode: z.string().optional().describe('Permission mode id to switch to (from the `modes` list); omit to read'),
});

// ── Group: Execute ────────────────────────────────────────────────────────

export const AgentSubmitSchema = z.object({
  prompt: promptString.describe("The user's intent — relay with minimal editing"),
  project: optionalProject.describe('Target project (defaults to active project)'),
  mode: z.enum(['agent', 'plan']).optional().describe('Execution mode (default: agent)'),
  browser: z
    .boolean()
    .optional()
    .describe(
      'Append browser snapshot workflow to the worker prompt — use for UI tasks or when the user says "Browser".',
    ),
});

export const AgentAskSchema = z.object({
  question: promptString.describe("The user's question, verbatim"),
  project: optionalProject.describe('Target project (defaults to active project)'),
});

export const AgentRecallAnswerSchema = z.object({
  format: z
    .enum(['brief', 'full'])
    .optional()
    .describe('brief (default) for voice; full for complete text'),
});

// ── Group: Job ────────────────────────────────────────────────────────────

export const AgentJobStatusSchema = z.object({
  job_id: z.string().uuid('job_id must be a UUID').optional().describe('Defaults to active job'),
});

export const AgentJobStopSchema = z.object({
  job_id: z.string().uuid('job_id must be a UUID').optional().describe('Defaults to active job'),
});

// ── Group: Session ────────────────────────────────────────────────────────

export const AgentNewSessionSchema = z.object({
  project: optionalProject.describe('Project to clear session for (defaults to active project)'),
});

export const AgentSessionInfoSchema = z.object({
  project: optionalProject.describe('Project to query (defaults to active project)'),
});

// ── Group: Git ────────────────────────────────────────────────────────────

export const AgentDiffSchema = z.object({
  project: optionalProject,
  full_patch: z.boolean().optional().describe('Include full diff patch (default: false, stat only)'),
});

export const AgentRevertSchema = z.object({
  project: optionalProject,
  confirm: z
    .boolean()
    .optional()
    .describe(
      'Must be true for destructive hard-reset. Voice model must confirm with user first.',
    ),
});

// ── Group: System ─────────────────────────────────────────────────────────

export const AgentInfoSchema = z.object({});
export const AgentStatusSchema = z.object({});

// ── Group: MCP Inspect ────────────────────────────────────────────────────

export const AgentMcpListSchema = z.object({});

export const AgentMcpToolsSchema = z.object({
  server: z.string().describe('MCP server identifier (from agent_mcp_list)'),
});

// ── Group: User display ───────────────────────────────────────────────────

const imageItemSchema = z
  .object({
    path: z.string().min(1).optional().describe('Local file path (must be under project or temp dirs)'),
    url: z
      .string()
      .min(1)
      .optional()
      .describe('http(s) URL — loaded directly by the PWA'),
    data: z
      .string()
      .min(1)
      .optional()
      .describe('Base64 or data-URI image payload'),
    mime: z.string().optional().describe('MIME type (auto-detected when omitted)'),
    caption: z.string().max(500).optional().describe('Short label for this image'),
  })
  .refine(
    (item) => {
      const count = [item.path, item.url, item.data].filter((v) => v != null && v !== '').length;
      return count === 1;
    },
    { message: 'Each image must have exactly one of path, url, or data' },
  );

export const ShowImagesSchema = z.object({
  images: z
    .array(imageItemSchema)
    .min(1)
    .max(10)
    .describe('Images to show — a new call replaces the previous show_images batch'),
  duration_ms: z
    .number()
    .int()
    .min(3000)
    .max(120_000)
    .optional()
    .describe('How long they stay fullscreen before closing to the media button (default 8000 ms)'),
  caption: z
    .string()
    .max(300)
    .optional()
    .describe('Optional line for the batch (push notification text)'),
  /** Internal: send_files already published these as agent_files. */
  publish: z.boolean().optional(),
});

const mediaItemSchema = z
  .object({
    path: z.string().min(1).optional().describe('Local file under a project or the temp directory'),
    url: z.string().min(1).optional().describe('http(s) URL — loaded directly by the phone'),
    data: z.string().min(1).optional().describe('Base64 or data-URI payload (max 4 MB — use path for bigger files)'),
    kind: z
      .enum(['image', 'video', 'audio'])
      .optional()
      .describe('image | video | audio — detected from mime / extension when omitted'),
    mime: z.string().optional().describe('MIME type when the extension does not say'),
    caption: z.string().max(500).optional().describe('Short label for this item'),
    name: z.string().max(200).optional().describe('File name shown to the user'),
    live: z
      .boolean()
      .optional()
      .describe(
        'The file (path only, audio or video) is still being written — e.g. by another agent rendering it now. ' +
          'The phone streams it as it grows; call media_control(finish) when the file is complete.',
      ),
  })
  .refine((item) => [item.path, item.url, item.data].filter((v) => v != null && v !== '').length === 1, {
    message: 'Each item must have exactly one of path, url, or data',
  });

/** Raw shape — the MCP server registers it as-is (McpServer.tool takes a shape, not a refined object). */
export const ShowMediaShape = {
  items: z
    .array(mediaItemSchema)
    .min(1)
    .max(10)
    .describe('Images, videos and audio to show. Added to what is already shown unless replace is true.'),
  display: z
    .enum(['fullscreen', 'tray'])
    .optional()
    .describe(
      'fullscreen (default): the first item opens on the user\'s screen as the raw media with a close icon. ' +
        'tray: added quietly to the media button for the user to open.',
    ),
  autoplay: z
    .boolean()
    .optional()
    .describe('Start video / audio playing at once — only with display "fullscreen".'),
  muted: z.boolean().optional().describe('Start muted (the user taps to unmute).'),
  loop: z.boolean().optional().describe('Loop video / audio.'),
  auto_close_ms: z
    .number()
    .int()
    .min(1000)
    .max(3_600_000)
    .optional()
    .describe('Close fullscreen after this long on screen, unless the user closes it first. Only with "fullscreen".'),
  close_on_end: z
    .boolean()
    .optional()
    .describe('Close fullscreen when the video / audio finishes playing. Only with "fullscreen".'),
  self_destruct: z
    .union([z.number().int().min(5).max(86_400), z.literal('never')])
    .optional()
    .describe(
      'Seconds until the items are deleted from the user\'s phone and the bridge (5–86400, default 1800), ' +
        'or "never" — kept for as long as the voice session lives.',
    ),
  caption: z.string().max(300).optional().describe('Optional line for the whole batch (push notification text)'),
  replace: z.boolean().optional().describe('Remove everything shown before first (default false).'),
  publish: z
    .boolean()
    .optional()
    .describe('Also post the files to chat channels (Discord, Telegram…) when someone listens there (default true).'),
};

export const ShowMediaSchema = z.object(ShowMediaShape);

export const MediaControlShape = {
  action: z
    .enum(['status', 'open', 'close', 'play', 'pause', 'seek', 'remove', 'finish'])
    .describe(
      'status: what is shown and what the phone reports (playing / paused / ended / closed, position). ' +
        'open: show an item fullscreen. close: close fullscreen (a video keeps its frame). ' +
        'play / pause / seek: control playback (play opens it fullscreen). ' +
        'remove: delete items now. finish: a live file is complete — the stream ends at its last byte.',
    ),
  media_id: z.string().optional().describe('The item (from show_media). status without it lists everything.'),
  media_ids: z.array(z.string()).max(50).optional().describe('remove: several items at once'),
  all: z.boolean().optional().describe('remove: every item'),
  autoplay: z.boolean().optional().describe('open: start playing'),
  auto_close_ms: z.number().int().min(1000).max(3_600_000).optional().describe('open: close after this long'),
  position_s: z.number().min(0).optional().describe('seek: position in seconds'),
};

export const MediaControlSchema = z.object(MediaControlShape);

const fileItemSchema = z
  .object({
    path: z.string().min(1).optional().describe('Local file path (under a project or the temp directory)'),
    url: z.string().min(1).optional().describe('http(s) URL'),
    data: z.string().min(1).optional().describe('Base64 or data-URI payload'),
    mime: z.string().optional().describe('MIME type (from the name when omitted)'),
    name: z.string().max(200).optional().describe('File name shown to the user'),
    caption: z.string().max(500).optional().describe('Short label for this file'),
  })
  .refine((item) => [item.path, item.url, item.data].filter((v) => v != null && v !== '').length === 1, {
    message: 'Each file must have exactly one of path, url, or data',
  });

export const SendFilesSchema = z.object({
  files: z.array(fileItemSchema).min(1).max(10).describe('Files to send — recordings, videos, images, documents'),
  caption: z.string().max(300).optional().describe('Optional line sent with them'),
});

// ── Schema registry ───────────────────────────────────────────────────────

export const TOOL_SCHEMAS = {
  agent_list_projects: AgentListProjectsSchema,
  agent_set_project: AgentSetProjectSchema,
  agent_manage_projects: AgentManageProjectsSchema,
  agent_list_models: AgentListModelsSchema,
  agent_set_model: AgentSetModelSchema,
  agent_permission_mode: AgentPermissionModeSchema,
  agent_submit: AgentSubmitSchema,
  agent_ask: AgentAskSchema,
  agent_recall_answer: AgentRecallAnswerSchema,
  agent_job_status: AgentJobStatusSchema,
  agent_job_stop: AgentJobStopSchema,
  agent_new_session: AgentNewSessionSchema,
  agent_session_info: AgentSessionInfoSchema,
  agent_diff: AgentDiffSchema,
  agent_revert: AgentRevertSchema,
  agent_info: AgentInfoSchema,
  agent_status: AgentStatusSchema,
  agent_mcp_list: AgentMcpListSchema,
  agent_mcp_tools: AgentMcpToolsSchema,
  show_images: ShowImagesSchema,
  show_media: ShowMediaSchema,
  media_control: MediaControlSchema,
  send_files: SendFilesSchema,
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

/** Infer the validated arg type for a given tool. */
export type ToolArgs<T extends ToolName> = z.infer<(typeof TOOL_SCHEMAS)[T]>;

/**
 * Tool names shipped before the Cursor Voice → AgentVoice rename (docs/26).
 *
 * They are accepted by `dispatchTool` (the control-WebSocket / WebSocket
 * relay path) so an in-flight session that still remembers the old vocabulary
 * keeps working. They are deliberately NOT registered on the MCP server: the
 * tool list is what the model reads on every turn, and 18 duplicate deprecated
 * entries would cost context for no benefit — the system prompt and the CLI
 * rule file always carry the canonical `agent_*` names.
 */
export const LEGACY_TOOL_ALIASES: Readonly<Record<string, ToolName>> = {
  cursor_list_projects: 'agent_list_projects',
  cursor_set_project: 'agent_set_project',
  cursor_manage_projects: 'agent_manage_projects',
  cursor_list_models: 'agent_list_models',
  cursor_set_model: 'agent_set_model',
  cursor_submit: 'agent_submit',
  cursor_ask: 'agent_ask',
  cursor_recall_answer: 'agent_recall_answer',
  cursor_status: 'agent_job_status',
  cursor_stop: 'agent_job_stop',
  cursor_new_session: 'agent_new_session',
  cursor_session_info: 'agent_session_info',
  cursor_diff: 'agent_diff',
  cursor_revert: 'agent_revert',
  cursor_agent_info: 'agent_info',
  cursor_agent_status: 'agent_status',
  cursor_mcp_list: 'agent_mcp_list',
  cursor_mcp_tools: 'agent_mcp_tools',
} as const;

/** Resolve a possibly-legacy tool name to its canonical form, or null. */
export function canonicalToolName(name: string): ToolName | null {
  if (name in TOOL_SCHEMAS) return name as ToolName;
  return LEGACY_TOOL_ALIASES[name] ?? null;
}
