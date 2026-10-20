/**
 * MCP Streamable HTTP server — exposes every Squeakr tool to the coding CLI.
 *
 * Each provider registers this bridge as an MCP server named `squeakr` in
 * its own config (see providers/agents/<client>.ts). Once connected, the
 * conversational voice agent can call every tool listed below.
 *
 * Tool groups:
 *   Voice I/O    — speak, done, next_voice_turn
 *   Identity     — get_session_ref
 *   Agents       — list_agents, get_agent_status, get_agent_output,
 *                  spawn_agent, stop_agent, execute_plan, revert
 *   Sessions     — list_sessions, send_to_session, check_messages
 *   Jobs         — list_jobs_history
 *   Project      — agent_list_projects, agent_set_project, agent_manage_projects
 *   Model        — agent_list_models, agent_set_model, agent_permission_mode
 *   Execute      — agent_ask, agent_recall_answer
 *   Session      — agent_new_session
 *   Git          — agent_diff
 *   System       — agent_provider_info
 *   MCP inspect  — agent_mcp_list, agent_mcp_tools
 *   Away policy  — agent_away_policy
 *   User display — show_images, send_files
 *   Audio out    — audio_stream_open, audio_stream_write, audio_stream_close,
 *                  audio_stream_list, audio_stream_log (docs/47)
 *   User media   — view_media (uploads from the phone, docs/46)
 *   User interact — request_user_input, submit_plan_for_approval
 *
 * Deprecated aliases kept for one release (docs/40 §2): agent_submit →
 * spawn_agent, agent_job_status → get_agent_status, agent_job_stop →
 * stop_agent, revert_agent / agent_revert → revert, agent_session_info →
 * get_session_ref(project), agent_info / agent_status → agent_provider_info,
 * set_mode → spawn_agent's `mode`, inject → send_to_session.
 *
 * Transport: MCP Streamable HTTP (preferred over legacy SSE).
 * Auth: same Bearer token as /api/*.
 *
 * Pre-rename `cursor_*` tool names are still accepted by dispatchTool but are
 * deliberately not advertised here — see LEGACY_TOOL_ALIASES in schemas.ts.
 *
 * See docs/16-mcp-server-agent-as-brain.md and docs/11-mcp-tool-surface.md.
 */

import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { childLogger } from '../../log.js';
import { verifyWsToken } from '../../auth.js';
import {
  handleSpeak,
  handleDone,
  handleNextVoiceTurn,
  hasActiveVoiceSession,
  NO_VOICE_SESSION_ERROR,
} from './voiceToolHandlers.js';
import {
  makeAgentHandlers,
} from './agentToolHandlers.js';
import { dispatchTool } from '../handlers.js';
import { squeakrMcpInstructions } from '../squeakrPrompt.js';
import { MCP_ENTRY_VERSION, MCP_SERVER_NAME } from '../../providers/agents/mcpRegistration.js';
import { bindVoiceAgentMcpSession } from '../../executor/voiceAgent.js';
import { registerRequest, type UserInputRequest, type PlanApprovalRequest, type PermissionRequest } from './approvalRegistry.js';
import { PERMISSION_PROMPT_TOOL } from '../../providers/agents/permissions.js';
import { getActiveProvider } from '../../providers/agents/registry.js';
import { notifyPhone } from '../../push/notifyPhone.js';
import { instrumentMcpToolLogging } from './toolLogging.js';
import { instrumentListenerEnvelope } from './listenerEnvelope.js';
import {
  handleListSessions,
  handleSendToSession,
  handleCheckMessages,
  handleInject,
} from './sessionToolHandlers.js';
import { handleShowImages } from './imageToolHandlers.js';
import { handleSendFiles } from './fileToolHandlers.js';
import {
  handleAudioStreamOpen,
  handleAudioStreamWrite,
  handleAudioStreamClose,
  handleAudioStreamList,
  handleAudioStreamLog,
  closeAgentAudioOwner,
} from './audioStreamToolHandlers.js';
import { voiceTurnQueue } from './turnQueue.js';
import { handleViewMedia } from './mediaToolHandlers.js';
import { turnImageBlocks } from '../../media/delivery.js';
import {
  approvalPolicy,
  isListening,
  effectiveAwayPolicy,
  setConversationAwayPolicy,
  getConversationAwayPolicy,
} from '../../state/awayPolicy.js';
import { AWAY_POLICIES, getConfig } from '../../config.js';
import { phrase, shouldSpeakNarration, narrationPayload } from '../../voice/phrases.js';

const log = childLogger('mcp:server');

/** One human line for a permission card: the command, the file, or a trimmed JSON. */
function summarizeToolUse(toolName: string, input: unknown): string {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  };
  const detail =
    pick('command', 'file_path', 'path', 'notebook_path', 'url', 'pattern', 'query', 'description') ??
    (Object.keys(obj).length > 0 ? JSON.stringify(obj) : '');
  const line = detail ? `${toolName}: ${detail}` : toolName;
  return line.length > 240 ? `${line.slice(0, 237)}…` : line;
}

/** Spoken answer to an open permission prompt → allow / deny / unrelated. */
function classifySpokenDecision(text: string): 'allow' | 'deny' | 'other' {
  const t = text.trim().toLowerCase().replace(/[.!,]+$/g, '');
  if (/^(yes|yeah|yep|yup|sure|ok|okay|allow|approve|approved|go ahead|do it|fine|please do|confirm)( .{0,20})?$/.test(t)) return 'allow';
  if (/^(no|nope|nah|deny|denied|reject|stop|don't|do not|cancel|never)( .{0,20})?$/.test(t)) return 'deny';
  return 'other';
}

function voiceToolResponse(result: { error?: string; message?: string; [key: string]: unknown }) {
  const text = JSON.stringify(result);
  if (result.error === 'NO_VOICE_SESSION') {
    return {
      content: [{ type: 'text' as const, text }],
      isError: true,
    };
  }
  return { content: [{ type: 'text' as const, text }] };
}

// ── MCP server factory ────────────────────────────────────────────────────

function buildMcpServer(sessionKey: string): McpServer {
  const agentTools = makeAgentHandlers(sessionKey);

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_ENTRY_VERSION },
    {
      capabilities: { tools: {} },
      instructions: squeakrMcpInstructions(),
    },
  );

  instrumentMcpToolLogging(server);
  // Applied after the logging wrapper so the envelope lands on the outermost
  // result — the one the CLI actually receives.
  instrumentListenerEnvelope(server, sessionKey);

  // ── Voice I/O ──────────────────────────────────────────────────────────

  server.tool(
    'speak',
    'Speak to the user out loud (phone/PWA voice session only). Returns error NO_VOICE_SESSION if no listener is connected. ' +
      'Call one sentence at a time for low first-audio latency. ' +
      'When no voice session is active, use normal IDE text instead.',
    { text: z.string().min(1).describe('Exact words to speak aloud. One sentence per call.') },
    async ({ text }) => {
      const result = handleSpeak({ text });
      return voiceToolResponse({ ...result });
    },
  );

  server.tool(
    'done',
    'Signal that you have finished speaking and re-arm the mic (phone/PWA voice session only). ' +
      'Returns error NO_VOICE_SESSION if no listener is connected.',
    {},
    async () => {
      const result = handleDone();
      return voiceToolResponse({ ...result });
    },
  );

  server.tool(
    'next_voice_turn',
    'Wait for the next user utterance (phone/PWA voice session only). Returns error NO_VOICE_SESSION if no listener. ' +
      'Long-polls up to timeout_ms (default 30 s). ' +
      'Returns { turn: null } on timeout — call again immediately to keep listening. ' +
      'Call done() before next_voice_turn() to re-arm the mic first. ' +
      'On TTS barge-in, tts_interrupt.last_heard_words is what the user heard aloud (~10 words). Agents keep running. ' +
      'source="stream" means the user is on the direct audio pipe: speech is cut at pauses, so the turn may be ' +
      'part of a longer thought — follow stream_hint.',
    {
      timeout_ms: z
        .number()
        .int()
        .min(500)
        .max(60_000)
        .optional()
        .describe('Max wait in milliseconds (default 30 000, max 60 000).'),
    },
    async ({ timeout_ms }) => {
      const result = await handleNextVoiceTurn({ timeout_ms });
      const response = voiceToolResponse({ ...result });
      // Pictures the user sent with this turn, straight into the chat (docs/46).
      if (result.media_ids && result.media_delivery) {
        const blocks = turnImageBlocks({ ids: result.media_ids, delivery: result.media_delivery });
        (response.content as unknown[]).push(...blocks);
      }
      return response;
    },
  );

  // ── Identity ───────────────────────────────────────────────────────────

  server.tool(
    'get_session_ref',
    'Who and where you are: voice agent run id, CLI session id (resume ref), MCP session id, ' +
      'active job id, active project, active model and preferred spawn mode. ' +
      'Pass `project` to also get that project\'s persisted state — its resume id, last job and ' +
      'last run time — which is what agent_session_info returned. ' +
      'Call this to orient yourself after a resume or when session state is unclear.',
    {
      project: z
        .string()
        .optional()
        .describe("Include this project's persisted session state in the answer."),
    },
    async ({ project }) => {
      const identity = agentTools.handleGetSessionRef();
      const result = project
        ? {
            ...identity,
            project_session: await dispatchTool('agent_session_info', { project }, sessionKey),
          }
        : identity;
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Agent management ───────────────────────────────────────────────────

  server.tool(
    'list_agents',
    'Return all running worker agents (singleton + parallel worktree workers) and the voice agent. ' +
      'Shows id, kind, pid, current activity, elapsed time, and worktree name. ' +
      'Call before answering "what are you working on?" or before spawning a new worker.',
    {},
    async () => {
      const result = agentTools.handleListAgents();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'get_agent_status',
    'Get live status for a specific agent: activity, files written/read, shell commands run, and elapsed time. ' +
      'For completed jobs, returns summary, error, and status from the database.',
    { id: z.string().min(1).describe('Agent or job ID from list_agents, spawn_agent, or list_jobs_history.') },
    async ({ id }) => {
      const result = await agentTools.handleGetAgentStatus({ id });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'get_agent_output',
    'Get the full event log for an agent: tool calls, file writes, shell runs, and output text. ' +
      'Paginated — use offset/limit for large histories. ' +
      'For running agents, returns the in-memory rolling event buffer. ' +
      'For completed agents, reads from the database.',
    {
      id: z.string().min(1).describe('Agent or job ID.'),
      offset: z.number().int().min(0).optional().describe('Event index to start from (default 0).'),
      limit: z.number().int().min(1).max(50).optional().describe('Events to return (default 20, max 50).'),
    },
    async ({ id, offset, limit }) => {
      const result = await agentTools.handleGetAgentOutput({ id, offset, limit });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'spawn_agent',
    'Start a worker agent with the given coding instructions. The one way to start work — ' +
      'agent_submit is a deprecated alias for this. ' +
      'Modes: agent (default, applies changes), plan (proposes then waits), ' +
      'ask (read-only), debug (instruments and investigates). ' +
      'Set use_worktree: true to run in an isolated git worktree alongside the current worker ' +
      '— this enables true parallel execution without working-tree conflicts. ' +
      'Speak to confirm the task with the user before spawning. Include in instructions that the worker ' +
      'must produce clear, narratable progress (files, commands, phases) for live voice updates. ' +
      "Don't start silently.",
    {
      instructions: z.string().min(1).describe("The coding task — use the user's words."),
      project: z.string().optional().describe('Target project (defaults to the active project).'),
      mode: z
        .enum(['agent', 'plan', 'ask', 'debug'])
        .optional()
        .describe(
          'agent = apply changes; plan = propose only; ask = read-only; ' +
          'debug = agent mode with debugging focus. Pass it here rather than calling ' +
          'set_mode first. Default: stored preference or "agent".',
        ),
      use_worktree: z
        .boolean()
        .optional()
        .describe(
          'Run in an isolated git worktree. Allows parallel agents on the same project. ' +
          'Each worktree is independent — no shared working-tree conflicts.',
        ),
      worktree_name: z
        .string()
        .optional()
        .describe('Optional worktree name (auto-generated if not set). Alphanumeric + hyphens.'),
      browser: z
        .boolean()
        .optional()
        .describe(
          'Append browser snapshot workflow — use for UI work or when the user says "Browser".',
        ),
    },
    async ({ instructions, project, mode, use_worktree, worktree_name, browser }) => {
      const result = await agentTools.handleSpawnAgent({
        instructions,
        project,
        mode,
        use_worktree,
        worktree_name,
        browser,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'stop_agent',
    'Terminate a specific worker agent immediately (SIGTERM → SIGKILL). ' +
      'Works for both singleton and worktree agents. Use list_agents() to get the id. ' +
      'The API rejects this unless the user explicitly issued a recent stop/cancel command.',
    { id: z.string().min(1).describe('Agent or job ID from list_agents.') },
    async ({ id }) => {
      /**
       * The guard used to be conditional on a voice session existing, so with
       * the phone gone — exactly when nobody can object — an agent could stop
       * any worker it liked (docs/36 §4 rails). The rule is the same either
       * way: only a recent explicit user stop command releases it.
       *
       * The one exception is the away policy `stop_all`, which IS the user's
       * standing instruction to stop.
       */
      const userAskedToStopEverything =
        !isListening() && effectiveAwayPolicy() === 'stop_all';
      if (!userAskedToStopEverything && !voiceTurnQueue.checkAndClearInterrupt()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'USER_STOP_REQUIRED',
                message: 'Worker remains running — only an explicit recent user stop command can terminate it.',
              }),
            },
          ],
          isError: true,
        };
      }
      const result = await agentTools.handleStopAgent({ id });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Session directory (docs/37) ────────────────────────────────────────

  server.tool(
    'list_sessions',
    'List every agent session the user could mean: the voice agent, bridge workers, ' +
      'past conversations in each CLI\'s own store, and live sessions the user started ' +
      'themselves in a terminal. Each row has a spoken name ("auth worker"), its status, ' +
      'and `delivery` — how a message would actually reach it. Only sessions inside a ' +
      'registered project are listed.',
    {
      scope: z
        .enum(['all', 'running', 'bridge', 'external', 'recent'])
        .optional()
        .describe('all (default), running, bridge (ours only), external, or recent.'),
      project: z.string().optional().describe('Restrict to one project by name.'),
    },
    async ({ scope, project }) => {
      const result = handleListSessions({ scope, project });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'send_to_session',
    'Send a message from the user into a running or past agent session. ' +
      'Takes a handle, a spoken name ("the auth worker"), or an ordinal ("the second one"). ' +
      'The result says how it was delivered — live, mailbox_pending, fork, resume or refused — ' +
      'and you must tell the user which one happened rather than just saying "sent". ' +
      'External sessions, forks and stop-then-resume always need confirm: true; read the ' +
      'target, the method and the message back to the user first.',
    {
      handle: z.string().min(1).describe('Handle, spoken name, or ordinal from list_sessions.'),
      message: z.string().min(1).max(8_000).describe("The user's message, relayed as they said it."),
      confirm: z
        .boolean()
        .optional()
        .describe('The user has confirmed this exact send. Required for external sessions and forks.'),
      project: z.string().optional(),
    },
    async ({ handle, message, confirm, project }) => {
      const result = handleSendToSession({ handle, message, confirm, project });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'check_messages',
    'Collect messages the user sent into your session while you were working. ' +
      'Call it when a tool result shows `pending_messages` above zero. ' +
      'Messages are handed over once — treat them as instructions that arrived mid-task.',
    {
      session: z
        .string()
        .optional()
        .describe('Your own session handle. Omit to use the one this MCP session is bound to.'),
    },
    async ({ session }) => {
      const result = handleCheckMessages({ session }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'inject',
    'Deprecated alias for send_to_session — kept for one release. ' +
      'Sends a message into a running session and reports how it was delivered. ' +
      'Unlike the old implementation it also reaches worktree workers and the voice agent. ' +
      'The same confirmation rules apply: external sessions, forks and stop-then-resume ' +
      'need confirm: true after reading the target, the method and the message back.',
    {
      id: z.string().min(1).describe('Session handle or spoken name.'),
      message: z.string().min(1).describe('The message to deliver.'),
      confirm: z
        .boolean()
        .optional()
        .describe('The user has confirmed this exact send. Required for external sessions and forks.'),
    },
    async ({ id, message, confirm }) => {
      const result = handleInject({ id, message, confirm });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'revert',
    'Undo agent changes. `to: "checkpoint"` (needs `id`) rewinds to the git checkpoint taken ' +
      'before that job ran; `to: "head"` (the default) drops uncommitted changes in the project. ' +
      'Uncommitted work is stashed, which is reversible; a hard reset over agent commits is not, ' +
      'and needs confirm: true after you have said out loud exactly what will be lost. ' +
      'Replaces revert_agent and agent_revert, which stay as deprecated aliases.',
    {
      to: z
        .enum(['checkpoint', 'head'])
        .optional()
        .describe('checkpoint = back to before a job ran (needs id); head = drop uncommitted work.'),
      id: z
        .string()
        .min(1)
        .optional()
        .describe('Job ID, required for to: "checkpoint" (from list_jobs_history or spawn_agent).'),
      project: z.string().optional().describe('Project for to: "head" (defaults to active).'),
      confirm: z
        .boolean()
        .optional()
        .describe('Required for a hard reset over agent commits. Confirm with the user first.'),
    },
    async ({ to, id, project, confirm }) => {
      const target = to ?? (id ? 'checkpoint' : 'head');
      if (target === 'checkpoint') {
        if (!id) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: 'ID_REQUIRED',
                  message: 'to: "checkpoint" needs the job id to rewind to. Call list_jobs_history().',
                }),
              },
            ],
            isError: true,
          };
        }
        const result = await agentTools.handleRevertAgent({ id, confirm });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      const result = await dispatchTool('agent_revert', { project, confirm }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'revert_agent',
    'Deprecated alias — use revert({ to: "checkpoint", id }). ' +
      'Reverts a project to the git checkpoint recorded before a specific job ran.',
    {
      id: z
        .string()
        .min(1)
        .describe('Job ID whose pre-run git checkpoint to revert to (from list_jobs_history or spawn_agent result).'),
      confirm: z
        .boolean()
        .optional()
        .describe(
          'Must be true for hard reset when the agent made commits. ' +
          'Obtain explicit user confirmation first.',
        ),
    },
    async ({ id, confirm }) => {
      const result = await agentTools.handleRevertAgent({ id, confirm });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Job history ────────────────────────────────────────────────────────

  server.tool(
    'list_jobs_history',
    'List recent jobs for the active project (or a specified project). ' +
      'Returns id, mode, prompt, status, files changed, summary, error, and timing. ' +
      'Use to find job IDs for revert_agent or get_agent_output on completed work.',
    {
      project: z.string().optional().describe('Project name (defaults to active project).'),
      limit: z.number().int().min(1).max(30).optional().describe('Max jobs to return (default 10).'),
      status_filter: z
        .enum(['all', 'done', 'error', 'stopped'])
        .optional()
        .describe('Filter by status (default: all).'),
    },
    async ({ project, limit, status_filter }) => {
      const result = await agentTools.handleListJobsHistory({ project, limit, status_filter });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Mode & execution control ───────────────────────────────────────────

  server.tool(
    'set_mode',
    'Deprecated — pass `mode` to spawn_agent instead. ' +
      'Stores the preferred spawn mode for this session; ' +
      'the next spawn_agent() call uses it if no explicit mode is given. ' +
      'Modes: agent (default), plan (propose before apply), ask (read-only), ' +
      'debug (agent + debugging focus). ' +
      'Does NOT restart or modify any running agent.',
    {
      id: z
        .string()
        .min(1)
        .optional()
        .describe('Agent context id (informational — mode is session-scoped, not per-agent).'),
      mode: z
        .enum(['ask', 'agent', 'debug', 'plan'])
        .describe('Mode to use for the next spawn_agent call.'),
    },
    async ({ id, mode }) => {
      const result = await agentTools.handleSetMode({ id: id ?? 'session', mode });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'execute_plan',
    'Trigger execution on a plan-mode agent — submits a follow-up that applies the proposed plan.',
    {
      id: z.string().min(1).describe('Agent ID of the plan-mode session.'),
    },
    async ({ id }) => {
      const result = await agentTools.handleExecutePlan({ id });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Project management ─────────────────────────────────────────────────

  server.tool(
    'agent_list_projects',
    'List all enabled projects in the registry. ' +
      'Returns name, description, aliases, and which is active. ' +
      'Use before agent_set_project or when the user asks "what can I work on?"',
    {
      query: z.string().optional().describe('Filter by name, alias, or description (fuzzy contains).'),
    },
    async ({ query }) => {
      const result = await dispatchTool('agent_list_projects', { query }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_set_project',
    'Set the active project for this session. Validates against the registry. ' +
      'Speak the project description back to the user so a mishear is caught before any edits.',
    {
      project: z.string().describe('Project name or alias to set as active.'),
    },
    async ({ project }) => {
      const result = await dispatchTool('agent_set_project', { project }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_manage_projects',
    'Administer allowlisted codebases: describe the project model, list/filter, add, update, or remove. ' +
      'Projects map spoken names to workspace paths; the user usually selects the active project in the PWA dropdown.',
    {
      action: z
        .enum(['describe', 'list', 'add', 'update', 'remove'])
        .describe('describe | list | add | update | remove'),
      query: z.string().optional().describe('list: filter by name, alias, or description'),
      enabled: z.boolean().optional().describe('list: filter by enabled'),
      name: z.string().optional().describe('Slug name — required for add/update/remove'),
      path: z.string().optional().describe('Absolute host path — required for add'),
      description: z.string().max(200).optional().describe('Short label'),
      aliases: z.array(z.string()).optional().describe('Spoken aliases'),
    },
    async (args) => {
      const result = await dispatchTool('agent_manage_projects', args, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Model management ───────────────────────────────────────────────────

  server.tool(
    'agent_list_models',
    'List the AI models the active agent CLI reports, with per-model capabilities: `efforts` (effort levels that ' +
      'model accepts — differs per model, empty when it has none), `defaultEffort`, and `fast` (whether a fast / ' +
      'priority tier exists). Also returns the active selection (model + effort + fast) and a spoken-friendly ' +
      '`active_label`. Use to find a model ID and its valid effort levels before agent_set_model.',
    {
      query: z.string().optional().describe('Filter by id or display name (e.g. "claude", "fast", "thinking").'),
      refresh: z.boolean().optional().describe('Re-probe the CLI instead of using the cached list.'),
    },
    async ({ query, refresh }) => {
      const result = await dispatchTool('agent_list_models', { query, refresh }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_set_model',
    'Set the AI model and, optionally, its effort level and fast tier. Default scope is global: updates the bridge ' +
      'default, all active sessions, and future sessions. Use scope "session" only when the user explicitly says ' +
      'they want this session/connection only. model_id must come from agent_list_models; effort must be one of ' +
      'that model\'s `efforts` (omit to keep the current level, pass null for the CLI default); fast only where the ' +
      'model reports `fast: true`. Rejected values come back with the accepted ones — read the error aloud.',
    {
      model_id: z.string().describe('Exact model ID from agent_list_models (e.g. "opus[1m]", "gpt-5.3-codex", "auto").'),
      effort: z
        .string()
        .nullable()
        .optional()
        .describe('Effort level from the model\'s `efforts` list (e.g. "high"). null or "default" = CLI default.'),
      fast: z.boolean().optional().describe('Request the fast / priority tier (model must report fast: true).'),
      scope: z
        .enum(['global', 'session'])
        .optional()
        .describe('global (default) = default + all sessions. session = this connection only.'),
    },
    async ({ model_id, effort, fast, scope }) => {
      const result = await dispatchTool('agent_set_model', { model_id, effort, fast, scope }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_permission_mode',
    'Read or change how much the active agent CLI may do without asking (its permission / approval mode). ' +
      'Call with no arguments to list the modes this CLI offers (they differ per CLI) and the active one. ' +
      'Pass `mode` (an id from `modes`) to change it — "run everything" is the default; modes marked prompts: "phone" ' +
      'send each permission prompt to the phone for the user to allow or deny.',
    {
      mode: z.string().optional().describe('Mode id from `modes` to switch to. Omit to just read.'),
    },
    async ({ mode }) => {
      const result = await dispatchTool('agent_permission_mode', { mode }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_away_policy',
    'Read or set what happens to running work when the user puts their phone down. ' +
      'Call with no arguments to read the policy in force. Pass `policy` when the user ' +
      'says something like "keep going while I am away" or "stop if you lose me" — ' +
      'the override lasts for this conversation only and does not change their saved setting. ' +
      'keep_working = finish the task alone; finish_turn = wrap up the current step then stop; ' +
      'stop_all = reach a safe point and stop.',
    {
      policy: z
        .enum(AWAY_POLICIES)
        .optional()
        .describe('Policy for this conversation. Omit to just read.'),
      clear: z
        .boolean()
        .optional()
        .describe('Drop the conversation override and go back to the saved setting.'),
    },
    async ({ policy, clear }) => {
      if (clear) setConversationAwayPolicy(null);
      else if (policy) setConversationAwayPolicy(policy);
      const saved = getConfig().settings.session.onPhoneAway;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              policy: effectiveAwayPolicy(),
              saved_default: saved,
              override: getConversationAwayPolicy(),
              choices: AWAY_POLICIES,
            }),
          },
        ],
      };
    },
  );

  // ── Execution ──────────────────────────────────────────────────────────

  server.tool(
    'agent_submit',
    'Deprecated alias for spawn_agent — use spawn_agent. ' +
      'Submits a coding task to the active agent CLI and returns a job_id immediately. ' +
      'Takes a git checkpoint automatically; undo with revert.',
    {
      prompt: z
        .string()
        .min(1)
        .max(32_768)
        .describe("The coding task — relay the user's intent with minimal editing."),
      project: z.string().optional().describe('Target project (defaults to active project).'),
      mode: z
        .enum(['agent', 'plan'])
        .optional()
        .describe('agent = apply changes; plan = propose only. Default: agent.'),
      browser: z
        .boolean()
        .optional()
        .describe(
          'Append browser snapshot workflow — use for UI work or when the user says "Browser".',
        ),
    },
    async ({ prompt, project, mode, browser }) => {
      // One implementation, two names, for one release (docs/40 §2).
      const result = await agentTools.handleSpawnAgent({
        instructions: prompt,
        project,
        mode,
        browser,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_ask',
    'Ask a read-only question about the codebase. No file edits; uses --mode ask. ' +
      'One-shot; does not pollute the work session. ' +
      'Use before agent_submit when you need repo facts to draft an accurate prompt.',
    {
      question: z
        .string()
        .min(1)
        .max(32_768)
        .describe("The question — verbatim from the user or self-generated for repo research."),
      project: z.string().optional().describe('Target project (defaults to active project).'),
    },
    async ({ question, project }) => {
      const result = await dispatchTool('agent_ask', { question, project }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_recall_answer',
    'Return the last agent_ask result without re-running the agent CLI. ' +
      'Use for summarize / repeat / expand follow-ups on the previous answer.',
    {
      format: z
        .enum(['brief', 'full'])
        .optional()
        .describe('brief = voice-length summary (default); full = complete text.'),
    },
    async ({ format }) => {
      const result = await dispatchTool('agent_recall_answer', { format }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Job tracking ───────────────────────────────────────────────────────

  server.tool(
    'agent_job_status',
    'Deprecated alias for get_agent_status — use get_agent_status, which takes an agent id ' +
      'or a job id. Polls a running or completed job and returns status, recent progress, ' +
      'summary, diffstat and session id.',
    {
      job_id: z
        .string()
        .uuid()
        .optional()
        .describe('Job UUID from agent_submit or spawn_agent (defaults to the active job).'),
    },
    async ({ job_id }) => {
      const result = await dispatchTool('agent_job_status', { job_id }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_job_stop',
    'Deprecated alias for stop_agent — use stop_agent, which takes an agent id or a job id ' +
      'and keeps the user-confirmation guard. Does not cancel in-flight agent_ask calls.',
    {
      job_id: z
        .string()
        .uuid()
        .optional()
        .describe('Job UUID (defaults to the active job for this session).'),
    },
    async ({ job_id }) => {
      const result = await dispatchTool('agent_job_stop', { job_id }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Session management ─────────────────────────────────────────────────

  server.tool(
    'agent_new_session',
    'Clear the stored resume ID for a project so the next agent_submit starts a fresh thread. ' +
      'Use when the user says "start fresh" or "new conversation".',
    {
      project: z.string().optional().describe('Project to reset (defaults to active project).'),
    },
    async ({ project }) => {
      const result = await dispatchTool('agent_new_session', { project }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_session_info',
    'Deprecated alias — get_session_ref(project) returns the same persisted state alongside ' +
      'your own identity. Reads a project\'s resume id, last job and last run time.',
    {
      project: z.string().optional().describe('Project to query (defaults to active project).'),
    },
    async ({ project }) => {
      const result = await dispatchTool('agent_session_info', { project }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Git ────────────────────────────────────────────────────────────────

  server.tool(
    'agent_diff',
    'Return the current uncommitted git diff for the active project. ' +
      'diffstat is always included; set full_patch: true for the full diff text. ' +
      'Use to describe what the last agent run changed.',
    {
      project: z.string().optional().describe('Project to diff (defaults to active project).'),
      full_patch: z.boolean().optional().describe('Include full patch text (default: false, stat only).'),
    },
    async ({ project, full_patch }) => {
      const result = await dispatchTool('agent_diff', { project, full_patch }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_revert',
    'Deprecated alias — use revert({ to: "head" }). ' +
      'Reverts uncommitted changes in a project; a hard reset over agent commits needs confirm: true.',
    {
      project: z.string().optional().describe('Project to revert (defaults to active project).'),
      confirm: z
        .boolean()
        .optional()
        .describe('Required for hard reset. Confirm with the user first.'),
    },
    async ({ project, confirm }) => {
      const result = await dispatchTool('agent_revert', { project, confirm }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── System ─────────────────────────────────────────────────────────────

  server.tool(
    'agent_provider_info',
    'Everything about the CLI currently running the work: version, default model, OS, account, ' +
      'and whether it is signed in. Answers both "what model are you using?" and ' +
      '"are you ready to run jobs?" in one call. ' +
      'Replaces agent_info and agent_status, which are kept as deprecated aliases.',
    {},
    async () => {
      // Version and auth were two tools purely because they were written at
      // different times; the agent almost always wanted both (docs/40 §2).
      const [info, status] = await Promise.all([
        dispatchTool('agent_info', {}, sessionKey),
        dispatchTool('agent_status', {}, sessionKey),
      ]);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...(info as object), ...(status as object) }) }],
      };
    },
  );

  server.tool(
    'agent_info',
    'Deprecated alias — use agent_provider_info. ' +
      'CLI version, default model, OS and account for the active agent provider.',
    {},
    async () => {
      const result = await dispatchTool('agent_info', {}, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_status',
    'Deprecated alias — use agent_provider_info. ' +
      'Authentication status of the active agent provider.',
    {},
    async () => {
      const result = await dispatchTool('agent_status', {}, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );


  // ── MCP inspect ────────────────────────────────────────────────────────

  server.tool(
    'agent_mcp_list',
    "List the MCP servers the active agent CLI has configured, and their load status. " +
      'Works for whichever CLI is running; a CLI with no such command comes back ' +
      'supported: false with the reason, not an error.',
    {},
    async () => {
      const result = await dispatchTool('agent_mcp_list', {}, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'agent_mcp_tools',
    'List the tools one of the agent CLI\'s MCP servers exposes. ' +
      'Some CLIs list every server at once — the result says so with all_servers: true.',
    {
      server: z.string().describe('MCP server identifier from agent_mcp_list.'),
    },
    async ({ server }) => {
      const result = await dispatchTool('agent_mcp_tools', { server }, sessionKey);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── User display ─────────────────────────────────────────────────────────

  server.tool(
    'view_media',
    'See files the user uploaded from their phone (images, video frames) as images in this chat, and read ' +
      'recording transcripts. Turns that carry uploads list the ids. Raw files stay on disk at the listed paths; ' +
      'this tool only shows them. Videos come back as still frames plus their sound transcript.',
    {
      ids: z.array(z.string().min(1)).min(1).max(12).describe('Media ids from the turn text or media_ids.'),
    },
    async ({ ids }) => handleViewMedia({ ids }),
  );

  server.tool(
    'show_images',
    'Push images to the user\'s phone as a browsable carousel (non-blocking). ' +
      'Use after browser snapshots or when the user needs to see UI. ' +
      'Each item needs exactly one of path (local file), url (http/https), or data (base64). ' +
      'A new call replaces the previous carousel. ' +
      'Speak a short line like "I\'m showing that on your phone now." then call this tool.',
    {
      images: z
        .array(
          z
            .object({
              path: z.string().min(1).optional().describe('Local file path under project or temp'),
              url: z.string().min(1).optional().describe('http(s) URL loaded directly by PWA'),
              data: z.string().min(1).optional().describe('Base64 or data-URI payload'),
              mime: z.string().optional().describe('MIME type when not auto-detected'),
              caption: z.string().max(500).optional().describe('Per-image caption'),
            })
            .refine(
              (item) =>
                [item.path, item.url, item.data].filter((v) => v != null && v !== '').length === 1,
              { message: 'Each image must have exactly one of path, url, or data' },
            ),
        )
        .min(1)
        .max(10)
        .describe('Images to display — overwrites any previous carousel'),
      duration_ms: z
        .number()
        .int()
        .min(3000)
        .max(120_000)
        .optional()
        .describe('Expanded display time before minimizing to toggle (default 8000 ms)'),
      caption: z
        .string()
        .max(300)
        .optional()
        .describe('Optional title above the carousel'),
    },
    async (args) => {
      if (!hasActiveVoiceSession()) {
        return voiceToolResponse({
          ok: false,
          error: 'NO_VOICE_SESSION',
          message: NO_VOICE_SESSION_ERROR,
        });
      }
      const result = handleShowImages(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    'send_files',
    'Send the user files — a recording, a video, a screenshot, a log, a document. ' +
      'They arrive wherever the user is: as attachments in their chat (Discord, Telegram…), and images also on the phone. ' +
      'Each item needs exactly one of path (local file under a project or temp), url, or data (base64). ' +
      'Non-blocking. Say a short line like "I\'ve sent you the recording." with it.',
    {
      files: z
        .array(
          z
            .object({
              path: z.string().min(1).optional().describe('Local file path under a project or temp'),
              url: z.string().min(1).optional().describe('http(s) URL'),
              data: z.string().min(1).optional().describe('Base64 or data-URI payload'),
              mime: z.string().optional().describe('MIME type when not clear from the name'),
              name: z.string().max(200).optional().describe('File name shown to the user'),
              caption: z.string().max(500).optional().describe('Per-file caption'),
            })
            .refine((item) => [item.path, item.url, item.data].filter((v) => v != null && v !== '').length === 1, {
              message: 'Each file must have exactly one of path, url, or data',
            }),
        )
        .min(1)
        .max(10)
        .describe('Files to send'),
      caption: z.string().max(300).optional().describe('Optional line sent with them'),
    },
    async (args) => {
      if (!hasActiveVoiceSession()) {
        return voiceToolResponse({ ok: false, error: 'NO_VOICE_SESSION', message: NO_VOICE_SESSION_ERROR });
      }
      const result = handleSendFiles(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // ── Agent audio streams (docs/47) ───────────────────────────────────────

  server.tool(
    'audio_stream_open',
    'Open a stream to play your own audio to the user — sound effects, recordings, generated clips, a live PCM feed. ' +
      'Returns stream_id; then audio_stream_write files or packets into it and audio_stream_close it. ' +
      'mode "queue" (default) waits its turn in the speech queue: speak() lines and queued streams sent after it wait until it has played. ' +
      'mode "async" starts at once and plays under/alongside everything else — speech and other streams go over it, nothing waits for it. ' +
      'To play one file, do it in a single call: audio_stream_open({ path, mode, close: true }). ' +
      'You can hold many streams at once. Pass format only if you will write raw PCM packets. ' +
      'Returns error NO_VOICE_SESSION if nobody is listening.',
    {
      label: z.string().max(120).optional().describe('Name shown to the user and in logs, e.g. "build chime".'),
      mode: z.enum(['queue', 'async']).optional().describe('queue (default): in line with speech. async: plays now, alongside speech.'),
      volume: z.number().min(0).max(1).optional().describe('0–1 (default 1). Use ~0.3 for async background audio.'),
      format: z
        .object({
          encoding: z.enum(['pcm_s16le', 'pcm_f32le']).optional().describe('Default pcm_s16le.'),
          sample_rate: z.number().int().min(8000).max(192_000),
          channels: z.number().int().min(1).max(8).optional().describe('Default 1; interleaved.'),
        })
        .optional()
        .describe('Format of raw PCM packets written with `packet`. Not needed for files.'),
      log: z.boolean().optional().describe('False keeps this stream out of the transcript and the phone log (default true).'),
      path: z.string().min(1).optional().describe('A first file to play (under a project or temp) — same as an audio_stream_write.'),
      url: z.string().min(1).optional().describe('A first file to play, by http(s) URL.'),
      data: z.string().min(1).optional().describe('A first file to play, base64.'),
      close: z.boolean().optional().describe('Close the stream once that file is in (it still plays to the end): a one-shot.'),
    },
    async (args) => voiceToolResponse(await handleAudioStreamOpen(sessionKey, args)),
  );

  server.tool(
    'audio_stream_write',
    'Append audio to one of your open streams. Exactly one of: path (local file under a project or temp), url (http/https), ' +
      'data (base64 whole file) — WAV and Ogg/Opus always; mp3, flac, m4a, webm… when ffmpeg is installed — ' +
      'or packet (base64 raw PCM in the format given to audio_stream_open). Writes play in call order. ' +
      'Returns as soon as the audio is sent, not when it has played (see audio_stream_list playback).',
    {
      stream_id: z.string().min(1),
      path: z.string().min(1).optional(),
      url: z.string().min(1).optional(),
      data: z.string().min(1).optional().describe('Base64 or data-URI of a whole audio file.'),
      packet: z.string().min(1).optional().describe('Base64 raw PCM packet; any size, may split samples.'),
    },
    async (args) => voiceToolResponse(await handleAudioStreamWrite(sessionKey, args)),
  );

  server.tool(
    'audio_stream_close',
    'Close one, several, or all of your audio streams in one call. drain=true (default) lets what was written finish playing; ' +
      'drain=false stops it now. Streams are also closed for you when your session ends or after 10 min without writes.',
    {
      stream_ids: z.array(z.string().min(1)).max(64).optional(),
      all: z.boolean().optional().describe('Close every stream you have open.'),
      drain: z.boolean().optional().describe('Default true: play out, then close. false: silence now.'),
    },
    async (args) => voiceToolResponse(await handleAudioStreamClose(sessionKey, args)),
  );

  server.tool(
    'audio_stream_list',
    'Your audio streams: mode, audio written, and what each listener reports (playing / ended / stopped). ' +
      'include_log adds each stream\'s event log; include_closed adds recently closed streams.',
    {
      include_closed: z.boolean().optional(),
      include_log: z.boolean().optional(),
    },
    async (args) => voiceToolResponse(handleAudioStreamList(sessionKey, args)),
  );

  server.tool(
    'audio_stream_log',
    'Read the event logs of audio streams (open or recently closed) and optionally add your own note to them — ' +
      'e.g. what a clip was or why it was played. Notes also go to the session transcript and the phone\'s log.',
    {
      stream_ids: z.array(z.string().min(1)).min(1).max(64),
      note: z.string().max(500).optional(),
    },
    async (args) => voiceToolResponse(handleAudioStreamLog(sessionKey, args)),
  );

  // ── User interaction (approvals & questions) ───────────────────────────

  server.tool(
    'request_user_input',
    'Ask the user a question and wait for their spoken or tapped reply. ' +
      'The PWA shows a prompt card and, unless the user has turned that off, reads it aloud. ' +
      'This tool BLOCKS until the user responds, a new voice/text turn arrives, or timeout_ms elapses. ' +
      'If the user speaks/types while waiting, returns { interrupted: true, user_turn } instead of an answer — treat that as the new request. ' +
      'Use for yes/no decisions, short choices, or free-text clarifications. ' +
      'Do NOT call speak() with the same question first: the card speaks it, so you would ask it twice. ' +
      'If nobody is listening the away policy answers for the user — read `away` in the result.',
    {
      question: z.string().min(1).max(1000).describe('The question to display and read aloud to the user.'),
      input_type: z
        .enum(['yesno', 'choice', 'freetext'])
        .describe(
          'yesno = Yes / No buttons; ' +
          'choice = pick from provided options list; ' +
          'freetext = user types or speaks a free answer.',
        ),
      options: z
        .array(z.string().min(1).max(200))
        .min(2)
        .max(10)
        .optional()
        .describe('Required when input_type is "choice". List of options for the user to pick from.'),
      timeout_ms: z
        .number()
        .int()
        .min(10_000)
        .max(300_000)
        .optional()
        .describe('How long to wait for a response (default 120 000 ms = 2 min).'),
    },
    async ({ question, input_type, options, timeout_ms }) => {
      /**
       * With nobody listening this used to be a flat NO_VOICE_SESSION, so an
       * unattended run stalled on its first question. The away policy decides
       * instead: keep the card open on a push, answer no, or decline this one
       * step and let the agent carry on elsewhere (docs/36 §4).
       */
      const policy = approvalPolicy(timeout_ms ?? 120_000);
      if (policy.action !== 'ask') {
        return voiceToolResponse({
          answered_by: 'away_policy',
          decision: policy.action,
          answer: policy.action === 'deny' ? 'no' : '',
          away: true,
          message: policy.message ?? undefined,
        });
      }
      const timeout = policy.timeoutMs;

      const { request_id, promise } = registerRequest((id) => {
        const req: UserInputRequest = {
          kind: 'user_input',
          request_id: id,
          question,
          input_type,
          options,
        };
        void notifyPhone({ type: 'user_input_request', ...req });
        return req;
      }, timeout);

      log.info({ request_id, input_type }, 'request_user_input: waiting for user');

      try {
        const response = await promise;
        if (response.kind === 'interrupted_by_voice_turn') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  interrupted: true,
                  request_id,
                  user_turn: response.user_turn,
                  is_interrupt: response.is_interrupt,
                  received_at: response.received_at,
                  source: response.source,
                  segments: response.segments,
                  stream_hint: response.stream_hint,
                  tts_interrupt: response.tts_interrupt ?? null,
                  pending_user_turns: 0,
                  message:
                    'User sent a new turn while this question was open. Act on user_turn; do not expect an answer to the original question.',
                }),
              },
            ],
          };
        }
        if (response.kind !== 'user_input') {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unexpected response kind' }) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ request_id, answer: response.answer }) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: JSON.stringify({ request_id, error: message }) }] };
      }
    },
  );

  /**
   * Claude Code's `--permission-prompt-tool` target. The CLI — not the model —
   * calls this whenever its permission mode would show a prompt; the answer
   * has to be a JSON string of `{behavior:"allow", updatedInput?}` or
   * `{behavior:"deny", message}`. The prompt is relayed to the phone as a
   * `permission` approval card; a spoken yes/no while it is open counts too.
   */
  server.tool(
    PERMISSION_PROMPT_TOOL,
    'Internal: the agent CLI calls this for its own permission prompts (Claude Code --permission-prompt-tool). ' +
      'The user allows or denies on the phone. Do not call this yourself — to ask the user something, use request_user_input.',
    {
      tool_name: z.string().describe('Tool the CLI wants to run (Bash, Edit, WebFetch, …).'),
      input: z.unknown().optional().describe('The tool input as the CLI would run it.'),
      tool_use_id: z.string().optional(),
    },
    async ({ tool_name, input }) => {
      const provider = getActiveProvider();
      const summary = summarizeToolUse(tool_name, input);
      /**
       * A CLI permission prompt with nobody listening follows the away policy
       * rather than sitting open for five minutes (docs/36 §4). `deny` and
       * `skip` both answer no — the difference is what the agent is told to do
       * next — and neither ever silently allows.
       */
      const away = approvalPolicy(300_000);
      if (away.action !== 'ask') {
        log.info({ tool_name, action: away.action }, 'permission prompt answered by the away policy');
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                behavior: 'deny',
                message: away.message ?? 'The user is away.',
              }),
            },
          ],
        };
      }

      const { request_id, promise } = registerRequest((id) => {
        const req: PermissionRequest = {
          kind: 'permission',
          request_id: id,
          provider: provider.displayName,
          tool_name,
          summary,
          input: input ?? null,
        };
        void notifyPhone({ type: 'permission_request', ...req });
        return req;
      }, away.timeoutMs);
      void notifyPhone(
        narrationPayload({
          kind: 'permission',
          text: phrase('permission', { provider: provider.displayName, summary }),
          speak: shouldSpeakNarration('permission', { agentOwnsNarration: false }),
          data: { tool_name, summary },
        }),
      );
      log.info({ request_id, tool_name, summary: summary.slice(0, 120) }, 'permission prompt relayed to phone');

      const decision = (behavior: 'allow' | 'deny', message?: string) => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              behavior === 'allow'
                ? { behavior, updatedInput: input ?? {} }
                : { behavior, message: message ?? 'The user denied this action from their phone.' },
            ),
          },
        ],
      });

      try {
        const response = await promise;
        if (response.kind === 'permission') {
          log.info({ request_id, decision: response.decision }, 'permission prompt answered');
          return decision(response.decision, response.message);
        }
        if (response.kind === 'interrupted_by_voice_turn') {
          const spoken = classifySpokenDecision(response.user_turn);
          log.info({ request_id, spoken, text: response.user_turn.slice(0, 80) }, 'permission prompt answered by voice');
          if (spoken === 'allow') return decision('allow');
          return decision(
            'deny',
            spoken === 'deny'
              ? 'The user said no.'
              : `The user did not answer the permission prompt; they said: "${response.user_turn.slice(0, 200)}". Treat that as their new request.`,
          );
        }
        return decision('deny', 'Unexpected response to the permission prompt.');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ request_id, err: message }, 'permission prompt not answered');
        return decision('deny', `Nobody answered the permission prompt (${message}). Do not retry it.`);
      }
    },
  );

  server.tool(
    'submit_plan_for_approval',
    'Present a numbered plan to the user and wait for them to approve, reject, or request modifications. ' +
      'The PWA shows a structured plan card with step-by-step detail — a core hands-free UX feature. ' +
      'This tool BLOCKS until the user responds, a new voice/text turn arrives, or timeout_ms elapses. ' +
      'If the user speaks/types while waiting, returns { interrupted: true, user_turn } instead of a decision — treat that as the new request (do not proceed with the plan). ' +
      'Always use this before applying significant, multi-file, or irreversible changes. ' +
      'Speak first: tell the user the plan is on their phone and summarize it in one sentence, then call this tool.',
    {
      title: z.string().min(1).max(200).describe('Short title summarising the plan (e.g. "Refactor auth module").'),
      steps: z
        .array(z.string().min(1).max(500))
        .min(1)
        .max(20)
        .describe('Ordered list of concrete steps the agent will take.'),
      estimated_impact: z
        .string()
        .max(300)
        .optional()
        .describe('Optional short description of scope / risk (e.g. "Touches 4 files, no DB changes").'),
      timeout_ms: z
        .number()
        .int()
        .min(10_000)
        .max(600_000)
        .optional()
        .describe('How long to wait for a response (default 180 000 ms = 3 min).'),
    },
    async ({ title, steps, estimated_impact, timeout_ms }) => {
      const policy = approvalPolicy(timeout_ms ?? 180_000);
      if (policy.action !== 'ask') {
        return voiceToolResponse({
          decision: 'rejected',
          answered_by: 'away_policy',
          away: true,
          message: policy.message ?? undefined,
        });
      }
      const timeout = policy.timeoutMs;

      const { request_id, promise } = registerRequest((id) => {
        const req: PlanApprovalRequest = {
          kind: 'plan_approval',
          request_id: id,
          title,
          steps,
          estimated_impact,
        };
        void notifyPhone({ type: 'plan_approval_request', ...req });
        return req;
      }, timeout);

      log.info({ request_id, steps: steps.length }, 'submit_plan_for_approval: waiting for user');

      try {
        const response = await promise;
        if (response.kind === 'interrupted_by_voice_turn') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  interrupted: true,
                  request_id,
                  user_turn: response.user_turn,
                  is_interrupt: response.is_interrupt,
                  received_at: response.received_at,
                  source: response.source,
                  segments: response.segments,
                  stream_hint: response.stream_hint,
                  tts_interrupt: response.tts_interrupt ?? null,
                  pending_user_turns: 0,
                  message:
                    'User sent a new turn while this plan was awaiting approval. Do not execute the plan; act on user_turn.',
                }),
              },
            ],
          };
        }
        if (response.kind !== 'plan_approval') {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Unexpected response kind' }) }] };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                request_id,
                decision: response.decision,
                notes: response.notes ?? null,
              }),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: JSON.stringify({ request_id, error: message }) }] };
      }
    },
  );

  return server;
}

// ── Fastify route registration ────────────────────────────────────────────

/**
 * Per-connection transport map: Mcp-Session-Id → transport.
 * Stateful mode: one transport per Cursor session.
 */
const transports = new Map<string, StreamableHTTPServerTransport>();

function extractBearerToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return null;
}

function requireMcpAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const token = extractBearerToken(req);
  if (!verifyWsToken(token)) {
    void reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * Register the MCP Streamable HTTP routes on the Fastify instance.
 *
 * Protocol (Streamable HTTP):
 *   POST /mcp  (no session)    → initialize → responds with Mcp-Session-Id header
 *   GET  /mcp  (session header) → open SSE stream on the existing transport
 *   POST /mcp  (session header) → JSON-RPC tool calls on the existing transport
 *   DELETE /mcp (session header) → tear down session
 *
 * Every request requires Bearer token auth.
 */
export function registerMcpServer(app: FastifyInstance): void {
  // GET /mcp — open SSE stream on an already-initialized session.
  app.get('/mcp', async (req, reply) => {
    if (!requireMcpAuth(req, reply)) return;

    const sessionId = req.headers['mcp-session-id'];

    if (typeof sessionId !== 'string') {
      log.warn('mcp GET — missing Mcp-Session-Id header');
      void reply.code(400).send({
        error: 'Missing Mcp-Session-Id header. POST to /mcp first to initialize a session.',
      });
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      log.warn({ sessionId }, 'mcp GET — session not found');
      void reply.code(404).send({ error: `MCP session "${sessionId}" not found.` });
      return;
    }

    log.debug({ sessionId }, 'mcp GET — opening SSE stream');
    await transport.handleRequest(req.raw, reply.raw, undefined);
  });

  // POST /mcp — initialize (no session) or tool-call dispatch (with session).
  app.post(
    '/mcp',
    { config: { rawBody: true } },
    async (req, reply) => {
      if (!requireMcpAuth(req, reply)) return;

      const sessionId = req.headers['mcp-session-id'];

      if (typeof sessionId === 'string') {
        const transport = transports.get(sessionId);
        if (!transport) {
          log.warn({ sessionId }, 'mcp POST — session not found');
          void reply.code(404).send({ error: `MCP session "${sessionId}" not found.` });
          return;
        }
        await transport.handleRequest(req.raw, reply.raw, req.body);
        return;
      }

      // No session header → initialize new session.
      log.debug('mcp POST — initializing new session');
      const newId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newId,
      });

      transports.set(newId, transport);
      transport.onclose = () => {
        transports.delete(newId);
        closeAgentAudioOwner(newId);
        log.info({ sessionId: newId }, 'mcp session closed');
      };

      bindVoiceAgentMcpSession(newId);

      const mcpServer = buildMcpServer(newId);
      await mcpServer.connect(transport);
      log.info({ sessionId: newId }, 'mcp session initialized');

      await transport.handleRequest(req.raw, reply.raw, req.body);
    },
  );

  // DELETE /mcp — explicit session teardown.
  app.delete('/mcp', async (req, reply) => {
    if (!requireMcpAuth(req, reply)) return;

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const transport = transports.get(sessionId);
      if (transport) {
        await transport.close();
        transports.delete(sessionId);
        closeAgentAudioOwner(sessionId);
        log.info({ sessionId }, 'mcp session deleted');
      }
    }
    await reply.code(204).send();
  });

  log.info('mcp server registered at /mcp (50 tools)');
}
