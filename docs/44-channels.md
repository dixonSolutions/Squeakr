# 44 — Channels: Discord, Telegram, Slack and WhatsApp as remote access

> Added: October 2026. Tracked in [#93](https://github.com/dixonSolutions/Squeakr/issues/93).
> Builds on the direct audio stream ([docs/41](./41-audio-stream-pipe.md)) and
> streamed speech output ([docs/30](./30-speech-output-providers.md#streaming--the-phone-plays-the-first-chunk-not-the-whole-file)).

Until now the bridge was reached one way: the PWA (or `squeakr pipe`) over
Tailscale, a tunnel or a public address. **Channels** add the chat apps people
already have open as a second way in — the model OpenClaw uses as its primary
remote access. Two things come through a channel:

1. **Voice calls** — the point of Squeakr. On Discord you call the bot in a
   voice channel and talk to the agent, hands-free, from any device Discord runs on.
2. **A command line by tagging** — `@Squeakr sessions`, `default 2`,
   `config tts openai` … to see and manage sessions and settings from wherever
   you are. Text conversation with the agent itself is what the agent CLIs'
   own chat integrations already do, so it is here (`say …`), but it is not
   the point.

Voice messages work where calls cannot (Telegram, WhatsApp): a voice message
becomes a turn and the agent answers with a voice message.

## What each platform allows — research (2026-10-15)

| | Discord | Telegram | Slack | WhatsApp (Cloud API) |
| --- | --- | --- | --- | --- |
| **Voice calls** | ✅ bots join voice channels, send and receive audio | ❌ Bot API bots cannot join or take calls | ❌ no API for huddle audio | ❌ *not yet* — possible via the Calling API, see below |
| **Voice messages** | ✅ in (transcribed) and out (real voice messages, with waveform) | ✅ in and out (Ogg/Opus) | ❌ not read yet (clips are AAC/WebM) | ✅ in and out (Ogg/Opus) |
| **Command line** | `/av …`, `@Squeakr …`, DMs | `/status`… menu, `@bot …`, DMs | `/av …`, `@Squeakr …`, DMs | every message (DMs only) |
| **Live status** (`watch`) | ✅ edited message | ✅ edited message | ✅ `chat.update` | ❌ messages cannot be edited |
| **Needs a public URL** | no (gateway WebSocket) | no (long polling) | no (Socket Mode) | **yes** — Meta calls a webhook |

Each adapter declares every one of these as supported or not, with the
reason, in its `capabilities` (`src/channels/adapters/*.ts`); `GET
/api/channels` and `squeakr channel` show them.

- **Discord.** Voice moved entirely to end-to-end encryption (DAVE) in March
  2026; clients without DAVE cannot join. `@discordjs/voice` 0.19 implements
  it (with `@snazzah/davey`, prebuilt for every platform) and still exposes
  per-user receive — though Discord documents receive as unofficial, so it
  could change. Decryption failures trigger a re-handshake in the library.
  No privileged intent is needed for slash commands, mentions and DMs; only
  the `!av` prefix in server channels needs *Message Content* switched on in
  the developer portal.
- **Telegram.** Calls exist only for user accounts over MTProto (NTgCalls /
  pytgcalls), whose Node bindings were dropped — a Python sidecar logged in
  as *you* is the only route, and not one worth shipping. Voice messages are
  first-class: `getFile` in, `sendVoice` (Ogg/Opus) out.
- **Slack.** No API lets an app join a huddle. OpenClaw drives a signed-in
  browser as a user to do it, which Slack does not sanction. Command line and
  live status only.
- **WhatsApp.** Two options exist. *Unofficial* WhatsApp Web libraries
  (Baileys) need no public URL but break WhatsApp's terms (bans happen) and
  cannot carry call audio either — **not used**. The *official* Cloud API is
  what this uses: Meta POSTs to a webhook on the bridge. Its **Calling API**
  can answer real voice calls — the webhook brings an SDP offer, the bridge
  answers through the Graph API, media is WebRTC (Opus over ICE/DTLS/SRTP) —
  but it is only open to numbers with a 2,000+ daily-recipient messaging tier,
  and needs a WebRTC stack in Node (`werift` or `node-datachannel`) plus a
  reachable media path. That is the next step for WhatsApp, not this one.

How OpenClaw does it (read from the install on the host, v2026.9.9, and its
docs): one plugin per channel; Discord voice through `@discordjs/voice` with
a WASM Opus codec in a worker thread; Telegram through grammY; WhatsApp
through Baileys; DMs gated by pairing codes or allowlists, groups by
mention; Discord voice either STT → agent → TTS or a realtime model
fronting the agent. Squeakr keeps the same shape with fewer moving parts:
its own speech chain (docs/29, docs/30) instead of a realtime model, and no
SDK where plain HTTP does (Telegram, Slack, WhatsApp).

## Setting it up

Tokens go in the home's `.env` (never `config.json`); everything else is
`settings.channels` in `config.json`, the API, or the CLI.

| Channel | `.env` | Where to get it |
| --- | --- | --- |
| Discord | `DISCORD_BOT_TOKEN` | [Developer portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token. Invite with scopes `bot applications.commands`, permissions *View Channels*, *Send Messages*, *Read Message History*, *Connect*, *Speak*, and *Manage Channels* + *Manage Roles* for private call rooms (`permissions=271649808`). |
| Telegram | `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → `/newbot` |
| Slack | `SLACK_BOT_TOKEN` (`xoxb-`), `SLACK_APP_TOKEN` (`xapp-`, `connections:write`) | api.slack.com/apps → enable Socket Mode, event `app_mention` + `message.im`, slash command `/av`, scopes `app_mentions:read chat:write im:history users:read commands` |
| WhatsApp | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN` (you choose it), `WHATSAPP_APP_SECRET` | Meta app → WhatsApp → API setup; webhook URL `https://<public bridge>/hooks/whatsapp`, field `messages` |

Then:

```bash
squeakr channel enable discord
squeakr channel allow discord 123456789012345678   # your Discord user id
squeakr channel                                     # status of every channel
```

**Nobody is allowed by default.** A bot token is control of your machine, so
a channel obeys only the user ids in `allowUsers`. Anyone else who talks to
the bot is told their id (once an hour) and ignored — that is how you find
your own id: message the bot, then `squeakr channel allow …` what it says.
In a voice call, only allowlisted members are listened to.

```jsonc
"channels": {
  "commandPrefix": "!av",            // addresses the bot in a group without a mention
  "discord": {
    "enabled": true, "allowUsers": ["…"], "requireMention": true,
    "messageChannel": "1471…",       // its own text channel: no tag needed, calls and logs are written up here
    "voiceChannel": "1471…",         // where calls happen: walk in and it picks up
    "logs": true,                    // every session log line into the message channel
    "voice": true, "autoJoin": false, "welcomeDm": true, "voiceNotes": true
  },
  "telegram": { "enabled": true, "allowUsers": ["…"], "messageChannel": "-100…" },
  "slack":    { "enabled": false, "allowUsers": [] },
  "whatsapp": { "enabled": false, "allowUsers": ["15550001111"] }
}
```

Every channel has the **same settings** (`ChannelCommonSchema`); what a
platform cannot do — calls on Telegram, voice messages on Discord — its
adapter declares in its capabilities rather than the config growing
per-platform keys. Adding a platform is an adapter and a key here.

What you define per channel is two places:

- **`messageChannel`** — the bot's own conversation (a Discord text channel,
  a Telegram group, a Slack channel). There, no tag is needed: a command word
  runs the command, anything else goes to the agent; calls are written up and
  every session log line is posted there. `channel here` (typed there) sets it;
  `squeakr channel set discord messageChannel <id|none>` from the host.
- **`voiceChannel`** — where calls happen (Discord). Walking in is the call,
  `call` points you there. `voice here` (typed while you are in it) sets it.

Can the bot ring you directly? **No** — Discord bots cannot place calls to a
user, or join DM and group-DM calls; only server voice channels. The nearest
is what `call` does: the DM gets a one-click "Join Voice" card for the
configured voice channel (or, with none set, a private room — below).

Discord, Telegram and Slack connect outward, so they work on a bridge that is
only on a LAN or Tailscale. WhatsApp needs the bridge on public HTTPS (a
Cloudflare tunnel, ngrok, Tailscale Funnel — docs/25). Calls need
`agent_native`, a server speech-to-text provider and a server voice.

## The command line

Mention the bot (`@Squeakr …`), DM it, write in its message channel, use
`/av …` (Discord, Slack) or the `/status`… menu (Telegram), or the `!av`
prefix.

**Commands are the `squeakr` CLI.** `src/channels/commands.ts` is a
parser: it turns the message into CLI arguments — plus where it came from,
`--channel --conversation --user` — and runs the real CLI
(`src/channels/cliRunner.ts`, this package's `dist/cli.js`, the bridge's own
home, `SQUEAKR_MARKDOWN=1` so answers carry `**bold**` / `` `code` ``
instead of colour). The CLI's control commands (`agent`, `sessions`, `use`,
`new`, `say`, `config`, `default` …) call `/api/control/*`
(`src/control/routes.ts`), so a terminal and a chat are one implementation
with the same answers. Only what is about the chat itself is answered in
place: `help`, `whoami`, `call` / `join` / `hangup`, `watch`.

### Talking to the agent: `chat` and streams

`chat <message>` (or `say`) is one turn for the agent — a turn exactly like
a spoken one, minus the transcription; the agent is not told it was typed.
Attachments on that message go with it (below). A voice message on its own is
a turn too, transcribed. Other text that is not a command gets a pointer to
`chat` in a DM and is left alone in a group.

A **stream** keeps the conversation open to the agent:

```
stream on --voice --rep=voice   → every message here is a turn; replies are voice messages
stream on --text --rep=text     → the same with text: no transcription, text replies
stream status                   → 🟢 on for 12 min — in: voice notes, replies: voice · 7 turns · 📞 call …
stream break                    → ends the stream here, and your call if one is going
```

`--voice` / `--text` say what you will mostly send (both always work: a voice
message is transcribed, text is not); `--rep` picks how the agent answers,
defaulting to the same. Phones turning `--` into `—` is fine. In a stream,
every message is a turn — even one starting with a command word — except a
tagged or prefixed command (`@Squeakr status`, `!av status`, `/av …`) and
`stream …` itself. A stream listens until it is broken, not just for ten
minutes. Streams are kept in memory: a bridge restart ends them.

Every turn from a chat — `chat`, a stream, a voice message — continues the
conversation's `default` session, else the person's `voice default`, else
whatever is active.

### The attachment bridge

In: images, video, recordings and documents attached to a `chat` message or
sent in a stream are saved under `<data>/attachments/<day>/` and handed to the
agent by path (`Attached image: /…/shot.png`) — every agent CLI can open a
file by path, so nothing is per-CLI. Voice messages are transcribed into the
turn instead, and so are audio files (FLAC, MP3, M4A/AAC, WAV, Ogg, WebM —
decoded by the optional `audio-decode`, no ffmpeg): what was typed, then
`Recording 8.flac (transcribed): …`, and the file is still saved and referenced
by path. A recording on its own is a turn, like a voice message, on every
channel. 25 MB per file (`src/channels/attachments.ts`).

Out: files the agent sends are posted as attachments wherever someone is
listening, and to the message channel. Two tools publish them as an
`agent_files` event: `show_images` (which also fills the phone's carousel)
and **`send_files`** — recordings, videos, screenshots, logs, documents, by
path (under a project or the temp directory), URL or base64. Replies with
`--rep=voice` are real Discord voice messages (voice-message flag, duration,
waveform); Telegram and WhatsApp get their native voice notes.

 Every form of the tag is
taken out wherever it sits — the user mention, Discord's `<@!id>`, and the
bot's *role* mention Discord often inserts instead — together with the
spaces, line breaks, `:` or `,` between it and the command, and invisible
zero-width characters; any whitespace, line breaks included, separates the
command from its arguments (`src/channels/text.ts`). `help` lists everything
in groups; `help sessions|voice|config|cli` shows one.

| Command | Does |
| --- | --- |
| `chat <message>` · `say` | a turn for the agent, attachments included; replies come back here |
| `stream on [--voice\|--text] [--rep=voice\|text]` · `stream status` · `stream break` | keep the conversation open to the agent — see below |
| `status` | agent running or idle, active project, who is listening, speech providers, this conversation's default session (`squeakr agent`) |
| `sessions [project]` | numbered list of voice, worker, recent and external sessions (docs/37) with status and last activity |
| `use <n\|name>` | continue that session on the next turn (the phone's session picker) |
| `default [<n\|name\|project>\|none]` | pin the session **this conversation** talks to — see below |
| `new [project]` | start a fresh session |
| `project [name]` · `projects` | show / switch the active project |
| `stop` | stop the voice agent (`squeakr agent stop`) |
| `config [key] [value]` | `agent`, `model`, `permissions`, `workflow`, `input`, `stt`, `tts`, `wake`, `vad`, `silence`, `startphrase` / `endphrase` / `cancelphrase`, `away` — the voice-session ones are the app's own, so a phone and a call listen the same way |
| `channel here` | this conversation becomes the message channel |
| `voice` | the session your calls continue |
| `voice here` | the voice channel you are in becomes the one calls use |
| `voice sessions` | the session list with 🎙️ on the one your calls continue |
| `voice default <n\|name\|project\|none>` | the session **your** voice calls continue — set from any channel or a DM |
| `voice autojoin on\|off` | join you in any voice channel you step into (`channel set <ch> autoJoin`) |
| `call` · `hangup` | a call — in the configured voice channel, else your private room; works from a DM |
| `join` · `leave` | voice call (Discord: the voice channel you are in) |
| `cli <command>` | run `squeakr <command>` on the host and post its output — the control commands above, and `status`, `doctor`, `version`, `logs [-n N] [--list]`, `channel [allow\|set …]`; also typed as `squeakr doctor`, or `doctor` / `version` / `logs` alone |
| `watch` | post a status message and keep editing it as sessions change (again to stop) |
| `whoami` | your platform id |

`config` goes through the bridge's own admin API in-process, so a change from
Discord is validated and has the same side effects as the Config screen
(switching the agent CLI resets a model it lacks, and so on). Model and
permission choices come from the active provider, as everywhere (docs/24, 33).

### Default sessions

`default 2` in a Discord channel pins that conversation to session 2 (or
`default site` to "the latest session on project *site*"). From then on a
call started from there — or from the voice channel's own chat — and every
`say` continues **that** session instead of a fresh one or whatever the phone
last used: the binding makes its project active and sets the resume id, the
same thing the phone's session picker does. Bindings are per conversation
(`channel_binding` table), so `#frontend` and `#infra` can each have their own.

### Preparing a Discord call

```
@Squeakr sessions            → numbered list
@Squeakr voice default 2     → 📌 your calls continue session 2
@Squeakr voice autojoin on   → (optional) stepping into a voice channel is the call
  … join a voice channel, then @Squeakr join (or just walk in, with auto-join)
🔊 In Dev — talk to me. Continuing auth worker.
```

Or, from the bot's DM, a call for just the two of you:

```
call                            → 📞 Your private voice room is ready: <link>
  … click it and walk in; the bot picks up, the call is mirrored into the DM
hangup                          → 👋 Hung up.
```

**Discord bots cannot join DM or group-DM calls** — only server voice
channels. So `call` is the DM call: it finds or creates
`🎙️ Squeakr · <your name>` in a server you share with the bot (the one
`call` was typed in, else the first), hidden from @everyone and open only to
you and the bot. That needs *Manage Channels* and *Manage Roles*. Walking into
your room always starts the call, auto-join or not; the room is kept for next
time. `join` typed in a DM means `call`.

A call continues, in this order: the voice channel's own `default` (set in
that voice channel's chat), else **your** `voice default`, else the `default`
of the text channel `join` was typed in, else whatever the bridge has active.
`voice default` is keyed to you, not a channel, so it can be set from a DM.

### The host CLI from chat

Every command is a CLI run (60 s limit). A chat may run the control commands
and the host's read-only checks — `status`, `doctor`, `version`, `logs` (not
`-f`), `channel` (allowlist and channel settings, which every allowed user is
trusted with); host output is posted as a block clipped to the last ~1,800
characters. Service control, updates, setup, migration and tokens stay on the
host — a chat account is not a shell. Free text and ids are passed after `--`,
so a Telegram group id (`-100…`) or "-1 is wrong" is never read as a flag.

### Session logs in the message channel

With `logs` on (the default) and a `messageChannel` set, every session log
line goes there — what a voice client is sent (speech in / out, tools,
pipeline, agent status, the agent's lines) through a broadcast tap that is
not a listener, plus every turn from any surface (`user_turn`). Lines are
batched into one post every two seconds so a busy agent stays under rate
limits; nothing is dropped (`src/channels/logRelay.ts`).

### Replies and "listening"

A conversation that sends a turn (`say`, a voice message, or a call) becomes
a **listener**, exactly as a connected phone is: every line the agent speaks
is posted there — as a voice message too, if the last thing said there was
one — and the agent's `speak()` / `next_voice_turn()` see someone present.
It stops listening after 10 minutes of quiet. With a phone connected as well,
both get the replies.

## Voice calls (Discord)

```
member speaks ─▶ Discord (DAVE) ─▶ @discordjs/voice receiver: Opus per user
   ─▶ opusscript decode 48 kHz stereo ─▶ downmix + resample 16 kHz mono
   ─▶ VoiceCall: per-speaker AudioStreamPipe (docs/41) ─▶ STT chain (docs/29)
   ─▶ deliverStreamTurn(source "discord") ─▶ voice agent

agent speak() ─▶ synthesize(stream: true) (docs/30) ─▶ PCM chunks
   ─▶ resample 48 kHz stereo ─▶ audio player (Raw → Opus) ─▶ the voice channel
```

- `src/channels/voiceCall.ts` is platform-free; `adapters/discordVoice.ts`
  binds it to `@discordjs/voice`.
- **A call listens exactly like the app's voice session** — the same server
  settings (`settings.voice`, the Voice tab; `config wake|vad|silence|input`
  from chat), read when the call starts (`src/channels/callTurns.ts`):
  - `input: stream` — every segment is a request; wake words do not apply.
  - `input: turns` with wake words on — the start phrase opens a request
    ("hey squeaker, run the tests", or the phrase, a pause, then the
    request); anything else is room talk and is not sent. With VAD on, the
    pause ends it; with VAD off, the end phrase does. The cancel phrase drops it.
  - wake words off — every utterance is a request (VAD off: the silence timer
    ends it).
  The phone spots phrases with Vosk on the audio, and so does a call: the
  bridge runs the same model, grammar and confidence threshold on each
  speaker's audio (`src/channels/wakeSpotter.ts`, the optional native
  `vosk-koffi`), so the listening cue plays while the start phrase is still
  being said rather than after the pause and the transcript. The transcript
  then only carries the request — its copy of the phrase is cut, even
  misspelled. Without the native library or a prepared model, the phrase is
  matched in the server transcript as before. For the request itself a small
  model keeps calls snappy: `Systran/faster-whisper-base.en` transcribes about
  3× faster than `small` on a CPU.
- Discord sends **no packets while someone is silent**, so a pause cannot be
  heard; the member's receive stream ends after the VAD silence
  (`turnSubmit.silenceMs`; `stream.segmentSilenceMs` in stream input —
  `EndBehaviorType.AfterSilence`) and that cuts their segment.
- Each speaker has their own pipe; with more than one person on the call the
  agent is told who is talking (`Ana: …`).
- Speaking over the agent is a barge-in: the line playing stops and queued
  lines are dropped.
- What is said both ways is written up in the message channel (else the
  conversation `join` / `call` came from).
- With `autojoin` on, an allowlisted member entering a voice channel is the
  call: the bot joins them there (one call per server) and posts in that
  voice channel's chat.
- The bot is only in voice while called — when you walk into its voice
  channel or private room, or send `call`. It leaves when the last
  allowlisted member does, on `hangup` / `stream break`, or when the call
  breaks: an error the call cannot go on without (the agent cannot reach the
  bridge) is posted and read out, then it hangs up and posts
  "📴 Stream broken — …"; a dropped connection does the same without the
  reading. On hang-up, a phrase still being
  transcribed reaches the agent.
- The whole call is mirrored to the app as it happens (see below).
- Walking into the configured `voiceChannel`, or your private room, always
  starts the call; after a bridge restart, anyone already sitting there is
  picked up again.
- `discord.js`, `@discordjs/voice` and `opusscript` are **optional
  dependencies**, imported only when Discord is enabled; no ffmpeg, no native
  build (DAVE ships prebuilt binaries).

### The call in the app

Everything on a call is also pushed to the app over its control socket
(`/ws/control`) as `channel_call` frames — `{type, call, source, at, event, …}`:

| `event` | Fields | The app |
| --- | --- | --- |
| `started` / `ended` | `wake` | toast + log line |
| `heard` | `speaker`, `text`, `state`: `request` · `armed` · `held` · `cancel` · `ignored` | transcript line `🎙️ Ana (Discord): …` (`ignored` — talk without the wake phrase — goes to the log only) |
| `reply` | `text`, `own` | transcript line; the agent's own lines already reach an open voice session over its socket, so they are added only when none is open |
| `cue` | `cue`: `listening` · `sent` · `cancel` · `error` | plays the same sound effect, at the moment the call plays it |
| `activity` | `line` | log line (tool calls, agent status) |
| `notice` | `text` | warning toast |

Frames are dropped when no app is connected. `scripts/live-discord-check.mjs`
holds the control socket itself and prints each frame (`app ◂ …`).

## Speech-to-speech models (the question in #93)

**AWS Bedrock does not offer OpenAI's realtime models.** As of 2026-10-15
the OpenAI models on Bedrock are text/coding models only — gpt-oss-20b/120b,
GPT-5.4/5.5 and Codex, GPT-5.6 Sol/Terra/Luna, GPT-6 Astra. Bedrock's
speech-to-speech models are Amazon's own: **Nova Sonic** and **Nova 2 Sonic**
(`amazon.nova-2-sonic-v1:0`, Dec 2025), over `InvokeModelWithBidirectionalStream`
(us-east-1, us-west-2, eu-north-1, ap-northeast-1; 20 concurrent sessions per
account and region).

OpenAI's own line is on the OpenAI API: `gpt-realtime-2` (May 2026),
`gpt-realtime-2.1` / `-mini` (July 2026), and `gpt-live-1` (GA September 2026
— full-duplex, built to hand reasoning and tool use to a backend agent, on a
new `v1/live/sessions` endpoint). Azure AI Foundry has `gpt-realtime`,
`gpt-realtime-1.5` and a GPT Realtime 2.0 preview; 2.1 and `gpt-live-1` were
not confirmed there.

So testing a new S2S front end means either Nova 2 Sonic through Bedrock, or
the OpenAI API directly. `gpt-live-1`'s "front the agent, delegate the work"
shape is exactly the old `llm_intelligence` idea done right, and would slot
in as a channel/phone *conversation mode* in front of the same agent session
— a follow-up, not part of this change.

## API

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/channels` | app token | every channel's state, capabilities, allowlist, missing env vars; all default-session bindings |
| `PATCH /api/channels/:id` | app token | `{ enabled?, allowUsers?, requireMention?, messageChannel?, voiceChannel?, logs?, voice?, autoJoin?, welcomeDm?, voiceNotes? }` — only `enabled` restarts the channel |
| `/api/control/*` | app token | the CLI's control commands: `status`, `projects`, `project`, `sessions`, `use`, `new`, `stop`, `say`, `config`, `default` (`src/control/routes.ts`) |
| `POST /api/channels/:id/allow` | app token | `{ userId }` — add to the allowlist |
| `GET/POST /hooks/whatsapp` | Meta verify token / `X-Hub-Signature-256` | WhatsApp webhook |

## Testing

- Unit (`npm test`): `src/channels/*.test.ts` — chat → CLI translation,
  the call turn rules (stream, wake words, VAD, end phrase, cancel), the
  hub's allowlist / addressing / message channel / text turns / listeners /
  voice messages / session logs, the voice-call engine (segment cuts,
  barge-in, several speakers, hang-up drain, the app mirror), Opus and Ogg
  (round trip, page CRCs); `src/control/routes.test.ts` — sessions, use,
  default sessions per conversation and per person, say, config,
  resampling; `adapters/*.test.ts` — Telegram parsing, platform formatting,
  Meta signatures, and the Discord call against a stand-in `@discordjs/voice`
  (real Opus packets in per member, 48 kHz stereo out).
- End to end: `node scripts/live-channels-test.mjs` runs `squeakr run`
  with Telegram, Slack and WhatsApp pointed at stand-ins of their APIs (Bot
  API long polling and files, Socket Mode, a signed webhook and the Graph API)
  and the stub agent: access control, every command (through the real CLI),
  `say` relayed back, plain text as a turn, `channel here` and untagged
  messages in the message channel, session logs posted there, a real
  Ogg/Opus voice message in and out, `watch` edits, the CLI.
- **Not covered by CI:** a live Discord voice call (needs a bot token, a
  server and someone talking), and the real Telegram/Slack/Meta services.
  `scripts/live-channels-test.mjs` documents what the stand-ins model.

## Limits and next steps

- **WhatsApp calls** — the Cloud API Calling API (WebRTC) is the path; gated
  on Meta's tier and a WebRTC stack.
- **Discord voice messages** and **Slack clips** need an AAC/WebM decoder
  (ffmpeg) — not read yet.
- One voice agent: channels and the phone drive the same agent and the same
  active project; `default` decides *which session* it continues, not a
  second agent in parallel.
- No Config-screen panel yet — `squeakr channel`, the API, or `config.json`.
