# 11 — Complete MCP Tool Surface

All tools exposed by the Squeakr bridge MCP server. Organised into groups.
Every tool is defined once in zod — the same schema emits both the MCP
registration and the provider function-tool definition (DRY).

Verified against the live CLI (`cursor-agent 2026.06.04-5fd875e`, June 2026).

> **Total: 33 tools** — 3 voice I/O + 10 agent/job self-management + 2 user display +
> 17 cursor-agent wrappers + 2 user interaction (blocking) + 1 identity tool.
> All are registered in `src/mcp/server/index.ts` and callable by Cursor's conversational agent.

---

## MCP Server Tools (Cursor calls these to manage itself)

These are Cursor's self-management surface — tools the conversational voice agent
calls to orchestrate workers, observe the full agent ecosystem, and manage state.

### Group: Voice I/O

| Tool | Purpose |
| --- | --- |
| `speak(text)` | Convert text → TTS and push to PWA. One sentence per call. |
| `done()` | Signal turn end; re-arms the PWA mic. |
| `next_voice_turn(timeout_ms?)` | Long-poll dequeue of next user utterance. |

### Group: Identity

| Tool | Returns |
| --- | --- |
| `get_session_ref()` | voice_run_id, voice_session_id (cursor-agent resume ref), mcp_session_id, active_job_id, active_project, active_model, preferred_spawn_mode |

Use this to orient after a resume or when session state is unclear.

### Group: Agent Management

| Tool | Purpose |
| --- | --- |
| `list_agents()` | All running workers (singleton + worktree pool) + voice agent. Shows id, kind, pid, activity, elapsed, worktree. |
| `get_agent_status(id)` | Live detail: activity, files_written, files_read, shell_commands, elapsed_ms. Falls back to DB for completed jobs. |
| `get_agent_output(id, offset?, limit?)` | Paginated full event log (tool calls, file writes, shell runs, output text). In-memory for live; DB for completed. |
| `spawn_agent(instructions, mode?, use_worktree?, worktree_name?, browser?)` | Start a worker. Modes: agent/plan/ask/debug. `browser: true` appends snapshot workflow for UI tasks. `use_worktree: true` runs in isolated git worktree for parallel execution. |
| `stop_agent(id)` | SIGTERM → SIGKILL a worker (singleton or worktree). |
| `send_to_session(handle, message, confirm?)` | Relay a message into a running or past session. Reports how it was delivered — `live`, `mailbox_pending`, `fork`, `resume` or `refused` — and the agent must say which. See [`37`](./37-session-directory-and-inject.md). |
| `list_sessions(scope?)` | Every session the user could mean: the voice agent, bridge workers, past conversations from each CLI's own store, and live sessions they started themselves. |
| `check_messages(session?)` | Collect messages sent into your own session while you were working. |
| `inject(id, message)` | Deprecated alias for `send_to_session`. It used to write to a stdin the agent process does not have, so it never delivered anything. |
| `revert_agent(id, confirm?)` | Revert project to the git checkpoint taken before job `id` ran. Uncommitted → stash; committed → reset --hard (requires confirm: true). |

**Parallel agents**: `spawn_agent` with `use_worktree: true` creates an isolated git worktree
(`~/.cursor/worktrees/<name>`) so multiple agents can code concurrently without working-tree
conflicts. Each gets a unique name; `list_agents` shows all. This is Cursor's native
Parallel Agents capability exposed via voice.

### Group: Job History

| Tool | Purpose |
| --- | --- |
| `list_jobs_history(project?, limit?, status_filter?)` | Recent jobs for the active project. Returns id, mode, prompt, status, files_changed, summary, error, timing, checkpoint. Use to find job IDs for revert_agent. |

### Group: Mode Control

| Tool | Purpose |
| --- | --- |
| `set_mode(id?, mode)` | Store preferred spawn mode for this session (agent/plan/ask/debug). Applied to next `spawn_agent`. Does NOT restart running agents. |
| `execute_plan(id)` | Trigger plan execution: submits a follow-up that applies the proposed plan. |

### Group: User interaction (blocking)

| Tool | Purpose |
| --- | --- |
| `request_user_input(question, input_type, options?)` | Ask user a question; blocks until answered **or** a new voice/text turn arrives (`interrupted: true`). |
| `submit_plan_for_approval(title, steps, estimated_impact?)` | Show plan card; blocks until approve/reject/modify **or** a new turn (`interrupted: true`). |

### Group: User display (non-blocking)

| Tool | Purpose |
| --- | --- |
| `show_images(images, duration_ms?, caption?)` | Push image carousel to PWA. New batch replaces old. See [`18-image-carousel.md`](./18-image-carousel.md). |

### Group: Audio out (non-blocking)

The agent's own audio — files or raw PCM packets — played to the user. See [`47-agent-audio-streams.md`](./47-agent-audio-streams.md).

| Tool | Purpose |
| --- | --- |
| `audio_stream_open(label?, mode?, volume?, format?, log?, path \| url \| data?, close?)` | Open a stream: `queue` (in line with speech) or `async` (plays at once, speech goes over it). With a file and `close: true` it plays a one-shot in one call. |
| `audio_stream_write(stream_id, path \| url \| data \| packet)` | Append a file or a raw PCM packet. Writes play in call order. |
| `audio_stream_close(stream_ids? \| all, drain?)` | Close several or all of your streams at once; drain or stop. |
| `audio_stream_list(include_closed?, include_log?)` | Your streams and what each listener reports. |
| `audio_stream_log(stream_ids, note?)` | Read stream logs; add a note. |

---

---

## Tool groups

| Group | Tools | Source |
| --- | --- | --- |
| **Project** | `agent_list_projects`, `agent_set_project` | Custom (registry) |
| **Model** | `agent_list_models`, `agent_set_model` | CLI: `cursor-agent models` |
| **Execute** | `agent_submit`, `agent_ask`, `agent_recall_answer` | CLI: `-p --output-format stream-json/json` (`agent_submit` accepts optional `browser`) |
| **Job** | `agent_job_status`, `agent_job_stop` | Bridge state (DB) |
| **Session** | `agent_new_session`, `agent_session_info` | CLI: `create-chat`, registry |
| **Git** | `agent_diff`, `agent_revert` | `simple-git` |
| **System** | `agent_info`, `agent_status` | CLI: `about --format json`, `status --format json` |
| **MCP inspect** | `agent_mcp_list`, `agent_mcp_tools` | CLI: `mcp list`, `mcp list-tools` |

---

## Group: Project (custom — registry)

### `agent_list_projects`
```
args:  { query?: string }
returns: { projects: [{ name, description, aliases, enabled, active }] }
```
Lists all enabled projects from the `config.json` registry. Optional `query`
filters server-side (fuzzy contains on `name`, `aliases`, `description`).
Used for discovery ("what can I work on?"), search, and disambiguation.
The web-app dropdown uses `GET /api/projects` (same data, REST version).

### `agent_set_project`
```
args:  { project: string }
returns: { active_project, description, path_hash }  // never the real path
```
Sets the sticky active project for the session. Validates `project` against the
registry. The bridge speaks the project description back ("now working on
**budget** — the finance tracker") so a mishear is caught before any edits.
Also available via `POST /api/active-project` from the web-app dropdown.

---

## Group: Model (CLI: `cursor-agent models`)

### `agent_list_models`
```
args:  { query?: string }
returns: { models: [{ id, displayName }], active_model, cached_at }
```
Returns all models from the cached `model_cache` table (populated by
`cursor-agent models` on startup and on TTL expiry). Optional `query` filters by
case-insensitive contains on `id` or `displayName` ("claude", "thinking",
"fast", etc.). Refreshes cache automatically on TTL miss.

> **CLI note:** `cursor-agent models` (or `--list-models`) outputs plain text,
> one line per model, format `<id> - <displayName>`. No JSON output available.
> No native filter flag — bridge parses and filters in-process.
> The tip line (`Tip: use --model ...`) and header (`Available models`) are stripped.

### `agent_set_model`
```
args:  { model_id: string }
returns: { active_model, displayName }
```
Sets `session_state.active_model`. Validated against the model cache (must be a
known ID). Default session value is `"auto"` (Cursor uses the account default).
Fuzzy-match on displayName is done before the tool is called (by the voice model
from `agent_list_models` results); the tool receives the exact ID.

---

## Group: Execute (CLI: `cursor-agent -p`)

### `agent_submit`
```
args:  { prompt: string, project?: string, mode?: "agent" | "plan" }
returns: { job_id, session_id, status, project, model }
```
Submits work to cursor-agent. Returns immediately with a `job_id`; track
progress via `agent_job_status`. Applies `session_state.active_project`,
`session_state.active_model`, and `config.preRunFlags`. Resumes the project's
existing session via `--resume` if a `resume_id` is stored.

CLI equivalent:
```
cursor-agent -p --output-format stream-json
  --workspace <registry path>
  --model <session.active_model>
  --resume <project.resume_id>    # if set
  [--mode plan]
  --force --trust                 # from preRunFlags
  "<prompt>"
```

> **Note:** Prompt text is prepended with the standing instruction to proceed
> without asking questions (steering, not a flag). See `05`.

### `agent_ask`
```
args:  { question: string, project?: string }
returns: { answer: string, has_more: boolean }
```
Read-only repo Q&A. Hard-coded `--mode ask` — cannot write or run mutating
commands regardless of `preRunFlags`. One-shot (no `--resume`); does not pollute
the work session. The voice model's **only** route to repo facts. Long answers
are truncated for voice; full text is cached for `agent_recall_answer`.

### `agent_recall_answer`
```
args:  { format?: "brief" | "full" }
returns: { question, answer, project, completed_at, has_more? }
```
Returns the last `agent_ask` result without re-spawning cursor-agent. Use for
summarize / repeat / expand follow-ups.

CLI equivalent:
```
cursor-agent -p --output-format json
  --workspace <registry path>
  --model <session.active_model>
  --mode ask
  --force --trust                 # harmless in ask mode
  "<question>"
```

---

## Group: Job (bridge state — SQLite)

### `agent_job_status`
```
args:  { job_id: string }
returns: { status, progress: [{ ts, kind, text }], summary?, diffstat?, session_id, project, model }
```
Poll a running or completed job. `status ∈ running | done | error | stopped`.
Progress is the streamed event log. Used for voice narration ("still working…")
and final result retrieval.

### `agent_job_stop`
```
args:  { job_id: string }
returns: { status: "stopped" }
```
SIGTERM → SIGKILL the cursor-agent process for a **agent_submit** job only.
Does not cancel in-flight `agent_ask` questions — those must finish naturally.
Updates job status.

---

## Group: Session (CLI: `create-chat` + registry)

### `agent_new_session`
```
args:  { project?: string }
returns: { session_id, project }
```
Clears the project's stored `resume_id` so the next `agent_submit` starts a
fresh thread. Optionally calls `cursor-agent create-chat` to pre-create a session
ID before any prompt.

> **CLI note:** `cursor-agent ls` requires an interactive TTY (raw mode) and
> **cannot be used headlessly**. Session IDs are captured from `agent_submit`
> output (the `session_id` field on `system:init` and `result` events) and
> persisted to the registry — the bridge is the source of truth for resume IDs.

### `agent_session_info`
```
args:  { project?: string }
returns: { project, resume_id, last_job_id, last_run_at }
```
Read the persisted session state for a project — useful for the voice model to
narrate "you were last working on budget 20 minutes ago" without running the CLI.

---

## Group: Git (`simple-git`)

### `agent_diff`
```
args:  { project?: string, full_patch?: boolean }
returns: { diffstat: string, patch?: string, clean: boolean }
```
Current uncommitted diff for the project workspace. `diffstat` is always
returned (file summary); `full_patch` also returns the raw diff text. Used by the
voice model to describe what changed.

### `agent_revert`
```
args:  { project?: string, confirm?: boolean }
returns: { reverted_to: string, files: string[], method: "stash" | "reset_hard" }
```
Git-level undo. Restores the pre-job checkpoint recorded by `agent_submit`.
- Uncommitted changes → `git stash` (safe, reversible).
- Agent-committed changes → `git reset --hard <checkpoint>` (destructive;
  requires `confirm: true`).
The voice model asks for confirmation before calling with `confirm: true`.

---

## Group: System (CLI: `about`, `status`)

### `agent_info`
```
args:  (none)
returns: { cliVersion, model, osPlatform, osArch, shell }
```
Wraps `cursor-agent about --format json`. Used in the health check and by the
voice model if dad asks "what version is Cursor?".

CLI output (JSON):
```json
{
  "cliVersion": "2026.06.04-5fd875e",
  "model": "Composer 2.5 Fast",
  "subscriptionTier": null,
  "osPlatform": "linux",
  "osArch": "x64",
  "userEmail": null
}
```

### `agent_status`
```
args:  (none)
returns: { authenticated, email?, firstName? }
```
Wraps `cursor-agent status --format json`. Health check: confirm the service user
is authenticated before accepting jobs.

CLI output (JSON):
```json
{
  "status": "authenticated",
  "isAuthenticated": true,
  "userInfo": { "email": "...", "firstName": "..." }
}
```

---

## Group: MCP inspect (CLI: `mcp list`, `mcp list-tools`)

These are informational — useful for debugging the executor's own MCP config.

### `agent_mcp_list`
```
args:  (none)
returns: { servers: [{ name, status }] }
```
Wraps `cursor-agent mcp list`. Lists MCP servers configured in
`.cursor/mcp.json` and their load status. Not related to Squeakr's own MCP
server — this is about MCPs the executor agent itself may use.

CLI output: plain text (`<name>: <status>`), parsed by the bridge.

### `agent_mcp_tools`
```
args:  { server: string }
returns: { tools: [{ name, args }] }
```
Wraps `cursor-agent mcp list-tools <identifier>`. Lists tools for a given
executor MCP server. Informational; used for debugging.

---

## CLI commands NOT ported (and why)

| Command | Why not ported |
| --- | --- |
| `cursor-agent ls` | **Requires interactive TTY** (raw mode error headlessly). Session IDs are captured from `agent_submit` output instead. |
| `cursor-agent resume` (interactive) | Interactive TTY only. Resume is handled by the bridge via `--resume` flag on `agent_submit`. |
| `cursor-agent login` / `logout` | Operator-only setup via SSH/iSH; not part of the voice flow. |
| `cursor-agent update` | Never auto-update the service. Manual only. |
| `cursor-agent worker start` | Cloud worker feature; Squeakr uses local `cursor-agent -p`. |
| `cursor-agent generate-rule` | Interactive TTY only. |
| `cursor-agent install-shell-integration` | Setup only. |
| `cursor-agent acp` | Evaluated and deliberately rejected in favour of `--print`; see ADR-017 in `08`. |

---

## Complete tool inventory (all 30 tools)

### MCP Server tools (Cursor's self-management surface)

| # | Tool | Group | Backed by |
| --- | --- | --- | --- |
| 1 | `speak` | Voice I/O | PWA TTS broadcast |
| 2 | `done` | Voice I/O | PWA mic re-arm broadcast |
| 3 | `next_voice_turn` | Voice I/O | `VoiceTurnQueue` long-poll |
| 4 | `get_session_ref` | Identity | `voiceAgent.ts` + `agentSingleton.ts` + registry |
| 5 | `list_agents` | Agents | `agentSingleton.ts` + `jobManager.ts` + `voiceAgent.ts` |
| 6 | `get_agent_status` | Agents | `agentSingleton.ts` (live) + DB (completed) |
| 7 | `get_agent_output` | Agents | Watcher in-memory buffer (live) + DB job_events (completed) |
| 8 | `spawn_agent` | Agents | `jobManager.submitJob` + optional worktree |
| 9 | `stop_agent` | Agents | `agentSingleton.killActiveAgent` / `killWorktreeAgent` |
| 10 | `send_to_session` | Sessions | per-session mailbox / voice turn queue / fork (`inject` is a deprecated alias) |
| 11 | `revert_agent` | Agents | `git.revert` via job checkpoint from DB |
| 12 | `list_jobs_history` | Jobs | DB (`job` table) |
| 13 | `set_mode` | Mode | Session-scoped `preferredModeMap` |
| 14 | `execute_plan` | Mode | `dispatchTool('agent_submit', ...)` |

### cursor-agent wrapper tools (exposed to Cursor via MCP — same as dispatchTool surface)

| # | Tool | Group | Backed by |
| --- | --- | --- | --- |
| 15 | `agent_list_projects` | Project | Registry (custom) |
| 16 | `agent_set_project` | Project | Registry (custom) |
| 17 | `agent_list_models` | Model | CLI: `cursor-agent models` |
| 18 | `agent_set_model` | Model | State (DB) |
| 19 | `agent_submit` | Execute | CLI: `-p --output-format stream-json` |
| 20 | `agent_ask` | Execute | CLI: `-p --output-format json --mode ask` |
| 21 | `agent_recall_answer` | Execute | Bridge cache (last ask) |
| 22 | `agent_job_status` | Job | DB (job rows + watcher events) |
| 23 | `agent_job_stop` | Job | `process.kill` → SIGTERM/SIGKILL |
| 24 | `agent_new_session` | Session | DB clear + CLI: `create-chat` |
| 25 | `agent_session_info` | Session | DB |
| 26 | `agent_diff` | Git | simple-git |
| 27 | `agent_revert` | Git | simple-git |
| 28 | `agent_info` | System | CLI: `about --format json` |
| 29 | `agent_status` | System | CLI: `status --format json` |
| 30 | `agent_mcp_list` | MCP inspect | CLI: `mcp list` |
| 31 | `agent_mcp_tools` | MCP inspect | CLI: `mcp list-tools` |

> Tools 15–31 are also accessible via the control WebSocket (`dispatchTool`) for the
> `llm_intelligence` workflow. Tools 1–14 are MCP-server-only (Cursor's self-management surface).

---

## Source module layout

```
src/mcp/
├── server/
│   ├── index.ts              # MCP Streamable HTTP server — registers all 30 tools
│   ├── voiceToolHandlers.ts  # speak, done, next_voice_turn
│   ├── agentToolHandlers.ts  # get_session_ref, list_agents, get_agent_status,
│   │                         # get_agent_output, spawn_agent, stop_agent,
│   │                         # inject, revert_agent, list_jobs_history,
│   │                         # set_mode, execute_plan
│   └── turnQueue.ts          # VoiceTurnQueue long-poll bridge
├── tools/
│   ├── project.ts            # agent_list_projects, agent_set_project
│   ├── model.ts              # agent_list_models, agent_set_model
│   ├── execute.ts            # agent_submit, agent_ask
│   ├── job.ts                # agent_job_status, agent_job_stop
│   ├── session.ts            # agent_new_session, agent_session_info
│   ├── gitTools.ts           # agent_diff, agent_revert
│   ├── system.ts             # agent_info, agent_status
│   └── mcpInspect.ts         # agent_mcp_list, agent_mcp_tools
├── schemas.ts                # zod schemas for dispatchTool tools (17 tools)
├── handlers.ts               # dispatchTool security boundary
└── functionTools.ts          # generates provider function-tool defs from schemas

src/executor/
├── agentProcess.ts       # spawn (supports --worktree, --mode plan|ask|debug)
├── agentSingleton.ts    # singleton + worktree worker pool, getAllActiveRuns()
├── jobManager.ts        # submitJob (worktree), getAllActiveJobSummaries(), getJobsHistory()
├── watcher.ts           # stream-json event classifier → NarrationEvents
├── narrator.ts          # NarrationEvents → inject into realtime session
└── git.ts               # simple-git: diff, revert, checkpoint
```
