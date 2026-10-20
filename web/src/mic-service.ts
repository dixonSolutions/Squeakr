/**
 * One microphone owner for the app's lifetime (docs/40 §4, #66).
 *
 * Four separate places used to call `getUserMedia` on their own — the
 * session's shared stream, the Vosk wake-word spotter, server STT, and the
 * wake-word test page — and each of them called `track.stop()` when it was
 * done. Stopping the last track releases the device, so the *next* session
 * asked the browser for the microphone all over again. On iOS Safari, where a
 * site defaults to "Ask", that is a permission prompt every single time the
 * user starts talking, which is the one thing a hands-free interface cannot
 * afford.
 *
 * So: acquire once, hand the same `MediaStream` to every borrower, and mute
 * (`track.enabled = false`) rather than stop when the last one lets go. The
 * device is released only after a quiet period, because an open microphone
 * keeps the browser's recording indicator lit and users reasonably read that
 * as the app listening when it is not.
 *
 * What the platform will and will not do, since the design turns on it:
 *
 *   - Chrome (desktop and Android) generally remembers a granted microphone
 *     per HTTPS origin; Android may offer "only this time", which this cannot
 *     override.
 *   - Safari on iOS defaults to "Ask" per site and home-screen PWAs have
 *     historically re-prompted more often. Keeping the track alive is what
 *     avoids the repeat prompt within a session; across launches the user has
 *     to set the site to "Allow" themselves, which the onboarding card
 *     explains.
 *   - Firefox grants are temporary unless "Remember this decision" is ticked.
 *   - No web page can make audio *playback* permanent — a user gesture is
 *     required after every launch. The orb tap is that gesture.
 *
 * The native shell (docs/20) is the only way to get OS-level persistence.
 *
 * Which microphone: the one picked in Config → Audio & devices (docs/49), as
 * an `ideal` deviceId so a headset that has since been unplugged falls back
 * to the system default instead of failing. On iOS, picking the Bluetooth
 * headset's microphone also moves playback to its hands-free profile — that
 * is the OS, not this code.
 */

import { MIC_MEDIA_CONSTRAINTS } from './audio.js';
import { getAudioPrefs } from './audio-prefs.js';

export type MicPermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';

export interface MicLease {
  stream: MediaStream;
  /** Give the stream back. The device is released only when the last lease goes. */
  release(): void;
}

/** How long the microphone stays warm with no borrowers before it is released. */
const DEFAULT_KEEP_WARM_MS = 3 * 60_000;

let stream: MediaStream | null = null;
let leases = 0;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let keepWarmMs = DEFAULT_KEEP_WARM_MS;
let pending: Promise<MediaStream> | null = null;

const permissionListeners = new Set<(state: MicPermissionState) => void>();
let lastKnownPermission: MicPermissionState = 'unsupported';
let permissionWatchStarted = false;

/** Change how long the mic stays warm between sessions (0 releases at once). */
export function setMicKeepWarmMs(ms: number): void {
  keepWarmMs = Math.max(0, ms);
}

/**
 * Ask the browser what the microphone permission currently is, without
 * triggering a prompt.
 *
 * The app never checked this before, so it could not tell "denied" from "not
 * asked yet" and showed the same generic failure for both.
 */
export async function micPermissionState(): Promise<MicPermissionState> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) {
    return 'unsupported';
  }
  try {
    // The `microphone` name is not in every browser's enum — hence the cast
    // and the catch. An unsupported query is not an error, it is an answer.
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    lastKnownPermission = status.state as MicPermissionState;
    return lastKnownPermission;
  } catch {
    return 'unsupported';
  }
}

/** Subscribe to permission changes (the user flipping it in site settings). */
export function onMicPermissionChange(fn: (state: MicPermissionState) => void): () => void {
  permissionListeners.add(fn);
  void startPermissionWatch();
  return () => permissionListeners.delete(fn);
}

async function startPermissionWatch(): Promise<void> {
  if (permissionWatchStarted) return;
  permissionWatchStarted = true;
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    lastKnownPermission = status.state as MicPermissionState;
    status.addEventListener('change', () => {
      lastKnownPermission = status.state as MicPermissionState;
      for (const fn of permissionListeners) fn(lastKnownPermission);
    });
  } catch {
    permissionWatchStarted = false;
  }
}

/** Last state seen, without awaiting a query. */
export function cachedMicPermission(): MicPermissionState {
  return lastKnownPermission;
}

/**
 * Borrow the shared microphone stream.
 *
 * Must be called from inside a user gesture the first time, or the browser
 * will refuse — that is the platform rule, not a choice here.
 */
export async function acquireMic(): Promise<MicLease> {
  if (releaseTimer !== null) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }

  if (!stream || !isStreamLive(stream)) {
    // Concurrent callers share one getUserMedia call; two would be two prompts.
    pending ??= openMicrophone().finally(() => {
      pending = null;
    });
    stream = await pending;
  }

  for (const track of stream.getAudioTracks()) track.enabled = true;
  leases++;

  let released = false;
  const live = stream;
  return {
    stream: live,
    release() {
      if (released) return;
      released = true;
      leases = Math.max(0, leases - 1);
      if (leases === 0) scheduleRelease();
    },
  };
}

/** Audio constraints for the chosen microphone (system default when none is chosen). */
export function micConstraintsFor(deviceId: string | null): MediaTrackConstraints {
  return deviceId ? { ...MIC_MEDIA_CONSTRAINTS, deviceId: { ideal: deviceId } } : MIC_MEDIA_CONSTRAINTS;
}

async function openMicrophone(): Promise<MediaStream> {
  const deviceId = getAudioPrefs().inputDeviceId;
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: micConstraintsFor(deviceId), video: false });
  } catch (err) {
    // `ideal` should never over-constrain, but some engines treat a stale id
    // as fatal. A permission refusal is not retried — that would prompt twice.
    const name = (err as { name?: string } | null)?.name;
    if (!deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw err;
    return navigator.mediaDevices.getUserMedia({ audio: MIC_MEDIA_CONSTRAINTS, video: false });
  }
}

/** deviceId the shared stream is actually using, if open. */
export function currentMicDeviceId(): string | null {
  const track = currentMicStream()?.getAudioTracks()[0];
  return track?.getSettings?.().deviceId ?? null;
}

/**
 * The user picked a different microphone. An idle stream is dropped so the
 * next borrower opens the new device; a stream in use cannot be swapped under
 * its audio graphs, so the caller is told a restart is needed.
 */
export function onMicDeviceChosen(): { restartNeeded: boolean } {
  if (!stream) return { restartNeeded: false };
  if (leases === 0) {
    releaseMicNow();
    return { restartNeeded: false };
  }
  return { restartNeeded: true };
}

/** Borrowers holding the shared stream right now. */
export function micLeaseCount(): number {
  return leases;
}

/** The live shared stream, if one is already open. */
export function currentMicStream(): MediaStream | null {
  return stream && isStreamLive(stream) ? stream : null;
}

/** Mute every track without releasing the device (mic mute in the UI). */
export function setMicEnabled(enabled: boolean): void {
  if (!stream) return;
  for (const track of stream.getAudioTracks()) track.enabled = enabled;
}

/**
 * Release the device now, whatever the keep-warm setting says.
 *
 * Used when the user explicitly ends a session and wants the browser's
 * recording indicator to go out immediately.
 */
export function releaseMicNow(): void {
  if (releaseTimer !== null) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  leases = 0;
}

function scheduleRelease(): void {
  // Muting immediately is what makes this safe to keep open: the tracks
  // produce silence the moment the last borrower leaves.
  setMicEnabled(false);
  if (keepWarmMs === 0) {
    releaseMicNow();
    return;
  }
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (leases === 0) releaseMicNow();
  }, keepWarmMs);
}

function isStreamLive(s: MediaStream): boolean {
  return s.getAudioTracks().some((track) => track.readyState === 'live');
}

/** Test/diagnostic view of the shared microphone. */
export function micDebugState(): {
  open: boolean;
  leases: number;
  enabled: boolean;
  keepWarmMs: number;
} {
  return {
    open: stream !== null && isStreamLive(stream),
    leases,
    enabled: stream?.getAudioTracks().some((t) => t.enabled) ?? false,
    keepWarmMs,
  };
}

/** Per-browser wording for the onboarding card when permission is not granted. */
export function micPermissionHelp(): { title: string; steps: string[] } {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in globalThis);
  const isFirefox = /Firefox\//.test(ua);
  const isAndroidChrome = /Android/.test(ua) && /Chrome\//.test(ua);

  if (isIos) {
    return {
      title: 'Let Safari remember the microphone',
      steps: [
        'Tap the "aA" or "···" button in the address bar.',
        'Choose Website Settings.',
        'Set Microphone to Allow.',
        'For a home-screen app, add it again after changing the setting.',
      ],
    };
  }
  if (isFirefox) {
    return {
      title: 'Let Firefox remember the microphone',
      steps: [
        'Tap the microphone icon in the address bar.',
        'Tick "Remember this decision" before allowing.',
        'Firefox forgets the grant when the tab closes otherwise.',
      ],
    };
  }
  if (isAndroidChrome) {
    return {
      title: 'Let Chrome remember the microphone',
      steps: [
        'Tap the lock icon next to the address.',
        'Open Permissions, then Microphone.',
        'Choose Allow — not "Only this time", which re-asks every visit.',
      ],
    };
  }
  return {
    title: 'Allow the microphone for this site',
    steps: [
      'Open the site settings from the padlock in the address bar.',
      'Set Microphone to Allow.',
      'Reload the page.',
    ],
  };
}
