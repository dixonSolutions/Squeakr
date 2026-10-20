# 03 — Security Model

> Project rule: **security must be enforced at the API level** — not merely
> filtered/disabled in the frontend. Every control below is enforced server-side
> on the bridge.

## Trust boundaries

| Boundary | Trusted? | Enforcement |
| --- | --- | --- |
| Tailnet network | Partially | Tailscale ACLs; device must be on the tailnet |
| Phone PWA → bridge | **Not trusted** | App token required on every HTTP + WS message; args re-validated |
| Phone → provider (WebRTC) | n/a (audio) | Ephemeral token only; no API key on device |
| Provider → tools | Constrained | Only the 6 MCP tools; provider can't reach the bridge directly (default design) |
| Bridge → cursor-agent | Controlled | Fixed flags + `--workspace` from allowlist registry |
| cursor-agent → filesystem | Bounded | Only allowlisted project workspaces; git revert as undo |

**Do not rely on Tailscale alone.** Tailscale is network-layer auth; we *also*
require an application-layer secret so that a compromised/misconfigured tailnet
device cannot drive the agent.

## The single app token

- A high-entropy shared secret (e.g., 32 random bytes, base64url) stored in
  `.env` on the bridge and entered once into the PWA (saved to
  `localStorage`/Home-Screen app).
- Sent as `Authorization: Bearer <token>` on every `/api/*` request and as the
  first message (or `Sec-WebSocket-Protocol`/query param validated server-side)
  on the control WebSocket.
- **Verified on the server for every request and every WS frame** that triggers
  an action. Constant-time comparison. No token → 401 and the socket is closed.
- Rotatable by changing `.env` + re-pasting in the PWA.

> Single-user scope (confirmed). If multi-user is ever needed, replace the shared
> secret with per-user tokens + an identity column on sessions (see `07`).

## The MCP layer is the safety boundary

This is the core safety design (per your guidance: *"this is an MCP wrapper, it
is not unlimited shell access"*). The voice model's entire capability is the
small, fixed tool set (the project tools + the execute/status/git tools). It
**cannot** run arbitrary shell, read arbitrary files, or point the agent at
arbitrary paths.

Enforcement per tool call:

1. **AuthN** — valid app token, else reject.
2. **Tool allowlist** — only the registered tools are dispatchable.
3. **Schema validation** — args validated against zod schemas; unknown/extra
   fields rejected; types coerced safely.
4. **Project allowlist (registry)** — `project` must resolve to a known entry in
   the project registry. The workspace path passed to `cursor-agent` comes from
   the **registry**, never from the caller. No path traversal, no arbitrary dirs.
5. **Fixed flag construction** — flags are assembled in code, not interpolated
   from model output. The only model-controlled value reaching the CLI is the
   **prompt string**, passed as a single argv element (no shell string
   interpolation; spawn with an args array, `shell: false`).
6. **Audit** — every tool call (who/what/when/project/result) written to the
   SQLite audit log.

### Project endpoints leak no paths

The web-app dropdown and voice agent both choose from the registry, but neither
ever receives filesystem paths:

- `GET /api/projects` returns **names + descriptions (+ aliases) only** — never
  `path`. The frontend list is a convenience, not an authority.
- `POST /api/active-project` and every tool accept a **name**; the bridge
  resolves it to a path via the registry server-side.
- The registry itself is **operator-controlled** (`config.json`, edited over SSH)
  — dad/voice can *select* projects but can never *register* or repath them.
- Secrets are isolated in `.env` (keys only); settings + project list live in
  non-secret `config.json` (see `07`).

### Shown media (`show_media`, `show_images`)

Images, video and audio the agent shows are served through
`GET /api/display/:id?k=<item-key>` — **not** the long-lived app token, because
`<img>` / `<video>` cannot send `Authorization` headers.

1. **Per-item key** — every item gets its own random UUID key, valid until the item
   self-destructs (default 30 min, agent-chosen 5 s – 24 h), is removed, or the voice
   session ends (`"never"` items included). Missing/wrong keys get 401/404.
2. **Path allowlist** — `path` items must resolve under enabled project directories,
   OS temp, `~/.cursor`, bridge `data/`, or the uploads folder beside the database
   (`<dirname(DB_PATH)>/media`). Both sides are compared as **real paths**,
   so `../` traversal and symlinks pointing out of a root are refused; the check is
   repeated on every request.
3. **No persistent URLs** — keys are in-memory only; a bridge restart drops them.
4. **Size limits** — 10 items per call, 50 shown at once, 4 MB decoded per base64 item.
   Files stream from disk (Range requests), never read whole into memory.

Full design: [`48-show-media.md`](./48-show-media.md).

### Why the prompt string is acceptable model-controlled input

`cursor-agent` interprets the prompt as a task, not as host shell. We never build
a shell command from it (`shell: false`, args array). The agent's own actions are
bounded by the workspace and recoverable via git. Optional hardening:
`--sandbox enabled` and/or **plan-mode-first** (`--mode plan`) so `agent_submit`
returns a *proposed plan* the model can confirm with the user before a second
apply call.

## Rejected alternative: remote-MCP-by-URL

The GA Realtime API can call a remote MCP server **by URL** (provider's servers →
your MCP endpoint), which would keep tool calls off the phone entirely. We
**reject this as the default** because it requires exposing the bridge's MCP
endpoint to the public internet (Tailscale **Funnel**), enlarging the attack
surface of a home machine. The chosen design keeps the bridge reachable **only**
from the tailnet, with the authenticated phone as the relay. (If ultra-low
tool-call latency ever justifies it, it can be enabled behind Funnel + a
per-request secret header + IP allowlisting — documented as an opt-in, not the
default.)

## cursor-agent execution hardening

- Run as a **dedicated, least-privileged OS user** that only owns the project
  workspaces — not as root, not as your primary user.
- `spawn(cmd, argsArray, { shell: false, cwd: registryPath })`.
- Resource guards: per-job timeout, max concurrent jobs, kill-on-stop
  (`agent_job_stop`), reap zombies.
- `--trust` is scoped to the allowlisted workspace only.
- Pin the CLI version; the CLI is beta and flags may change.

### Auto-run with a deny list (defense in depth)

The voice flow runs `cursor-agent` with `--force --trust` so it never stalls
(headless mode is non-blocking — see `05`). To keep auto-run from meaning
"anything goes", we rely on `--force` honoring the **`deny` list**: *"force allow
commands unless explicitly denied."*

- Provision CLI permissions (`~/.cursor/cli-config.json` for the service user,
  and/or `<workspace>/.cursor/cli.json` per project) with a **deny list** for
  destructive/sensitive operations: `Shell(rm)`, `Shell(sudo)`, `Shell(git:push*)`,
  `Read(.env*)`, `Write(**/*.key)`, `Write(**/*.pem)`, etc. Deny beats allow.
- This blocks the worst outcomes **even though the agent auto-runs**, which
  directly serves the "enforce security at the boundary" rule.
- Optional `--sandbox enabled` adds OS-level filesystem/network boundaries;
  non-sandboxable commands fail (the agent reacts) rather than prompting.
- These permission files are **operator-provisioned** at deploy time and treated
  as security configuration (version-controlled as examples; see `07`). The
  voice model and dad cannot edit them.
- Note this is a *second* layer: the primary boundary is still the constrained
  MCP tool surface + project allowlist. The deny list bounds what the agent can
  do *inside* an allowlisted workspace once a valid `agent_submit` is running.

### `agent_ask` is read-only by construction

The voice model has **no direct repo access**; its only context path is
`agent_ask`, which the bridge runs **exclusively in `--mode ask`** (read-only
exploration — searches/reads, never edits or runs mutating commands). The handler
hard-codes ask mode; the model cannot escalate a `agent_ask` into a writing run.
Still subject to the same project allowlist (resolves `project → path`) and audit
logging. This lets the "dumb" voice model gather grounded context without
widening the write surface.

## Secrets & data hygiene

- `.env` perms `600`, owned by the service user, **never committed** (`.env` in
  `.gitignore`; commit `.env.example`).
- Provider API key lives **only** on the bridge; the browser receives ephemeral
  tokens with the shortest viable TTL.
- Don't log full prompts/results at info level if they may contain sensitive
  project content; audit log is access-controlled on the host.
- TLS: provided by `tailscale serve`; no self-signed cert handling in app code.

## Threat checklist (quick)

| Threat | Mitigation |
| --- | --- |
| Stolen tailnet device | App token still required + token rotation |
| Token leak | Rotate via `.env`; short ephemeral provider TTL limits provider abuse |
| Path traversal / arbitrary workspace | Registry allowlist; runtime path from registry only (admin may register any absolute host path) |
| Shell injection via prompt | `shell:false` + args array; prompt is a task, not a command |
| Destructive but valid agent action | `agent_revert` (git); optional plan-mode-first |
| Runaway/zombie agent process | Timeouts, concurrency cap, `agent_job_stop`, reaping |
| Public exposure | No Funnel by default; tailnet-only |
