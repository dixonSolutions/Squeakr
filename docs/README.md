# Squeakr — Documentation

Voice-controlled coding agent: speak from an iPhone PWA, the active agent CLI
(Cursor / Codex / Claude Code) reasons with full project context, and a constrained
MCP tool layer drives worker agents on projects hosted on a home machine.

> Status: **Implemented.** This folder is the source of truth for architecture and
> behavior. Update these docs when the codebase changes (see `08-decisions-and-risks.md`).

## How to read these docs

| Doc | What it covers | Read it when |
| --- | --- | --- |
| [`01-critical-analysis.md`](./01-critical-analysis.md) | Feasibility critique of the original proposal | You want historical context on design tradeoffs |
| [`02-architecture.md`](./02-architecture.md) | System architecture, data flow, components | You want the big picture |
| [`03-security.md`](./03-security.md) | Trust boundaries, app token, API-level enforcement | Before writing networked/tool code |
| [`04-implementation-plan.md`](./04-implementation-plan.md) | Phased milestones and acceptance criteria | Tracking what's done vs planned |
| [`05-mcp-and-cursor-agent.md`](./05-mcp-and-cursor-agent.md) | MCP tool contracts and `cursor-agent` CLI integration | Implementing the executor layer |
| [`06-voice-audio-webrtc.md`](./06-voice-audio-webrtc.md) | STT/TTS, Vosk wake words, Silero VAD, `/ws/intelligence` | Implementing the phone/voice layer |
| [`07-data-and-deployment.md`](./07-data-and-deployment.md) | SQLite, project registry, Tailscale, deployment | Persistence and shipping |
| [`08-decisions-and-risks.md`](./08-decisions-and-risks.md) | Decision log (ADR-style) | You're unsure why something is the way it is |
| [`09-competitive-landscape.md`](./09-competitive-landscape.md) | Similar projects and recommendations | Build vs buy evaluation |
| [`10-cursor-cli-reference.md`](./10-cursor-cli-reference.md) | Cursor CLI reference | Debugging CLI interaction |
| [`11-mcp-tool-surface.md`](./11-mcp-tool-surface.md) | Full MCP tool inventory | Implementing the MCP server |
| [`12-stream-json-watcher.md`](./12-stream-json-watcher.md) | Stream-JSON watcher and narrator | Executor + progress narration |
| [`13-voice-providers.md`](./13-voice-providers.md) | Wake words, turn submit, AWS IAM for Polly/Transcribe | Configuring voice I/O |
| [`14-prompts.md`](./14-prompts.md) | Prompts folder layout and editing | Tuning agent behavior |
| [`15-llm-intelligence-workflow.md`](./15-llm-intelligence-workflow.md) | Alternate cascade workflow (STT→Claude→TTS) | Using Bedrock orchestrator mode |
| [`16-mcp-server-agent-as-brain.md`](./16-mcp-server-agent-as-brain.md) | **Default** `agent_native` workflow — Cursor as reasoning layer | Primary voice path |
| [`17-tts-barge-in-and-wake-echo.md`](./17-tts-barge-in-and-wake-echo.md) | TTS interrupt snapshot, `tts_interrupt` delivery, wake-word echo filter | Barge-in bugs or agent heard/not-heard context |
| [`18-image-carousel.md`](./18-image-carousel.md) | `show_images` tool, carousel PWA, Browser snapshot workflow | UI review on phone |
| [`19-mobile-session-keepalive.md`](./19-mobile-session-keepalive.md) | Wake Lock (PWA only), silent media, auto-resume; why native battery ≠ a phone call | Screen-off disconnects; iPhone battery drain |
| [`20-native-callkit-shell.md`](./20-native-callkit-shell.md) | CallKit native app + push notifications | True call-style session + background alerts |
| [`21-serve-self-hosting.md`](./21-serve-self-hosting.md) | Serve hub: health, live journalctl, restart script, origin rebase | Self-hosting from Config tab |
| [`22-split-host-tunnel.md`](./22-split-host-tunnel.md) | Incus container hosting + optional SSH tunnel for Tailscale Serve | Container DNS / tunnel 502 |
| [`23-multi-agent-client.md`](./23-multi-agent-client.md) | Cursor / Codex / Claude Code CLI install, invocation flags, execution modes, MCP registration | Installing or switching agent clients |
| [`24-agent-providers.md`](./24-agent-providers.md) | `AgentProvider` abstraction: phone-driven auth, live model selection, generic MCP aliases | In-app sign-in, model picker, or adding a 4th CLI |
| [`25-hosting-providers.md`](./25-hosting-providers.md) | `HostingProvider` abstraction: Tailscale, Cloudflare, ngrok, Dev Tunnels, LAN, local, manual | Choosing/switching how the bridge is exposed |
| [`26-rename-agentvoice.md`](./26-rename-agentvoice.md) | Product rename from Cursor Voice → AgentVoice (what changed / what stayed) | Migrating an existing install after the rename |
| [`27-touch-controls-and-cancel.md`](./27-touch-controls-and-cancel.md) | On-screen Speak / Cancel, cancel-while-processing, touch-only preset | Mute UX, no wake words, or cancel during Transcribe |
| [`28-provider-parity-and-branding.md`](./28-provider-parity-and-branding.md) | Normalized agent events, per-provider MCP registration and modes, the Squeakr interrupt hook, `agent_*` tool names, one branding source | Anything Codex/Claude Code behaves differently from Cursor, or naming/theme questions |
| [`29-speech-to-text-providers.md`](./29-speech-to-text-providers.md) | Speech-to-text providers: self-hosted Whisper (Docker/Podman), Groq, OpenAI, Deepgram, Gemini, ElevenLabs, OpenRouter, Amazon Transcribe | Choosing a transcription engine, adding API keys from the app, or running STT locally |
| [`30-speech-output-providers.md`](./30-speech-output-providers.md) | Text-to-speech providers, per-vendor scopes, and language-aware fallback across device and cloud voices | The agent has to speak a language the device has no voice for, or you want a different voice |
| [`31-service-orchestrator-converter.md`](./31-service-orchestrator-converter.md) | The Service / Orchestrator / Converter / Specializer layering shared by speech in, speech out, and (pending) the agent CLIs | Adding a provider or a selection policy, or working out where vendor knowledge belongs |
| [`32-environments-vs-projects.md`](./32-environments-vs-projects.md) | Why "run the agent elsewhere" (remote / cloud) collides with the path-based project registry, and the order to add it in | Issue #40, or before touching `projects[].path` |
| [`33-permissions-and-prompt-relay.md`](./33-permissions-and-prompt-relay.md) | Per-CLI permission modes (run-everything default), Claude Code prompts relayed to the phone, and sudo / git / ssh askpass relay | Changing how much the agent may do unasked, or a prompt is stuck on the host |
| [`36-disconnect-and-background-work.md`](./36-disconnect-and-background-work.md) | Design: what happens to sessions when the phone or bridge goes away — presence, away policy, unattended work, surviving a bridge restart | Changing disconnect behaviour, autonomy, or restart handling |
| [`37-session-directory-and-inject.md`](./37-session-directory-and-inject.md) | Design: listing bridge, past and external agent sessions, and sending messages into them by voice (mailbox, resume, fork — never TTY) | Touching `inject`, session ids, or multi-session voice |
| [`38-system-packages.md`](./38-system-packages.md) | Design: .deb / .rpm packaging, a `system` install mode, and the npm fixes it depends on | Packaging, install modes, or the update path |
| [`39-config-ui-and-narration-cleanup.md`](./39-config-ui-and-narration-cleanup.md) | Audit of the settings screen and every hardcoded bridge narration line, with the toggles + templates design | Editing the config tab or anything the bridge speaks on its own |
| [`40-prompts-orb-and-permissions.md`](./40-prompts-orb-and-permissions.md) | Reading question and plan cards aloud, why the ask tools stay (and which of the 37 tools overlap), a working state on the orb, and remembering mic / audio permissions | Touching the approval panel, the MCP tool surface, the orb, or microphone capture |
| [`41-audio-stream-pipe.md`](./41-audio-stream-pipe.md) | Direct audio stream input: the phone's stream mode, `squeakr pipe`, segmentation, the `/ws/audio-stream` protocol | Hands-free input, talking to the agent from a terminal, or why turns are still recommended |
| [`42-logging.md`](./42-logging.md) | Date-named session logs, voice transcripts, gzip rollover and retention, `squeakr logs` | Finding what the bridge did or what was said, log disk use, crash forensics |
| [`43-package-repos.md`](./43-package-repos.md) | Signed apt/dnf repositories on GitHub Pages: setup, signing key, rotation, user install | Package repos, signing key, release publishing |
| [`44-channels.md`](./44-channels.md) | Discord / Telegram / Slack / WhatsApp as remote access: Discord voice calls, voice messages, the `@Squeakr` command line, default sessions per conversation, platform research, Bedrock S2S answer | Channels, #93 |
| [`45-rename-squeakr.md`](./45-rename-squeakr.md) | AgentVoice → Squeakr: everything renamed, what an old install keeps reading, `scripts/migrate-to-squeakr.sh` and `squeakr upgrade-from-agentvoice` for npm / .deb / .rpm / clones, the final 0.1.6 hand-over and the release order | Upgrading an AgentVoice install, releasing the rename |
| [`46-media-pipe.md`](./46-media-pipe.md) | Images, video and voice memos from the phone to the agent: upload button, new turn vs attach to the current one, by path vs straight into the chat (`view_media`, MCP image blocks), automatic transcripts and video frames, which CLIs take pictures | Sending files to the agent, transcripts of recordings, or inline images |
| [`47-agent-audio-streams.md`](./47-agent-audio-streams.md) | The agent pipes its own audio to the user: `audio_stream_*` tools, queue vs async, owned streams closed in bulk, stream logs, the `agent_audio` frames | Sound effects, recordings or live PCM from the agent, or touching the phone's speech queue |
| [`48-show-media.md`](./48-show-media.md) | `show_media` / `media_control`: images, video and audio on the phone — raw fullscreen with a close icon, autoplay / auto-close / close-on-end, self-destruct or session-long, remembered video frames, live streaming of files another agent is still writing, Range serving | Showing the user a video, a recording, a render in progress |

## One-paragraph summary

The **phone** (iPhone Safari PWA) captures speech with **browser STT**, falling
back to whichever server engine is configured — self-hosted Whisper, Groq,
OpenAI, Deepgram, Gemini, ElevenLabs, OpenRouter, or Amazon Transcribe
([`29-speech-to-text-providers.md`](./29-speech-to-text-providers.md)) — and
plays replies with **WebKit TTS** or **Amazon Polly**.
Utterances flow over **`/ws/intelligence`** to the bridge, which queues them for
the active coding agent (Cursor / Codex / Claude Code) via the **`squeakr`
MCP server** (`next_voice_turn`, `speak`, `done` — renamed from `cursor-voice`, then `agent-voice`;
see [`28-provider-parity-and-branding.md`](./28-provider-parity-and-branding.md)). The
agent is the conversational brain; coding work is delegated to **worker** CLI
processes via `spawn_agent`. Networking defaults to **Tailscale** but is
pluggable ([`25-hosting-providers.md`](./25-hosting-providers.md)); every bridge
request is validated with a **single app token**.

## Workflows

| Workflow | Who reasons | Audio path |
| --- | --- | --- |
| **`agent_native`** (default) | the active coding CLI via MCP | PWA STT/TTS ↔ bridge ↔ MCP `speak()` |
| **`llm_intelligence`** | Claude on Bedrock Converse | Same PWA STT/TTS; bridge orchestrator |

Speech-to-speech (OpenAI Realtime, Nova Sonic) was removed. AWS IAM keys in `.env`
power **Polly**, **Transcribe**, and **Bedrock Converse** only.

## Confirmed key decisions

- **Default workflow:** `agent_native` — the active coding CLI controls voice via MCP.
- **Audio:** Cascade STT + TTS (not S2S). WebKit first; Amazon fallback on desktop.
- **Wake/submit:** Vosk offline grammar for wake/end phrases; Silero VAD for speech-end.
- **Safety:** Constrained MCP tool set + project allowlist + git revert.
- **Auth:** Single app token on every HTTP, WebSocket, and MCP request.
