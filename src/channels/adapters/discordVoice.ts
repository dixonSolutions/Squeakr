/**
 * One Discord voice connection, wired to a `VoiceCall` (../voiceCall.ts).
 *
 * In: `@discordjs/voice` hands each speaking member's audio as Opus packets
 * (decrypted, DAVE included). Each packet is decoded to 48 kHz stereo,
 * downmixed and resampled to the 16 kHz mono the speech pipeline takes.
 * Discord sends nothing while someone is silent, so the end of a member's
 * audio stream (after `segmentSilenceMs` of quiet) is what cuts their segment.
 *
 * Out: each reply arrives as PCM chunks while it is synthesized; they are
 * resampled to 48 kHz stereo and fed to an audio player as a raw stream, which
 * `@discordjs/voice` encodes to Opus and paces — the first words play while
 * the rest is still being made.
 *
 * Only allowlisted members are listened to; anyone else's audio is dropped.
 */

import { PassThrough } from 'node:stream';
import type * as VoiceNs from '@discordjs/voice';
import type { AudioPlayer, VoiceConnection } from '@discordjs/voice';
import { childLogger } from '../../log.js';
import type { PcmStream } from '../../providers/speech/output/types.js';
import { downmixPcm16, monoToStereoPcm16, OpusDecoder, OPUS_RATE, resamplePcm16 } from '../audio.js';
import { VoiceCall } from '../voiceCall.js';

const log = childLogger('channels:discord-voice');

type VoiceModule = typeof VoiceNs;

export interface DiscordCallOptions {
  voice: VoiceModule;
  guildId: string;
  channelId: string;
  channelName: string;
  adapterCreator: Parameters<VoiceModule['joinVoiceChannel']>[0]['adapterCreator'];
  isAllowed(userId: string): boolean;
  nameOf(userId: string): string;
  onLine?: ConstructorParameters<typeof VoiceCall>[0]['onLine'];
  onNotice?(text: string): void;
  onActivity?(line: string): void;
  greeting?: string;
  /** The call ended — `reason` when it broke (an error was read out first, or the connection dropped). */
  onEnded?(reason?: string): void;
  /** Tests: the call's speech/agent dependencies and the end-of-speech silence. */
  callDeps?: ConstructorParameters<typeof VoiceCall>[0]['deps'];
  silenceMs?: number;
}

export class DiscordCall {
  readonly call: VoiceCall;
  private connection: VoiceConnection | null = null;
  private player: AudioPlayer | null = null;
  private readonly listening = new Set<string>();
  private ended = false;

  constructor(private readonly opts: DiscordCallOptions) {
    this.call = new VoiceCall({
      name: `Discord call in ${opts.channelName}`,
      source: 'discord',
      sink: { play: (pcm, signal) => this.play(pcm, signal) },
      ...(opts.onLine ? { onLine: opts.onLine } : {}),
      ...(opts.onNotice ? { onNotice: opts.onNotice } : {}),
      ...(opts.onActivity ? { onActivity: opts.onActivity } : {}),
      ...(opts.greeting ? { greeting: opts.greeting } : {}),
      ...(opts.callDeps ? { deps: opts.callDeps } : {}),
      onBroken: (reason) => void this.leave(reason),
    });
  }

  get channelId(): string {
    return this.opts.channelId;
  }

  async join(): Promise<void> {
    const v = this.opts.voice;
    const connection = v.joinVoiceChannel({
      guildId: this.opts.guildId,
      channelId: this.opts.channelId,
      adapterCreator: this.opts.adapterCreator,
      selfDeaf: false,
      selfMute: false,
      debug: true,
    });
    this.connection = connection;
    // End-to-end encryption (DAVE) is where calls go quiet without an error — keep its trail.
    connection.on('debug', (message: string) => {
      if (message.includes('[DAVE]')) log.debug({ message: message.slice(0, 300) }, 'voice encryption');
    });
    try {
      await v.entersState(connection, v.VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      connection.destroy();
      throw new Error(`Could not connect to the voice channel: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.encryptionReady(connection);
    this.player = v.createAudioPlayer({ behaviors: { noSubscriber: v.NoSubscriberBehavior.Pause } });
    connection.subscribe(this.player);
    connection.receiver.speaking.on('start', (userId: string) => this.listen(userId));
    connection.on(v.VoiceConnectionStatus.Disconnected, () => {
      // Moved between channels reconnects by itself; anything else is a hang-up.
      Promise.race([
        v.entersState(connection, v.VoiceConnectionStatus.Signalling, 5_000),
        v.entersState(connection, v.VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => void this.leave('the connection to the voice channel dropped'));
    });
    connection.on(v.VoiceConnectionStatus.Destroyed, () => void this.leave());
    this.call.start();
    log.info({ guild: this.opts.guildId, channel: this.opts.channelName }, 'discord call joined');
  }

  /**
   * Voice calls are end-to-end encrypted (DAVE). The connection reports Ready
   * before the MLS group is set up, and until it is the library sends audio
   * unencrypted — which clients drop, so the join cue was never heard. Wait
   * (briefly) for the session before anything is played.
   */
  private async encryptionReady(connection: VoiceConnection, timeoutMs = 5_000): Promise<void> {
    type Dave = { protocolVersion?: number; session?: { ready?: boolean } };
    const dave = (): Dave | undefined =>
      (connection.state as { networking?: { state?: { dave?: Dave } } } | undefined)?.networking?.state?.dave;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const d = dave();
      if (!d || d.protocolVersion === 0 || d.session?.ready) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    log.warn({ channel: this.opts.channelName }, 'end-to-end encryption still not ready — the first sounds may not be heard');
  }

  async leave(reason?: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.call.close();
    this.player?.stop(true);
    try {
      this.connection?.destroy();
    } catch {
      // already destroyed
    }
    this.opts.onEnded?.(reason);
  }

  private listen(userId: string): void {
    if (this.ended || this.listening.has(userId) || !this.connection) return;
    if (!this.opts.isAllowed(userId)) return;
    const v = this.opts.voice;
    // Discord sends nothing while someone is quiet: the receive stream ending is the pause.
    const silenceMs = this.opts.silenceMs ?? this.call.endOfSpeechMs;
    const stream = this.connection.receiver.subscribe(userId, {
      end: { behavior: v.EndBehaviorType.AfterSilence, duration: silenceMs },
    });
    const decoder = new OpusDecoder(2);
    const name = this.opts.nameOf(userId);
    this.listening.add(userId);
    stream.on('data', (packet: Buffer) => {
      try {
        const stereo48 = decoder.decode(packet);
        this.call.pushAudio(userId, name, resamplePcm16(downmixPcm16(stereo48, 2), OPUS_RATE, 16_000));
      } catch (err) {
        log.debug({ err, userId }, 'dropped an undecodable opus packet');
      }
    });
    const done = () => {
      if (!this.listening.delete(userId)) return;
      decoder.close();
      this.call.speakerPaused(userId);
    };
    stream.once('end', done);
    stream.once('close', done);
    stream.once('error', (err: Error) => {
      log.warn({ err, userId }, 'discord receive stream failed');
      done();
    });
  }

  private async play(pcm: PcmStream, signal: AbortSignal): Promise<void> {
    const v = this.opts.voice;
    const player = this.player;
    if (!player || this.ended) return;
    const raw = new PassThrough({ highWaterMark: 1 << 16 });
    const resource = v.createAudioResource(raw, { inputType: v.StreamType.Raw });
    const pump = (async () => {
      try {
        for await (const chunk of pcm.chunks) {
          if (signal.aborted) break;
          // Discord plays 48 kHz stereo; Raw input is encoded to Opus by the library.
          const out = monoToStereoPcm16(resamplePcm16(chunk, pcm.sampleRate, OPUS_RATE));
          if (!raw.write(out)) await new Promise<void>((r) => raw.once('drain', () => r()));
        }
      } finally {
        raw.end();
      }
    })();
    player.play(resource);
    await new Promise<void>((resolve) => {
      const finish = () => {
        player.off(v.AudioPlayerStatus.Idle, finish);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        player.stop(true);
        finish();
      };
      player.on(v.AudioPlayerStatus.Idle, finish);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    await pump.catch(() => undefined);
  }
}
