# 17 — Image Carousel (`show_images`)

> **Superseded (October 2026):** the carousel is replaced by the media viewer in
> [`48-show-media.md`](./48-show-media.md). `show_images` still works as shorthand for
> `show_media` with images; images are served from `/api/display/:id`, not
> `/api/images/:id`. The Browser workflow below is unchanged.

Push UI screenshots and reference images from the Squeakr brain to the user's
PWA as a browsable carousel. Designed for hands-free users who can glance at their
phone while the agent works on UI.

## Overview

| Piece | Role |
| --- | --- |
| `show_images` MCP tool | Brain pushes a batch of images (non-blocking) |
| `imageRegistry` | In-memory store + ephemeral access keys |
| `GET /api/images/:id?k=` | Serves local/base64 bytes to `<img>` tags |
| Control WS `show_images` frame | PWA receives carousel payload |
| `cv-image-carousel` | Overlay + FAB toggle in the voice tab |

A **new** `show_images` call **replaces** the previous batch. The carousel auto-expands
for `duration_ms` (default 8 s), then minimizes to a floating toggle the user can
reopen.

## Data flow

```
Cursor brain → show_images({ images })
  → imageRegistry.setImages (overwrite batch, issue access key)
  → pushToPhone({ type: "show_images", images, duration_ms })
  → PWA bridge.service carousel signals
  → ImageCarouselComponent overlay

PWA <img src="/api/images/:id?k=KEY">
  → GET /api/images/:id (ephemeral key auth, not Bearer)
  → read path/base64 from registry
```

External `url` items skip the bridge — the PWA loads `http(s)` URLs directly.

## Tool contract

### `show_images`

| Arg | Type | Notes |
| --- | --- | --- |
| `images` | array (1–10) | Each item: exactly one of `path`, `url`, or `data` |
| `duration_ms` | int? | 3000–120000; expanded time before minimize (default 8000) |
| `caption` | string? | Optional batch title |

| Item field | Notes |
| --- | --- |
| `path` | Local file under project roots, `tmpdir`, `~/.cursor`, or `data/` |
| `url` | `http://` or `https://` only |
| `data` | Base64 or `data:*;base64,*` URI (max 4 MB decoded per item) |
| `mime` | Optional; auto-detected from extension when omitted |
| `caption` | Per-image label |

Returns immediately: `{ ok, count, delivered, batch_id }`.

### Browser workflow (opt-in)

Set `browser: true` on `spawn_agent` or `agent_submit` when:

- The user is reviewing UI on their phone
- The user says **"Browser"** in the request
- The task is UI/visual (layouts, components, screenshots)

The worker prompt includes `BROWSER_SNAPSHOT_BLOCK` (`src/executor/agentPrompt.ts`):
use browser tools, take snapshots, list paths under `Screenshots:` in the summary.
The brain then calls `show_images` with those paths.

## Security

See [`03-security.md`](./03-security.md) § Image carousel.

- **Ephemeral key** — per-batch UUID in `?k=`; not the app token (img cannot send Bearer).
- **Path allowlist** — `resolveAllowedImagePath()` checks enabled project paths + safe OS dirs.
- **Traversal** — `path.resolve` + prefix match on allowlisted roots.
- **TTL** — batch expires after 30 minutes; cleared on control WS disconnect.
- **Size caps** — max 10 images/batch, 4 MB base64 per item.

## Frontend behavior

- Signals: `carouselImages`, `carouselBatchId`, `carouselDurationMs`, `carouselCaption` in `BridgeService`.
- Component: `web/src/app/components/image-carousel/`.
- Mounted on the voice tab beside the approval panel.
- FAB position: bottom-right, above tab bar (safe-area aware).

## Implementation map

| File | Purpose |
| --- | --- |
| `src/mcp/server/imageRegistry.ts` | Batch store, allowlist, URL generation |
| `src/mcp/server/imageToolHandlers.ts` | `handleShowImages` |
| `src/mcp/server/index.ts` | MCP tool registration |
| `src/mcp/schemas.ts` | `ShowImagesSchema` |
| `src/server.ts` | `GET /api/images/:id` |
| `web/src/app/services/bridge.service.ts` | WS handler |
| `web/src/app/components/image-carousel/` | UI |
| `web/src/styles.scss` | `.cv-carousel-*` styles |

## Related

- [`11-mcp-tool-surface.md`](./11-mcp-tool-surface.md) — full tool list
- [`14-prompts.md`](./14-prompts.md) — agent prompt guidance for Browser workflow
- [`16-mcp-server-agent-as-brain.md`](./16-mcp-server-agent-as-brain.md) — voice brain architecture
