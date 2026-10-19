# 48 — Showing Media (`show_media`)

> Added: October 2026

`show_images` could put screenshots on the phone. `show_media` puts any
**image, video or audio** there, and `media_control` drives it afterwards.
Media also covers **live** files: a recording or render that another agent
is still writing, streamed to the phone while it grows.

```text
show_media({ items: [{ path: "/tmp/demo.mp4" }], autoplay: true, close_on_end: true })
  → { ok: true, batch_id, items: [{ media_id: "…", kind: "video", self_destruct_in_s: 1800 }] }
media_control({ action: "status", media_id: "…" })
  → { playback: { state: "playing", open: true, position_s: 12.4, duration_s: 61.0 } }
```

Both are on the `squeakr` MCP server (and in `dispatchTool`), so Cursor, Codex,
Claude Code and Codewhale all get them the same way. Nothing in this feature
is specific to one CLI.

## What the user sees

**Fullscreen** shows the raw media on the screen with a close icon on its
top-right corner. There is no backdrop, no card and no border: the media
sits over the app, sized to fit, and the app stays usable around it.

- **Video:** tap it to play or pause. There are no other on-screen controls.
- **Audio:** the browser's own audio bar, with the close icon just above it.
- **Image:** just the image.
- **Several items in one call:** swipe left or right between them. On a
  desktop, use ← → and Esc.

**Closing a video remembers its frame.** If the user closes a video while it
plays, it pauses on that frame. Opening it again carries on from there,
playing. A video closed while paused reopens paused on its frame. The same
applies to audio.

**The media button.** Everything shown also waits under the round button at
the bottom right, with a count. It stays there until it self-destructs, the
agent removes it, or the session ends. The tray shows each video at its
remembered frame. Tapping an item opens it fullscreen.

## `show_media`

| Arg | Default | Meaning |
| --- | --- | --- |
| `items` (1–10) | — | Each item needs exactly one of `path`, `url` or `data`, plus optional `kind` (`image` / `video` / `audio`), `mime`, `caption`, `name` and `live`. |
| `display` | `"fullscreen"` | `fullscreen` opens the first item on the screen. `tray` only adds the items under the media button. |
| `autoplay` | `false` | Starts video or audio playing as it opens. **Fullscreen only.** |
| `muted`, `loop` | `false` | Start muted (a tap unmutes it). Loop the media. |
| `auto_close_ms` | none | Closes fullscreen after this long, unless the user closes it first. **Fullscreen only.** |
| `close_on_end` | `false` | Closes fullscreen when the video or audio finishes. **Fullscreen only.** |
| `self_destruct` | `1800` | Seconds until the items are deleted from the phone *and* the bridge (5–86400), or `"never"`. |
| `replace` | `false` | Removes everything shown before first. Without it, a call adds to what is shown. |
| `caption` | none | One line for the batch, used as the push notification's text. |
| `publish` | `true` | Also posts the files to chat channels where someone is listening (docs/44). |

`autoplay`, `auto_close_ms` and `close_on_end` passed with `display: "tray"`
fail the call with a message saying why. Media plays or closes by itself
only while it is on the user's screen.

**Self-destruct.** When the time runs out, the item vanishes from the phone,
even while it is on screen, and its URL stops working. `"never"` means *for
as long as the voice session lives*. The session ends when the user hangs up,
or when the phone has been gone for longer than the grace window
(`settings.session.graceMs`, docs/36). Either way, every item goes, `never`
ones included. A tunnel blip shorter than the grace window keeps everything.
On reconnect the bridge re-sends what is still shown (`media_sync`), and that
never re-opens anything.

**Autoplay and the browser.** Browsers allow sound only after the user has
interacted with the page. In a voice session they have, because they tapped
the orb. If the browser still refuses, the video autoplays muted, and the
first tap unmutes it. `media_control(status)` reports `muted: true` in that
case.

## Live files — streaming what another agent is writing

```text
show_media({ items: [{ path: "/tmp/render/narration.mp3", live: true }], autoplay: true })
… the other agent keeps appending to narration.mp3 …
media_control({ action: "finish", media_id })
```

`live: true` (path only, audio or video) accepts a file that is still being
written. The file does not even have to exist yet. The phone's request is
answered with the file as it grows. The bridge sends what is there, waits for
more, and sends that too. It ends the response when:

- the agent calls `media_control(finish)` and the reader has reached the last byte,
- the file has not grown for 30 s,
- or the item is removed.

After `finish` the item is an ordinary file again, so it can seek.
Publishing to chat channels waits for `finish` too, so a chat never gets half
a file.

Chromium starts playing a live file once about 32 KB have arrived: roughly
2 s of a 128 kbps MP3, and longer at lower bitrates. From then on it plays
as the file grows. Formats that play while they arrive: **MP3, Ogg (Vorbis or Opus), WebM, and
ADTS AAC**. A WAV that is still being written usually plays too, if its
header gives the data size as unknown (`0xFFFFFFFF`). An MP4 does not play
until it is complete, because its index is written last; use fragmented MP4
or WebM for live video.

The *user* sees and controls a live file: play, pause, a seekable result
afterwards. That is the line between this feature and agent audio streams
(docs/47, in flight on another branch). There, sound plays *as part of the
agent speaking*: in line with speech, with no UI, including raw PCM feeds.

## `media_control`

| Action | Needs | Does |
| --- | --- | --- |
| `status` | `media_id`? | Without an id, lists everything shown. Each item has `self_destruct_in_s` and `playback`: `state` (`shown` / `loading` / `playing` / `paused` / `ended` / `closed` / `error` / `unreported`), `open`, `position_s`, `duration_s`, `muted`, `updated_at`. |
| `open` | `media_id` | Opens the item fullscreen. Optional `autoplay` and `auto_close_ms`. |
| `close` | `media_id` | Closes fullscreen. A video keeps its frame. |
| `play` / `pause` | `media_id` | Controls playback. `play` on an item that is not on screen opens it, because playing by itself only happens on the screen. |
| `seek` | `media_id`, `position_s` | Jumps to a position. |
| `remove` | `media_id` / `media_ids` / `all` | Deletes items now. |
| `finish` | `media_id` | Marks a live file as complete. |

To close a video when it ends, `close_on_end` is the simplest way. An agent
that decides later can poll `status` until `state` is `ended`, then call
`close`.

## `show_images` and `send_files`

- `show_images` still works, now as shorthand. Its images open fullscreen for
  `duration_ms` (default 8 s) and then wait under the media button. A new
  `show_images` replaces the previous `show_images` batch and leaves
  `show_media` items alone. The old carousel card is gone.
- `send_files` puts images on the phone as before. **Videos and audio now go
  under the media button too** (`display: "tray"`), as well as to chat.

## Protocol

Bridge → phone, over the control socket (`/ws/control`). Desk clients see
these frames on `/ws/events`:

| Frame | Meaning |
| --- | --- |
| `{ type: "media_show", batch_id, items, open_id, caption }` | New items. `open_id` is the item to open fullscreen, or null for tray-only items. |
| `{ type: "media_remove", ids, reason }` | Removes items. `reason` is `self_destruct`, `agent`, `replaced`, `evicted` or `session_ended`. |
| `{ type: "media_sync", items }` | Everything still shown, sent on (re)connect. Never opens anything. |
| `{ type: "media_control", media_id, action, autoplay?, auto_close_ms?, position_s? }` | `action` is `open`, `close`, `play`, `pause`, `seek` or `live_end`. |

Each item in `items` has: `{ id, batch_id, kind, src, mime, caption?, name?,
live, expires_in_ms, display, autoplay, muted, loop, auto_close_ms,
close_on_end }`. `expires_in_ms` is relative, so a phone whose clock is off
still expires items on time.

Phone → bridge: `{ type: "media_state", media_id, state, open, position_s,
duration_s, muted, message? }`. It is sent on play / pause / end / close /
error, and every 5 s while something plays.

A `media_show` that opens something sends a push notification when the phone
is not connected. Tray-only items do not.

## Serving and security

`GET /api/display/:id?k=KEY` serves an item. `KEY` is the item's own random
key, not the app token, because `<video>` cannot send a Bearer header. The
key dies with the item.

- **Ranges.** Files are streamed from disk with `Range` support (206), so a
  long video starts and seeks without downloading first. Nothing is read
  into memory.
- **Allowlist.** Paths must be under an enabled project, the OS temp
  directory, `~/.cursor`, the bridge's `data/`, or the phone-uploads folder
  beside the database (`<dirname(DB_PATH)>/media`, docs/46). Both sides are compared as
  real paths, so a symlink inside a project cannot point outside it. The
  check runs again on every request.
- **Limits.** 10 items per call and 50 shown at once (the oldest go first).
  `data` items are capped at 4 MB; use a path for anything bigger.
- `url` items are loaded by the phone directly. The bridge only redirects.

## Code

| Where | What |
| --- | --- |
| `src/display/registry.ts` | Items, keys, self-destruct timers, playback reports, frames. |
| `src/display/serve.ts` | `/api/display/:id`: ranges, live tail (`tailFile`), redirects. |
| `src/mcp/server/displayToolHandlers.ts` | `show_media` / `media_control`. |
| `src/mcp/server/imageRegistry.ts` | The path allowlist, shared with `send_files`. |
| `src/server.ts` | Route, `media_state`, reconnect sync, session-end clear. |
| `web/src/media-display.ts` | The phone's shelf: items, expiry, remembered frames. |
| `web/src/app/services/display.service.ts` | Timers, agent controls, reports. |
| `web/src/app/components/media-viewer/` | The fullscreen view, the tray and the button. |

## Limits

- The phone's speech and the media's sound are not mixed or ducked. A video
  that plays while the agent speaks plays over it. Pausing speech while
  fullscreen media plays is a planned follow-up, together with docs/47.
- Echo cancellation keeps most media sound out of the mic, but a loud video
  in a quiet room can still reach the wake-word or the direct stream.
- A live file is followed from byte 0 on every request. Seeking inside a live
  stream starts it over.

## Testing

`src/display/registry.test.ts`, `src/display/serve.test.ts` (ranges, the live
tail and the route) and `web/src/media-display.test.ts` (`npm test`).
