/** WAV files for agent-audio tests. */

/** A WAV file: `ms` of a tone at `rate` × `channels`, 16-bit PCM. */
export function wav(ms: number, rate = 44_100, channels = 2): Buffer {
  const frames = Math.round((rate * ms) / 1000);
  const data = Buffer.alloc(frames * channels * 2);
  for (let f = 0; f < frames; f++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * f) / rate) * 0.3 * 32767);
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, (f * channels + c) * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
