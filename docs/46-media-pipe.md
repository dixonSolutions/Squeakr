# 46 — Media pipe: images, video and recordings from the phone

> Added: October 2026. **Implemented.**

Until now the only thing the phone could hand the agent was words. This adds
files: a screenshot of the bug, a screen recording, a voice memo. The bridge
keeps every raw file, and does the work the agent would otherwise have to:
recordings come with a transcript, videos with still frames and a transcript
of their sound, and pictures can go straight into the agent's chat.

## Using it

During a live session the voice tab shows a paperclip next to the pencil.
It opens the request dialog on the file picker. The dialog has:

- **Add files** — images, video and audio (`image/*,video/*,audio/*`). On a
  phone that includes taking a photo or a video there and then.
- **Record memo** — records the mic as a voice memo. Voice capture pauses
  while it records, so the memo is not also heard as a spoken turn.
- A tray with one row per file: a thumbnail, its size and length, and, once
  the bridge has it, the transcript. Uploads start the moment a file is
  picked, so the transcript is usually ready by the time you tap Send.
- **New turn / Attach to current** — the mode (below).
- **By path / Into chat** — the delivery (below).

Typed text is optional; a file on its own is a valid turn.

## Modes

| Mode | What happens |
| --- | --- |
| **New turn** | The files are part of a user turn, with whatever you typed. Spawn-or-queue exactly like a spoken turn: no agent running → one is started with it; agent running → it arrives through `next_voice_turn()` or the interrupt hook. |
| **Attach to current** | The files join the conversation in flight without being a new request. If the voice agent is running they ride out on its next Squeakr tool call (an `attached_media` field — the mailbox channel from docs/37); if not, they go with your next turn. The agent is told it is context, not an instruction. |

Attached media only ever reaches the **voice agent's** MCP session. A worker
that happens to call a Squeakr tool first must not act on it as if it were
its own request.

## Delivery

| Delivery | What the agent gets |
| --- | --- |
| **By path** (default) | The turn text lists every file — kind, name, type, size, length, and its path under `<data>/media/<YYYY-MM-DD>/` — with the transcript written out in full. Every CLI can open a file by path, so this always works. |
| **Into chat** | The same text, plus the pictures themselves (images, video frames) as MCP image blocks in the tool result that carries the turn. The text also names `view_media(ids)`, which is how an agent sees them when no result could carry them — a turn that started a new agent process, or one delivered through a resolve-policy interrupt. |

The text is always self-contained. An agent that only ever sees text — a
respawn, a CLI without image support — still has every path and every
transcript.

### Which CLIs take pictures in the chat (provider rule)

Every provider declares `mediaInput(): { mcpImageResults, note }`:

| CLI | `mcpImageResults` | Evidence |
| --- | --- | --- |
| Claude Code | `true` | Verified live: spawned by the bridge, it answered questions about a picture from a `next_voice_turn` image block, and from `view_media` after a spawn. |
| Codex | `true` | Codex turns MCP image content into input images. Not yet verified live in this repo. |
| Cursor | `true` | Cursor's agent accepts images returned by MCP tools. Not yet verified live in this repo. |
| Codewhale | `false` | Not known to forward MCP image blocks — declared off, so "Into chat" falls back to paths with a note saying so. |

A CLI that declares `false` gets path delivery and the turn says why. The
phone shows the active CLI's note under the toggle.

## What the bridge does with each upload

| Kind | Always | Extras |
| --- | --- | --- |
| Image | raw file | an inline copy: the file itself if it is PNG/JPEG/GIF/WebP under 3.5 MB, otherwise a JPEG downscaled to 1568 px on the long side (ffmpeg) |
| Recording | raw file | transcript through the configured speech-to-text chain (docs/29), also saved as `<file>.transcript.txt`; long recordings go through the engine in ~2-minute pieces cut at the quietest moment near each boundary |
| Video | raw file | 4 still frames spread across the clip, plus a transcript of its sound track if it has one |

An audio-only `.webm` arrives labelled `video/webm` (that is what browsers
call every `.webm`); the bridge checks for a video stream and treats it as a
recording when there is none.

Every transcript state is reported, never thrown:

| `transcript_status` | Meaning |
| --- | --- |
| `done` | transcribed |
| `empty` | the audio held no speech |
| `needs_pcm` | the bridge could not decode the format (no ffmpeg); the phone decodes it and posts PCM |
| `unavailable` | no server speech-to-text engine is configured |
| `failed` | the engine errored — the reason is in `transcript_error` |
| `none` | nothing to transcribe |

### Decoding, and what needs ffmpeg

- **WAV** and **Ogg/Opus** decode in-process. Nothing to install.
- **WebM/Opus** (Chrome's recorder), **MP4/M4A/AAC** (Safari's), **MOV**, **MP3**,
  video frames and image downscaling use **ffmpeg/ffprobe** when the host has
  them.
- Without ffmpeg a recording comes back `needs_pcm`, and the phone falls back
  to the browser's own decoder (`OfflineAudioContext` at 16 kHz) and posts the
  PCM to `/api/media/:id/pcm`. A browser can always decode what it recorded.
  Video without ffmpeg is handed over by path with no frames.

If the bridge runs inside a container (distrobox, the `system` service), ffmpeg
has to be installed **in the container**: a host-only ffmpeg is not on the
bridge's PATH.

## API

All under the app token.

| Route | |
| --- | --- |
| `GET /api/media/capabilities` | `{ max_bytes, transcription, ffmpeg, inline: { supported, cli, note }, attached, agent_running }` |
| `POST /api/media?name=<file>` | Raw file body, any `Content-Type`. Streamed to disk (not through the 10 MB JSON body limit; the ceiling is 512 MB), processed, and returned as the asset view below. |
| `POST /api/media/:id/pcm` | 16 kHz mono PCM16LE (`application/octet-stream`, up to 128 MB) for a `needs_pcm` asset. |
| `POST /api/media/attach` | `{ ids, delivery }` — stage for the conversation in flight. Returns `when: next_tool_call \| next_turn`. |
| `POST /api/turns` | Now takes `media_ids` and `media_delivery`; `text` may be empty when there are files. |
| `/ws` `user_turn` | Same two fields. On the cascade workflow (docs/15) the paths and transcripts are written into the text. |

Asset view (what the phone sees — host paths are never echoed back):

```json
{ "id": "…", "kind": "audio", "name": "memo.webm", "mime": "audio/webm", "size": 57697,
  "duration_sec": 6.2, "transcript_status": "done", "transcript": "The login button…",
  "transcript_provider": "local_whisper", "transcript_error": null, "frames": 0, "inline": false }
```

## MCP

- `next_voice_turn` results carry `media_ids` and `media_delivery`, and, for
  "Into chat", the image blocks after the JSON.
- `view_media(ids)` — the files as text (paths, transcripts) plus the pictures
  as image blocks; text only on a CLI that declares no image support.
- Any Squeakr result on the voice agent's session may carry `attached_media`
  (text) and `attached_media_ids`, with image blocks when attached "Into chat".

## Limits

- The registry of ids is in memory for 24 hours. A bridge restart loses the
  ids (so `view_media` on an old id says so) but never the files; the turn
  text already holds every path.
- Media files are not cleaned up automatically yet; they live next to the
  database under `media/`.
- One inline result carries at most 12 pictures; the rest are listed by path.

## Testing

`src/media/pipeline.test.ts`, `src/media/delivery.test.ts`,
`src/routes/media.test.ts` and `web/src/media-upload.test.ts`. The ffmpeg cases
run when ffmpeg is on PATH and are skipped (saying so) when not.

Verified end to end on 2026-10-20 against a scratch bridge with local Whisper
(speaches) and Claude Code: a spoken clip uploaded as WAV, Chrome-style
WebM/Opus, Safari-style M4A and inside an MP4 was transcribed word for word;
a memo recorded in the PWA (headless Chromium, fake mic) was transcribed;
attach mode staged four files without creating a turn; and Claude Code
answered questions about a picture both through `view_media` after a spawn and
from an image block in `next_voice_turn`.
