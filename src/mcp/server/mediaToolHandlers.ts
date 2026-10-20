/**
 * view_media — the agent's way back to what the user uploaded (docs/46).
 *
 * Returns the pictures as MCP image blocks (images, video frames) and each
 * file's path and transcript as text. It works the same on every CLI that
 * shows tool-result images; one that does not still gets the paths.
 */

import { describeMediaForAgent, inlineSupported, mediaImageBlocks, type McpMediaContent } from '../../media/delivery.js';
import { resolveMediaIds } from '../../media/store.js';

export function handleViewMedia(args: { ids: string[] }): { content: McpMediaContent[]; isError?: boolean } {
  const { found, missing } = resolveMediaIds(args.ids);
  if (found.length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'MEDIA_NOT_FOUND',
          missing,
          message: 'Those uploads are no longer registered (they expire after a day, or the bridge restarted). The files are still at the paths the turn listed.',
        }),
      }],
      isError: true,
    };
  }
  const { supported, cli } = inlineSupported();
  const summary = {
    found: found.map((a) => a.id),
    ...(missing.length > 0 ? { missing } : {}),
    files: describeMediaForAgent(found, 'path'),
    ...(supported ? {} : { note: `${cli} does not show images from tool results — open the files by path.` }),
  };
  return {
    content: [
      { type: 'text', text: JSON.stringify(summary) },
      ...(supported ? mediaImageBlocks(found) : []),
    ],
  };
}
