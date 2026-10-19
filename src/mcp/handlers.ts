/**
 * MCP tool dispatch — the security boundary.
 *
 * Every tool call — whether from the control WebSocket (voice model forwarded
 * by the phone) or a future MCP transport — MUST pass through `dispatchTool`.
 *
 * Security enforcement per call (matching docs/03-security.md):
 *   1. Schema validation (zod) — unknown fields rejected.
 *   2. Project allowlist resolution — project name → registry path server-side.
 *   3. Tool handler execution.
 *   4. Audit log written for every call (result ok | rejected | error).
 *
 * Auth (step 0) is enforced upstream (HTTP preHandler / WS first-message).
 * This layer assumes the call is already authenticated.
 */

import { TOOL_SCHEMAS, canonicalToolName, type ToolName } from './schemas.js';
import { writeAudit } from '../state/db.js';
import { hashArgs } from '../log.js';
import { getSessionState } from '../state/registry.js';
import { childLogger } from '../log.js';

// Tool handlers
import { handleListProjects, handleSetProject, handleManageProjects } from './tools/project.js';
import { handleListModels, handleSetModel } from './tools/model.js';
import { handlePermissionMode } from './tools/permission.js';
import { handleCursorSubmit, handleCursorAsk } from './tools/execute.js';
import { handleCursorRecallAnswer } from './tools/recall.js';
import { handleCursorStatus, handleCursorStop } from './tools/job.js';
import { handleNewSession, handleSessionInfo } from './tools/session.js';
import { handleCursorDiff, handleCursorRevert } from './tools/gitTools.js';
import { handleCursorAgentInfo, handleCursorAgentStatus } from './tools/system.js';
import { handleMcpList, handleMcpTools } from './tools/mcpInspect.js';
import { handleShowMedia, handleMediaControl } from './server/displayToolHandlers.js';
import { handleShowImages } from './server/imageToolHandlers.js';
import { handleSendFiles } from './server/fileToolHandlers.js';

const log = childLogger('handlers');

// ── Dispatch ──────────────────────────────────────────────────────────────

export type ToolResult = unknown;

/**
 * Dispatch a tool call from name + raw args (unvalidated).
 * Returns the tool result or throws a user-facing Error.
 *
 * @param name       Tool name (must be in TOOL_SCHEMAS)
 * @param rawArgs    Unvalidated args object from the caller
 * @param sessionKey WS connection id (for session state lookup)
 */
export async function dispatchTool(
  name: string,
  rawArgs: unknown,
  sessionKey: string,
): Promise<ToolResult> {
  // ── 1. Tool allowlist (accepting pre-rename aliases) ───────────────────
  const toolName = canonicalToolName(name);
  if (!toolName) {
    writeAudit({ tool: name, result: 'rejected', reason: 'unknown tool' });
    throw new Error(`Unknown tool: "${name}"`);
  }
  if (toolName !== name) {
    log.debug({ called: name, canonical: toolName }, 'legacy tool name mapped');
  }

  // ── 2. Schema validation ───────────────────────────────────────────────
  const schema = TOOL_SCHEMAS[toolName];
  const parseResult = schema.safeParse(rawArgs ?? {});

  if (!parseResult.success) {
    const reason = parseResult.error.message;
    writeAudit({ tool: name, result: 'rejected', reason: `schema: ${reason}` });
    throw new Error(`Invalid args for ${name}: ${reason}`);
  }

  const args = parseResult.data;
  const argsHash = hashArgs(args);

  // ── 3. Get session state (for project + model resolution) ──────────────
  const session = getSessionState(sessionKey);
  const activeProject = session.activeProject;

  // ── 4. Dispatch to handler ─────────────────────────────────────────────
  let result: ToolResult;
  try {
    result = await route(toolName, args, sessionKey, activeProject);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    writeAudit({ tool: name, project: activeProject ?? undefined, args_hash: argsHash, result: 'error', reason });
    log.warn({ tool: name, err }, 'tool call error');
    throw err;
  }

  // ── 5. Audit ───────────────────────────────────────────────────────────
  writeAudit({ tool: name, project: activeProject ?? undefined, args_hash: argsHash, result: 'ok' });
  log.debug({ tool: name, project: activeProject }, 'tool call ok');

  return result;
}

// ── Route to specific handler ─────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArgs = any;

async function route(
  name: ToolName,
  args: Record<string, unknown>,
  sessionKey: string,
  activeProject: string | null,
): Promise<ToolResult> {
  // Args are zod-validated upstream — the cast to AnyArgs is intentional.
  const a = args as AnyArgs;

  switch (name) {
    case 'agent_list_projects':
      return handleListProjects(a, activeProject);
    case 'agent_set_project':
      return handleSetProject(a, sessionKey);
    case 'agent_manage_projects':
      return handleManageProjects(a);
    case 'agent_list_models':
      return handleListModels(a, getSessionState(sessionKey));
    case 'agent_set_model':
      return handleSetModel(a, sessionKey);
    case 'agent_permission_mode':
      return handlePermissionMode(a);
    case 'agent_submit':
      return handleCursorSubmit(a, sessionKey, activeProject);
    case 'agent_ask':
      return handleCursorAsk(a, sessionKey, activeProject);
    case 'agent_recall_answer':
      return handleCursorRecallAnswer(a, sessionKey);
    case 'agent_job_status':
      return handleCursorStatus(a, sessionKey);
    case 'agent_job_stop':
      return handleCursorStop(a, sessionKey);
    case 'agent_new_session':
      return handleNewSession(a, activeProject);
    case 'agent_session_info':
      return handleSessionInfo(a, activeProject);
    case 'agent_diff':
      return handleCursorDiff(a, activeProject);
    case 'agent_revert':
      return handleCursorRevert(a, activeProject);
    case 'agent_info':
      return handleCursorAgentInfo();
    case 'agent_status':
      return handleCursorAgentStatus();
    case 'agent_mcp_list':
      return handleMcpList();
    case 'agent_mcp_tools':
      return handleMcpTools(a);
    case 'show_images':
      return handleShowImages(a);
    case 'show_media':
      return handleShowMedia(a);
    case 'media_control':
      return handleMediaControl(a);
    case 'send_files':
      return handleSendFiles(a);
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unhandled tool: ${_exhaustive}`);
    }
  }
}
