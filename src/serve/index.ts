/**
 * Serve — manual self-hosting maintenance (no heartbeat, no auto-update).
 *
 * There is exactly one update path: `scripts/update.sh`. Both in-app update
 * buttons run that script (the stash one adds `--stash`), and so does anyone
 * running it by hand. The bridge's job here is the part the script cannot do —
 * pre-flight refusal, and mirroring the script's step log into `serve_event`
 * across the restart that kills this very process.
 *
 * Other in-app actions: restart via scripts/restart.sh, health check, and live
 * journalctl logs. See docs/21-serve-self-hosting.md
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { simpleGit, type SimpleGit } from 'simple-git';
import { getConfig, type ServeSettings } from '../config.js';
import { getRunModeInfo } from '../runMode.js';
import { childLogger, getSessionLog } from '../log.js';
import { followFile, tailLines } from '../logging/tail.js';
import { writeAudit } from '../state/db.js';
import { getAppVersionInfo } from '../state/appVersion.js';
import {
  addServeEvent,
  countServeEventsForRun,
  type ServeEventStatus,
} from '../state/serveEvents.js';

import {
  canSelfUpdate,
  npmProjectDir,
  PACKAGE_NAME,
  detectInstallMode,
  type InstallModeInfo,
} from './installMode.js';

const log = childLogger('serve');

/** Fallback when origin has no default branch advertised. */
const FALLBACK_TRACK_BRANCH = 'main';

/** Fixed unit name — never interpolated from user input. */
const execFileAsync = promisify(execFile);

const SERVICE_UNIT = 'squeakr.service';

/** How long to let the registry answer before giving up on a version check. */
const REGISTRY_TIMEOUT_MS = 8000;

/** The one update script. Nothing else pulls, builds or restarts. */
const UPDATE_SCRIPT = 'scripts/update.sh';

/** NDJSON step log written by update.sh and mirrored into `serve_event`. */
const UPDATE_LOG = 'data/serve-update.jsonl';

/** How often the bridge drains the script's step log while a run is live. */
const UPDATE_POLL_MS = 1500;

/** A run with no `finish` line after this long is treated as dead, not live. */
const UPDATE_STALE_MS = 30 * 60 * 1000;

/** Long file lists are for a human to skim, not to scroll — cap the payload. */
const MAX_LISTED_FILES = 100;

export type ServeOutcome = 'ok' | 'skipped' | 'no_changes' | 'error';

export type ServeActionId = 'update' | 'stash-update' | 'restart' | 'health';

/** Update modes, one per Serve button. `stash-update` adds `--stash`. */
export type ServeUpdateMode = Extract<ServeActionId, 'update' | 'stash-update'>;

export interface ServeRunResult {
  runId: string;
  trigger: 'manual';
  startedAt: string;
  finishedAt: string;
  outcome: ServeOutcome;
  summary: string;
}

export interface ServeActionResult {
  runId: string;
  outcome: ServeOutcome;
  detail: string;
}

export interface ServeGitSnapshot {
  repoDir: string;
  /** Currently checked-out branch (HEAD). */
  branch: string;
  /** Branch rebase will target (saved setting, else origin default, else main). */
  trackBranch: string;
  /** Origin's advertised default branch (`origin/HEAD`), when known. */
  defaultBranch: string | null;
  dirty: boolean;
  /** Commits on HEAD that `origin/<trackBranch>` does not have. */
  ahead: number;
  /** Commits on `origin/<trackBranch>` that HEAD does not have. */
  behind: number;
  currentCommit: string | null;
  /** First 8 characters of `currentCommit`, for display. */
  shortCommit: string | null;
  commitSubject: string | null;
  /** ISO author date of HEAD. */
  commitDate: string | null;
  /** Tip of `origin/<trackBranch>` as of the last fetch. */
  upstreamCommit: string | null;
  /**
   * Modified, staged and untracked paths in the working tree, capped at
   * {@link MAX_LISTED_FILES}. `localChangeCount` is the uncapped total.
   */
  localChanges: string[];
  localChangeCount: number;
  /** How many files the incoming commits touch. */
  incomingCount: number;
  /**
   * `localChanges` ∩ files touched by `HEAD..origin/<trackBranch>` — the files
   * a rebase would actually fight over. This is what makes "Rebase & update"
   * unsafe and "Stash, rebase & update" the honest choice. Capped like
   * `localChanges`; `conflictCount` is the uncapped total.
   */
  conflictFiles: string[];
  conflictCount: number;
  /** ISO timestamp of the fetch this snapshot is based on, when it did one. */
  fetchedAt: string | null;
}

/**
 * Where an npm install stands relative to the registry.
 *
 * The git equivalent is ServeGitSnapshot — branch, commit, ahead/behind. An
 * npm install has none of those; "am I current" is one semver comparison.
 */
export interface ServeNpmSnapshot {
  installed: string;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: string;
  /** Why `latest` is null — offline, registry down, package not published yet. */
  error?: string;
}

export interface ServeStatus {
  running: boolean;
  lastRun: ServeRunResult | null;
  git: ServeGitSnapshot | null;
  /** Populated for npm installs; null for a clone, which uses `git` instead. */
  npm: ServeNpmSnapshot | null;
  /** How this bridge was installed, and therefore how it updates. */
  install: InstallModeInfo;
  /** Run id of the update currently in flight, if any. */
  updateRunId: string | null;
}

export interface ServeServiceLogs {
  unit: string;
  lines: number;
  text: string;
  ok: boolean;
  detail?: string;
}

let _running = false;
let _lastRun: ServeRunResult | null = null;
let _lastGit: ServeGitSnapshot | null = null;
/** Set while `scripts/update.sh` is in flight; cleared when it writes `finish`. */
let _updateRunId: string | null = null;
let _updateTimer: ReturnType<typeof setInterval> | null = null;

function resolveRepoDir(settings: ServeSettings): string {
  return resolve(settings.repoDir?.trim() || process.cwd());
}

function runCommand(
  cwd: string,
  command: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Origin's default branch (`git symbolic-ref refs/remotes/origin/HEAD`).
 * Origin is assumed to already exist on the host.
 */
async function detectDefaultBranch(git: SimpleGit): Promise<string | null> {
  try {
    const ref = (await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim();
    const match = /refs\/remotes\/origin\/(.+)$/.exec(ref);
    if (match?.[1]) return match[1];
  } catch {
    // origin/HEAD not set yet
  }
  try {
    const abbreviated = (await git.revparse(['--abbrev-ref', 'origin/HEAD'])).trim();
    const stripped = abbreviated.replace(/^origin\//, '').trim();
    return stripped || null;
  } catch {
    return null;
  }
}

function resolveTrackBranch(
  settings: ServeSettings,
  defaultBranch: string | null,
): string {
  return settings.branch?.trim() || defaultBranch?.trim() || FALLBACK_TRACK_BRANCH;
}

function recordStep(
  runId: string,
  step: string,
  status: ServeEventStatus,
  detail?: string,
): void {
  addServeEvent({ runId, step, status, detail });
  log.info({ runId, step, status, detail }, 'serve step');
  writeAudit({
    tool: 'serve',
    result: status === 'error' ? 'error' : 'ok',
    reason: `${step}:${status}${detail ? ` — ${detail.slice(0, 120)}` : ''}`,
  });
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Files a rebase onto `upstreamRef` would fight over: dirty locally **and**
 * touched by the commits about to land. Two different questions — `git status`
 * for the working tree, `HEAD..upstream` for what is coming — intersected.
 */
async function computeConflictFiles(
  git: SimpleGit,
  localChanges: readonly string[],
  upstreamRef: string,
): Promise<{ conflictFiles: string[]; incomingCount: number }> {
  if (localChanges.length === 0) return { conflictFiles: [], incomingCount: 0 };
  let incoming: string[];
  try {
    incoming = splitLines(await git.raw(['diff', '--name-only', `HEAD..${upstreamRef}`]));
  } catch {
    return { conflictFiles: [], incomingCount: 0 };
  }
  const incomingSet = new Set(incoming);
  return {
    conflictFiles: localChanges.filter((path) => incomingSet.has(path)),
    incomingCount: incoming.length,
  };
}

async function probeGit(
  repoDir: string,
  settings: ServeSettings,
  opts: { fetch?: boolean } = {},
): Promise<ServeGitSnapshot> {
  const git = simpleGit({ baseDir: repoDir });

  let fetchedAt: string | null = null;
  if (opts.fetch) {
    try {
      await git.fetch(['--prune', 'origin']);
      fetchedAt = new Date().toISOString();
      try {
        await git.raw(['remote', 'set-head', 'origin', '-a']);
      } catch {
        // origin/HEAD refresh is best-effort — the fetch already succeeded
      }
    } catch (err) {
      log.warn({ err }, 'git fetch failed during snapshot');
    }
  }

  const defaultBranch = await detectDefaultBranch(git);
  const trackBranch = resolveTrackBranch(settings, defaultBranch);
  const upstreamRef = `origin/${trackBranch}`;
  let headBranch = trackBranch;
  try {
    headBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim() || trackBranch;
  } catch {
    // keep trackBranch
  }

  const empty: ServeGitSnapshot = {
    repoDir,
    branch: headBranch,
    trackBranch,
    defaultBranch,
    dirty: false,
    ahead: 0,
    behind: 0,
    currentCommit: null,
    shortCommit: null,
    commitSubject: null,
    commitDate: null,
    upstreamCommit: null,
    localChanges: [],
    localChangeCount: 0,
    incomingCount: 0,
    conflictFiles: [],
    conflictCount: 0,
    fetchedAt,
  };

  let status;
  try {
    status = await git.status();
  } catch {
    return empty;
  }

  let currentCommit: string | null = null;
  let commitSubject: string | null = null;
  let commitDate: string | null = null;
  try {
    const line = (await git.raw(['log', '-1', '--pretty=%H%x1f%s%x1f%aI'])).trim();
    const [sha, subject, date] = line.split('\u001f');
    currentCommit = sha?.trim() || null;
    commitSubject = subject?.trim() || null;
    commitDate = date?.trim() || null;
  } catch {
    // unborn branch — no HEAD commit yet
  }

  let upstreamCommit: string | null = null;
  try {
    upstreamCommit = (await git.revparse([upstreamRef])).trim() || null;
  } catch {
    upstreamCommit = null;
  }

  // `git status` counts ahead/behind against HEAD's own upstream, which is not
  // necessarily origin/<trackBranch>. Count against the branch we rebase onto.
  let ahead = status.ahead;
  let behind = status.behind;
  if (upstreamCommit && currentCommit) {
    try {
      const counts = (await git.raw([
        'rev-list',
        '--left-right',
        '--count',
        `HEAD...${upstreamRef}`,
      ])).trim();
      const [left, right] = counts.split(/\s+/);
      ahead = Number(left) || 0;
      behind = Number(right) || 0;
    } catch {
      // keep git.status()'s numbers
    }
  }

  // Staged, unstaged, renamed and untracked — everything a rebase would trip on.
  const localChanges = [
    ...new Set([
      ...status.modified,
      ...status.created,
      ...status.deleted,
      ...status.not_added,
      ...status.conflicted,
      ...status.staged,
      ...status.renamed.map((r) => r.to),
    ]),
  ].sort();

  const { conflictFiles, incomingCount } = upstreamCommit
    ? await computeConflictFiles(git, localChanges, upstreamRef)
    : { conflictFiles: [], incomingCount: 0 };

  return {
    ...empty,
    branch: status.current || headBranch,
    dirty: !status.isClean(),
    ahead,
    behind,
    currentCommit,
    shortCommit: currentCommit ? currentCommit.slice(0, 8) : null,
    commitSubject,
    commitDate,
    upstreamCommit,
    localChanges: localChanges.slice(0, MAX_LISTED_FILES),
    localChangeCount: localChanges.length,
    incomingCount,
    conflictFiles: conflictFiles.slice(0, MAX_LISTED_FILES),
    conflictCount: conflictFiles.length,
  };
}

/**
 * GET /healthz on the bridge's own loopback listener.
 *
 * Port and scheme both come from runMode: the listener binds
 * settings.runModes.serve.backendPort, which is independent of env.PORT, and
 * it speaks HTTPS when a cert is configured (src/tls.ts).
 *
 * node:http(s) rather than fetch, because a bring-your-own-cert listener is
 * typically mkcert- or self-signed and fetch gives no way to relax
 * verification. Identity is not what this probe establishes — it is a liveness
 * check against 127.0.0.1, where reaching the port at all is the assurance.
 */
async function healthCheck(): Promise<{ ok: boolean; detail?: string }> {
  const run = getRunModeInfo(getConfig().settings);
  const url = `${run.backendUrl}/healthz`;

  try {
    const response = await new Promise<{ status: number; text: string }>((settle, fail) => {
      const req = (run.tls ? httpsRequest : httpRequest)(
        url,
        { timeout: 8000, ...(run.tls ? { rejectUnauthorized: false } : {}) },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () => settle({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on('timeout', () => req.destroy(new Error('health check timed out after 8000ms')));
      req.on('error', fail);
      req.end();
    });

    if (response.status < 200 || response.status >= 300) {
      return { ok: false, detail: `HTTP ${response.status}` };
    }
    const body = JSON.parse(response.text) as { status?: string };
    if (body.status !== 'ok') {
      return { ok: false, detail: `status=${String(body.status)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Run a maintenance script that will stop this very service.
 *
 * A plain detached child stays inside the service cgroup, so systemd kills it
 * the moment the unit stops — the bridge went down and never came back up.
 * `systemd-run --user --scope` moves the script into its own transient unit so
 * it survives. Plain spawn remains the fallback for non-systemd hosts.
 */
function spawnDetachedFromService(
  repoDir: string,
  scriptArgs: string[],
): { ok: boolean; detail: string } {
  const useScope = existsSync('/run/systemd/system');
  const [command, args] = useScope
    ? (['systemd-run', ['--user', '--scope', '--collect', 'bash', ...scriptArgs]] as const)
    : (['bash', scriptArgs] as const);
  try {
    const child = spawn(command, [...args], {
      cwd: repoDir,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return {
      ok: true,
      detail: useScope
        ? `spawned ${scriptArgs.join(' ')} in a transient scope`
        : `spawned ${scriptArgs.join(' ')}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Restart the entire service via scripts/restart.sh (build + systemd restart +
 * health check). Always spawned, even when squeakr-watch.path is active.
 */
async function triggerRestart(repoDir: string, runId: string): Promise<ServeOutcome> {
  const script = join(repoDir, 'scripts/restart.sh');
  if (!existsSync(script)) {
    recordStep(runId, 'restart', 'warn', `restart script missing at ${script}`);
    return 'error';
  }
  const spawned = spawnDetachedFromService(repoDir, [script]);
  recordStep(runId, 'restart', spawned.ok ? 'ok' : 'error', spawned.detail);
  return spawned.ok ? 'ok' : 'error';
}

function assertRepoDir(repoDir: string, runId: string): boolean {
  if (!existsSync(join(repoDir, 'package.json'))) {
    recordStep(runId, 'repo_check', 'error', 'package.json not found');
    return false;
  }
  return true;
}

// ── The update script: spawn it, then mirror its step log ──────────────────

interface UpdateLogLine {
  runId?: unknown;
  ts?: unknown;
  step?: unknown;
  status?: unknown;
  detail?: unknown;
}

function updateLogPath(repoDir: string): string {
  return join(repoDir, UPDATE_LOG);
}

function readUpdateLog(repoDir: string): UpdateLogLine[] {
  const path = updateLogPath(repoDir);
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const rows: UpdateLogLine[] = [];
  for (const line of splitLines(text)) {
    try {
      rows.push(JSON.parse(line) as UpdateLogLine);
    } catch {
      // a torn last line while the script is mid-write — it will be complete
      // on the next poll
    }
  }
  return rows;
}

function toEventStatus(value: unknown): ServeEventStatus {
  return value === 'ok' || value === 'skip' || value === 'warn' || value === 'error'
    ? value
    : 'ok';
}

/**
 * Copy any not-yet-recorded step lines from the script's NDJSON log into
 * `serve_event`, which is what the Serve page renders.
 *
 * The count of rows already stored for this run is the cursor. The script
 * appends in order and we insert in order, so the same file can be drained
 * repeatedly — including after the restart that killed the process mid-run —
 * without duplicating a single step. Returns the run's terminal state, if it
 * has reached one.
 */
function ingestUpdateLog(repoDir: string): {
  runId: string | null;
  finished: boolean;
  outcome: ServeOutcome;
  summary: string;
  lastTs: string | null;
} {
  const rows = readUpdateLog(repoDir);
  const runId = rows.length > 0 ? String(rows[rows.length - 1]?.runId ?? '') || null : null;
  if (!runId) {
    return { runId: null, finished: false, outcome: 'ok', summary: '', lastTs: null };
  }

  const forRun = rows.filter((row) => String(row.runId ?? '') === runId);
  const already = countServeEventsForRun(runId);
  for (const row of forRun.slice(already)) {
    addServeEvent({
      runId,
      step: String(row.step ?? 'step'),
      status: toEventStatus(row.status),
      detail: row.detail ? String(row.detail) : undefined,
    });
  }

  const last = forRun[forRun.length - 1];
  const finishRow = [...forRun].reverse().find((row) => row.step === 'finish');
  return {
    runId,
    finished: Boolean(finishRow),
    outcome: toEventStatus(finishRow?.status) === 'error' ? 'error' : 'ok',
    summary: finishRow?.detail ? String(finishRow.detail) : '',
    lastTs: last?.ts ? String(last.ts) : null,
  };
}

function stopUpdateWatch(): void {
  if (_updateTimer) clearInterval(_updateTimer);
  _updateTimer = null;
}

/**
 * Drain the script's log every {@link UPDATE_POLL_MS} until it finishes.
 *
 * The bridge is usually killed by the script's own `systemctl restart` long
 * before the run ends; `startServe()` resumes the same watch on boot, so the
 * step log the UI polls ends up complete either way.
 */
function watchUpdateRun(repoDir: string, runId: string): void {
  stopUpdateWatch();
  _updateRunId = runId;
  _running = true;

  const drain = (): void => {
    let state;
    try {
      state = ingestUpdateLog(repoDir);
    } catch (err) {
      log.warn({ err }, 'could not ingest update step log');
      return;
    }
    if (state.runId !== runId) return;

    const stale = state.lastTs
      ? Date.now() - Date.parse(state.lastTs) > UPDATE_STALE_MS
      : false;
    if (!state.finished && !stale) return;

    stopUpdateWatch();
    _updateRunId = null;
    _running = false;
    _lastRun = {
      runId,
      trigger: 'manual',
      startedAt: _lastRun?.runId === runId ? _lastRun.startedAt : new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outcome: state.finished ? state.outcome : 'error',
      summary: state.finished
        ? state.summary
        : 'Update stopped reporting — check the service logs',
    };
    void refreshGitSnapshot().catch(() => undefined);
  };

  _updateTimer = setInterval(drain, UPDATE_POLL_MS);
  _updateTimer.unref?.();
  drain();
}

/**
 * Run `scripts/update.sh` — the one update path.
 *
 * Everything that can fail cheaply is checked here first, because once the
 * script is detached the only channel left is the step log. In particular a
 * dirty tree is refused outright in `update` mode: that is the whole point of
 * having a separate "Stash, rebase & update" button.
 */
async function startUpdateRun(
  repoDir: string,
  settings: ServeSettings,
  mode: ServeUpdateMode,
  runId: string,
): Promise<{ outcome: ServeOutcome; detail: string }> {
  const script = join(repoDir, UPDATE_SCRIPT);
  if (!existsSync(script)) {
    recordStep(runId, 'preflight', 'error', `${UPDATE_SCRIPT} missing at ${script}`);
    return { outcome: 'error', detail: `Update script not found at ${script}` };
  }

  let snapshot: ServeGitSnapshot;
  try {
    snapshot = await probeGit(repoDir, settings, { fetch: true });
    _lastGit = snapshot;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordStep(runId, 'preflight', 'error', detail);
    return { outcome: 'error', detail: `Could not read repository state — ${detail}` };
  }

  const upstreamRef = `origin/${snapshot.trackBranch}`;
  if (!snapshot.upstreamCommit) {
    recordStep(runId, 'preflight', 'error', `${upstreamRef} not found`);
    return {
      outcome: 'error',
      detail: `Upstream ${upstreamRef} not found — set a track branch or push ${FALLBACK_TRACK_BRANCH}`,
    };
  }

  if (mode === 'update' && snapshot.dirty) {
    const list = (snapshot.conflictCount > 0 ? snapshot.conflictFiles : snapshot.localChanges)
      .slice(0, 10)
      .join(', ');
    const detail = snapshot.conflictCount > 0
      ? `${snapshot.conflictCount} local change(s) also changed upstream (${list}) — use “Stash, rebase & update”`
      : `${snapshot.localChangeCount} local change(s) would block the rebase (${list}) — use “Stash, rebase & update” or commit them`;
    recordStep(runId, 'preflight', 'error', detail);
    return { outcome: 'error', detail };
  }

  // Truncate first: the log is the run's transcript, and `ingestUpdateLog`
  // reads it whole. A leftover previous run would replay into this one.
  const logPath = updateLogPath(repoDir);
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, '', 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordStep(runId, 'preflight', 'error', `cannot write ${logPath}: ${detail}`);
    return { outcome: 'error', detail: `Cannot write the update log at ${logPath}` };
  }

  const args = [
    script,
    '--repo', repoDir,
    '--branch', snapshot.trackBranch,
    '--run-id', runId,
    '--log-file', logPath,
    ...(mode === 'stash-update' ? ['--stash'] : []),
  ];
  const spawned = spawnDetachedFromService(repoDir, args);
  if (!spawned.ok) {
    recordStep(runId, 'preflight', 'error', spawned.detail);
    return { outcome: 'error', detail: `Could not start the update — ${spawned.detail}` };
  }

  watchUpdateRun(repoDir, runId);
  const verb = mode === 'stash-update' ? 'Stash, rebase & update' : 'Rebase & update';
  return {
    outcome: 'ok',
    detail: `${verb} started — ${snapshot.behind} commit(s) behind ${upstreamRef}. Watch the step log; the bridge restarts at the end.`,
  };
}

async function withServeLock<T>(
  label: string,
  fn: (runId: string) => Promise<T>,
  opts: { recordStart?: boolean } = {},
): Promise<T> {
  if (_running) {
    throw new Error('Serve is already running');
  }
  _running = true;
  const runId = randomUUID();
  if (opts.recordStart !== false) recordStep(runId, 'start', 'ok', label);
  try {
    return await fn(runId);
  } finally {
    // An update run outlives this call: the detached script holds the lock
    // until it writes `finish`, and watchUpdateRun is what releases it.
    if (!_updateRunId) _running = false;
  }
}

/**
 * Re-read the repository state. `fetch` costs a network round trip but is the
 * only way the ahead/behind counts and the conflict set mean anything.
 */
let _lastNpm: ServeNpmSnapshot | null = null;

export async function refreshGitSnapshot(
  opts: { fetch?: boolean } = {},
): Promise<ServeGitSnapshot> {
  const { settings } = getConfig();
  const repoDir = resolveRepoDir(settings.serve);
  _lastGit = await probeGit(repoDir, settings.serve, opts);
  return _lastGit;
}

/**
 * Ask the registry what the newest published version is.
 *
 * Deliberately tolerant: a bridge on a home network is often offline, and a
 * failed version check must degrade to "cannot tell" rather than making the
 * whole status endpoint fail. The installed version always comes back.
 */
export async function refreshNpmSnapshot(): Promise<ServeNpmSnapshot> {
  const installed = getAppVersionInfo().appVersion;
  const snapshot: ServeNpmSnapshot = {
    installed,
    latest: null,
    updateAvailable: false,
    checkedAt: new Date().toISOString(),
  };

  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['view', PACKAGE_NAME, 'version', '--registry=https://registry.npmjs.org/'],
      { timeout: REGISTRY_TIMEOUT_MS },
    );
    const latest = stdout.trim();
    if (latest) {
      snapshot.latest = latest;
      snapshot.updateAvailable = compareSemver(latest, installed) > 0;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A 404 is not a fault — it just means nothing has been published yet.
    snapshot.error = /E404|404 Not Found/.test(message)
      ? `${PACKAGE_NAME} is not published to the registry yet`
      : `Could not reach the npm registry: ${message.split('\n')[0]}`;
  }

  _lastNpm = snapshot;
  return snapshot;
}

/** -1 / 0 / 1, comparing only the numeric release part. Prereleases sort low. */
function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  // Same release numbers: a prerelease is older than the plain version.
  const preA = a.includes('-');
  const preB = b.includes('-');
  if (preA === preB) return 0;
  return preA ? -1 : 1;
}

export function getServeStatus(): ServeStatus {
  const install = detectInstallMode();
  // Report only the snapshot that describes this install. An npm install
  // sitting in a directory that happens to be inside someone's repo would
  // otherwise answer with a branch and commit that say nothing about the
  // code actually running.
  const isGit = install.mode === 'git';
  return {
    running: _running,
    lastRun: _lastRun,
    git: isGit ? _lastGit : null,
    npm: isGit ? null : _lastNpm,
    install,
    updateRunId: _updateRunId,
  };
}

/**
 * Both update buttons land here. `update` rebases a clean tree; `stash-update`
 * stashes first and pops afterwards. One script, one flag of difference.
 */
export async function serveUpdate(mode: ServeUpdateMode): Promise<ServeActionResult> {
  const install = detectInstallMode();

  // An npm install has no repo to rebase and no working tree to stash, so both
  // buttons collapse to the same thing there: ask npm for the newer version.
  if (install.mode === 'npm' && !install.npx) return serveNpmUpdate(install);
  if (!canSelfUpdate(install)) {
    return withServeLock(`manual:${mode}`, async (runId) => {
      const detail = install.updateCommand
        ? `Cannot update automatically — ${install.reason}. Run: ${install.updateCommand}`
        : `Cannot update automatically — ${install.reason}. ` +
          'Reinstall with npm, or run this from a git clone.';
      recordStep(runId, 'finish', 'error', detail);
      return { runId, outcome: 'error' as const, detail };
    });
  }

  const { settings } = getConfig();
  const serveSettings = settings.serve;
  const repoDir = resolveRepoDir(serveSettings);

  // The script writes its own `start` step under the same run id; a second one
  // here would throw off the ingest cursor.
  return withServeLock(
    `manual:${mode}`,
    async (runId) => {
      if (!assertRepoDir(repoDir, runId)) {
        return { runId, outcome: 'error' as const, detail: 'Invalid repo directory' };
      }
      const result = await startUpdateRun(repoDir, serveSettings, mode, runId);
      if (result.outcome === 'error') {
        recordStep(runId, 'finish', 'error', result.detail);
        _lastRun = {
          runId,
          trigger: 'manual',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          outcome: 'error',
          summary: result.detail,
        };
      } else if (_lastRun?.runId !== runId) {
        // A script that failed instantly has already been drained into
        // _lastRun by watchUpdateRun — do not paper over it with "started".
        _lastRun = {
          runId,
          trigger: 'manual',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          outcome: 'ok',
          summary: result.detail,
        };
      }
      return { runId, outcome: result.outcome, detail: result.detail };
    },
    { recordStart: false },
  );
}

/**
 * Update an npm install: let npm replace the package, then restart the unit.
 *
 * Unlike the git path this is not a detached script — `npm install` is short,
 * and the bridge is only killed afterwards by the restart, so the step log can
 * be written inline and will survive.
 */
async function serveNpmUpdate(install: InstallModeInfo): Promise<ServeActionResult> {
  return withServeLock('manual:update', async (runId) => {
    recordStep(runId, 'install_mode', 'ok', `npm install (${install.reason})`);

    const snapshot = await refreshNpmSnapshot();
    if (snapshot.error) {
      recordStep(runId, 'registry_check', 'warn', snapshot.error);
    } else {
      recordStep(
        runId,
        'registry_check',
        'ok',
        `installed ${snapshot.installed}, latest ${snapshot.latest ?? 'unknown'}`,
      );
    }

    if (snapshot.latest && !snapshot.updateAvailable) {
      const detail = `Already on ${snapshot.installed} — nothing newer published`;
      recordStep(runId, 'finish', 'ok', detail);
      _lastRun = finishedRun(runId, 'ok', detail);
      return { runId, outcome: 'no_changes' as const, detail };
    }

    const args = ['install', ...(install.global ? ['-g'] : []), `${PACKAGE_NAME}@latest`];
    try {
      await execFileAsync('npm', [...args, '--no-audit', '--no-fund'], {
        // A local install has to run in the project that depends on us, or npm
        // installs a second copy into whatever the bridge's cwd happens to be.
        ...(install.global ? {} : { cwd: npmProjectDir(install.root) }),
        timeout: 10 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      recordStep(runId, 'npm_install', 'ok', `npm ${args.join(' ')}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const detail = `npm ${args.join(' ')} failed: ${message.split('\n')[0]}`;
      recordStep(runId, 'npm_install', 'error', detail);
      recordStep(runId, 'finish', 'error', detail);
      _lastRun = finishedRun(runId, 'error', detail);
      return { runId, outcome: 'error' as const, detail };
    }

    const restarted = await restartServiceUnit(runId);
    const detail = restarted
      ? `Updated to ${snapshot.latest ?? 'the latest version'} and restarted`
      : `Updated to ${snapshot.latest ?? 'the latest version'} — restart it to pick it up`;
    recordStep(runId, 'finish', restarted ? 'ok' : 'warn', detail);
    _lastRun = finishedRun(runId, 'ok', detail);
    return { runId, outcome: 'ok' as const, detail };
  });
}

function finishedRun(runId: string, outcome: ServeOutcome, summary: string): ServeRunResult {
  const at = new Date().toISOString();
  return { runId, trigger: 'manual', startedAt: at, finishedAt: at, outcome, summary };
}

/**
 * Restart the service directly, for installs with no scripts/ directory.
 * User unit first, then the system unit via passwordless sudo — the same order
 * scripts/update.sh uses, so the two paths cannot disagree about which unit wins.
 */
async function restartServiceUnit(runId: string): Promise<boolean> {
  const attempts: Array<{ label: string; cmd: string; args: string[] }> = [
    { label: 'user unit', cmd: 'systemctl', args: ['--user', 'restart', SERVICE_UNIT] },
    { label: 'system unit', cmd: 'sudo', args: ['-n', 'systemctl', 'restart', SERVICE_UNIT] },
  ];
  for (const attempt of attempts) {
    try {
      await execFileAsync(attempt.cmd, attempt.args, { timeout: 60_000 });
      recordStep(runId, 'restart', 'ok', `${attempt.label} restarted`);
      return true;
    } catch {
      // Try the next one; only the last failure is worth reporting.
    }
  }
  recordStep(
    runId,
    'restart',
    'warn',
    `no ${SERVICE_UNIT} could be restarted — install one with scripts/install-systemd.sh, or restart by hand`,
  );
  return false;
}

export async function serveRestart(): Promise<ServeActionResult> {
  const { settings } = getConfig();
  const repoDir = resolveRepoDir(settings.serve);

  return withServeLock('manual:restart', async (runId) => {
    // Only a clone has scripts/restart.sh (which also rebuilds). Anywhere else,
    // the unit is the only thing to restart.
    if (detectInstallMode().mode !== 'git') {
      const ok = await restartServiceUnit(runId);
      const detail = ok ? 'Service restarted' : 'Could not restart the service';
      recordStep(runId, 'finish', ok ? 'ok' : 'error', detail);
      _lastRun = finishedRun(runId, ok ? 'ok' : 'error', detail);
      return { runId, outcome: ok ? ('ok' as const) : ('error' as const), detail };
    }
    const outcome = await triggerRestart(repoDir, runId);
    const detail = outcome === 'ok'
      ? 'Restart script spawned (build + systemd restart)'
      : 'Restart failed';
    recordStep(runId, 'finish', outcome === 'error' ? 'error' : 'ok', detail);
    _lastRun = {
      runId,
      trigger: 'manual',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outcome,
      summary: detail,
    };
    return { runId, outcome, detail };
  });
}

export async function serveHealthCheck(): Promise<ServeActionResult> {
  const { settings } = getConfig();
  const repoDir = resolveRepoDir(settings.serve);

  return withServeLock('manual:health', async (runId) => {
    try {
      if (detectInstallMode().mode === 'git') {
        await refreshGitSnapshot();
      } else {
        await refreshNpmSnapshot();
      }
    } catch {
      // non-fatal
    }
    const health = await healthCheck();
    recordStep(
      runId,
      'health_check',
      health.ok ? 'ok' : 'warn',
      health.detail ?? 'ok',
    );
    const detail = health.ok
      ? `Healthy — ${repoDir}`
      : `Health check failed — ${health.detail ?? 'unknown'}`;
    recordStep(runId, 'finish', health.ok ? 'ok' : 'warn', detail);
    return {
      runId,
      outcome: health.ok ? 'ok' : 'error',
      detail,
    };
  });
}

export async function runServeAction(action: ServeActionId): Promise<ServeActionResult> {
  switch (action) {
    case 'update':
    case 'stash-update':
      return serveUpdate(action);
    case 'restart':
      return serveRestart();
    case 'health':
      return serveHealthCheck();
    default:
      throw new Error(`Unknown serve action: ${String(action)}`);
  }
}

/**
 * journalctl arguments for the bridge unit — user unit first, then system —
 * or null when neither has any entries. That is the normal case for an npm
 * install or a manual `node dist/index.js`, where the session .log file is the
 * only record (see logging/sessionLog.ts).
 *
 * The unit only counts when this process is its current run: some of its
 * entries carry our INVOCATION_ID. Otherwise a second install, a dev bridge
 * or a test instance would show another bridge's journal as its own. Children
 * of any unit inherit INVOCATION_ID, so its presence alone proves nothing;
 * distrobox-enter passes it into the container unchanged.
 */
export async function journalctlUnitArgs(
  env: NodeJS.ProcessEnv = process.env,
  run: typeof runCommand = runCommand,
): Promise<string[] | null> {
  const invocation = env['INVOCATION_ID']?.trim();
  if (!invocation || !/^[0-9a-f]{32}$/.test(invocation)) return null;
  for (const unitArgs of [['--user', '-u', SERVICE_UNIT], ['-u', SERVICE_UNIT]]) {
    try {
      const probe = await run(process.cwd(), 'journalctl', [
        ...unitArgs,
        `_SYSTEMD_INVOCATION_ID=${invocation}`,
        '-n',
        '1',
        '--no-pager',
        '-o',
        'cat',
        '-q',
      ]);
      if (probe.code === 0 && probe.stdout.trim()) return unitArgs;
    } catch {
      // journalctl missing (macOS, Windows, containers)
    }
  }
  return null;
}

/** The current session log file, as the fallback when journald has nothing. */
function sessionLogFile(): string | null {
  const path = getSessionLog()?.path ?? null;
  return path && existsSync(path) ? path : null;
}

/**
 * Read recent log lines for the bridge: journald when the service logs there,
 * otherwise the session .log file. argv is fixed; only `lines` is clamped.
 */
export async function getServeServiceLogs(lines = 80): Promise<ServeServiceLogs> {
  const n = Math.min(Math.max(Math.floor(lines) || 80, 1), 500);
  const unitArgs = await journalctlUnitArgs();
  if (!unitArgs) {
    const file = sessionLogFile();
    if (!file) {
      return {
        unit: SERVICE_UNIT,
        lines: n,
        text: '',
        ok: false,
        detail: 'No journald entries for the bridge and no session log file — is settings.logging.files off?',
      };
    }
    return {
      unit: `file:${file.split('/').pop()}`,
      lines: n,
      text: tailLines(file, n).join('\n'),
      ok: true,
      detail: `journald has no entries for ${SERVICE_UNIT} — showing the session log ${file}`,
    };
  }
  try {
    const { code, stdout, stderr } = await runCommand(process.cwd(), 'journalctl', [
      ...unitArgs,
      '-n',
      String(n),
      '--no-pager',
      '-o',
      'short-iso',
    ]);
    if (code !== 0) {
      const detail = (stderr || stdout).trim().slice(0, 400) || `exit ${code}`;
      return { unit: SERVICE_UNIT, lines: n, text: '', ok: false, detail };
    }
    return { unit: SERVICE_UNIT, lines: n, text: stdout.trimEnd(), ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { unit: SERVICE_UNIT, lines: n, text: '', ok: false, detail };
  }
}

export interface ServeLogFollow {
  unit: string;
  stop: () => void;
}

/**
 * Follow journalctl -f for the bridge unit. Caller must stop() on disconnect.
 */
export async function followServeServiceLogs(opts: {
  lines?: number;
  onLine: (line: string) => void;
  onError: (detail: string) => void;
  onClose: (code: number | null) => void;
}): Promise<ServeLogFollow> {
  const n = Math.min(Math.max(Math.floor(opts.lines ?? 80) || 80, 1), 200);
  const unitArgs = await journalctlUnitArgs();
  if (!unitArgs) {
    const file = sessionLogFile();
    if (!file) throw new Error('No journald entries for the bridge and no session log file to follow');
    for (const line of tailLines(file, n)) opts.onLine(line);
    const follow = followFile(sessionLogFile, (line) => {
      if (line.length > 0) opts.onLine(line);
    });
    return { unit: `file:${file.split('/').pop()}`, stop: follow.stop };
  }
  const child: ChildProcess = spawn(
    'journalctl',
    [...unitArgs, '-n', String(n), '-f', '--no-pager', '-o', 'short-iso'],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let buffer = '';
  const flush = (chunk: string, emitPartial: boolean): void => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      if (line.length > 0) opts.onLine(line);
    }
    if (emitPartial && buffer.length > 0) {
      opts.onLine(buffer);
      buffer = '';
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    flush(chunk.toString(), false);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) opts.onError(text.slice(0, 400));
  });
  child.on('error', (err) => {
    opts.onError(err.message);
  });
  child.on('close', (code) => {
    flush('', true);
    opts.onClose(code);
  });

  return {
    unit: SERVICE_UNIT,
    stop: () => {
      if (child.killed || child.exitCode !== null) return;
      child.kill('SIGTERM');
    },
  };
}

/**
 * Boot hook (no scheduler).
 *
 * Also resumes the step log of an update that was still running when its own
 * `systemctl restart` killed us — without this, every update's log would stop
 * at the restart step and the UI would look like the run vanished.
 */
export async function startServe(): Promise<void> {
  const { settings } = getConfig();
  const repoDir = resolveRepoDir(settings.serve);
  try {
    const pending = ingestUpdateLog(repoDir);
    if (pending.runId && !pending.finished) {
      log.info({ runId: pending.runId }, 'resuming update step log after restart');
      watchUpdateRun(repoDir, pending.runId);
    } else if (pending.runId) {
      _lastRun = {
        runId: pending.runId,
        trigger: 'manual',
        startedAt: pending.lastTs ?? new Date().toISOString(),
        finishedAt: pending.lastTs ?? new Date().toISOString(),
        outcome: pending.outcome,
        summary: pending.summary,
      };
    }
  } catch (err) {
    log.warn({ err }, 'could not resume update step log');
  }

  try {
    await refreshGitSnapshot();
  } catch (err) {
    log.warn({ err }, 'initial git snapshot failed');
  }
}
