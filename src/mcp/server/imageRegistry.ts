/**
 * Which local files the agent may hand the user — `show_media`, `show_images`
 * and `send_files` all go through here before a path is served or posted.
 *
 * Allowed: enabled project roots, the OS temp directory, `~/.cursor`, the
 * bridge's `data/`, and the uploads folder next to its database
 * (`<dirname(DB_PATH)>/media`, docs/46) wherever DB_PATH points.
 *
 * Both sides are compared as real paths, so a symlink inside a project cannot
 * point the phone at a file outside it, and a project registered as
 * `/home/me/app` still matches `/var/home/me/app/shot.png` on hosts where
 * `/home` is a link.
 *
 * (The file keeps its name from when it also held the image carousel's batch
 * store; that moved to src/display/registry.ts.)
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getDb } from '../../state/db.js';
import { getConfig } from '../../config.js';
import { childLogger } from '../../log.js';

const log = childLogger('mcp:server:imageRegistry');

/** Enabled project roots + OS temp and common screenshot dirs. */
export function getAllowedPathRoots(): string[] {
  const roots: string[] = [];
  try {
    const rows = getDb()
      .prepare('SELECT path FROM project WHERE enabled = 1')
      .all() as { path: string }[];
    for (const row of rows) {
      roots.push(resolve(row.path));
    }
  } catch (err) {
    log.warn({ err }, 'could not read project paths for image allowlist');
  }

  roots.push(resolve(tmpdir()));
  roots.push(resolve(homedir(), '.cursor'));
  roots.push(resolve(process.cwd(), 'data'));
  // Phone uploads (docs/46) live beside the database, which need not be ./data.
  // Only that folder: the rest of the data directory holds the database itself.
  try {
    roots.push(resolve(dirname(resolve(getConfig().env.DB_PATH)), 'media'));
  } catch {
    // Config not loaded (unit tests) — the defaults above still apply.
  }

  return [...new Set(roots)];
}

/**
 * The real path of `p`, following links. A path that does not exist yet (a
 * file another agent is about to write) resolves through its nearest existing
 * ancestor, so it is judged by where it *will* be.
 */
export function realPathLoose(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(realPathLoose(parent), basename(abs));
  }
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + '/') || path.startsWith(root + '\\');
}

/** True when `filePath` (real path) sits under one of `roots` (real paths). */
export function isUnderAllowedRoot(filePath: string, roots: string[] = getAllowedPathRoots()): boolean {
  const real = realPathLoose(filePath);
  return roots.some((root) => isUnder(real, realPathLoose(root)));
}

/**
 * Validate a filesystem path is under an allowed root (no traversal, no
 * symlink escape). Returns the resolved path, or null.
 *
 * `allowMissing` accepts a file that does not exist yet — used for live media
 * another agent is still writing. A directory is never accepted.
 */
export function resolveAllowedImagePath(
  filePath: string,
  opts: { allowMissing?: boolean; roots?: string[] } = {},
): string | null {
  const resolved = resolve(filePath);
  if (!isUnderAllowedRoot(resolved, opts.roots)) return null;
  if (!existsSync(resolved)) return opts.allowMissing ? resolved : null;
  try {
    if (statSync(resolved).isDirectory()) return null;
  } catch {
    return null;
  }
  return resolved;
}
