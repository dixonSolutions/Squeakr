import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_AUDIO_PREFS,
  MAX_BOOST_DB,
  WAKE_DEFAULT_THRESHOLD,
  WAKE_MOST_SENSITIVE_THRESHOLD,
  WAKE_STRICTEST_THRESHOLD,
  classifyAudioDevice,
  gainToDb,
  getAudioPrefs,
  loudnessLabel,
  loudnessToGain,
  matchRememberedDevice,
  normalizeAudioPrefs,
  onAudioPrefsChange,
  resetAudioPrefsCacheForTests,
  sliderToSpeed,
  speedLabel,
  speedToSlider,
  splitLoudness,
  updateAudioPrefs,
  wakeSensitivityLabel,
  wakeSensitivityToThreshold,
  wakeThresholdToSensitivity,
} from './audio-prefs.js';

class MemoryStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

describe('loudness', () => {
  it('middle is unity gain, 0 is silent, top is +MAX_BOOST_DB', () => {
    near(loudnessToGain(50), 1);
    assert.equal(loudnessToGain(0), 0);
    near(gainToDb(loudnessToGain(100)), MAX_BOOST_DB);
  });

  it('rises monotonically across the whole slider', () => {
    let prev = -1;
    for (let s = 0; s <= 100; s++) {
      const g = loudnessToGain(s);
      assert.ok(g > prev || (s === 0 && g === 0), `not increasing at ${s}`);
      prev = g;
    }
  });

  it('splits into an attenuation that is never above 1 and a boost never below 1', () => {
    for (let s = 0; s <= 100; s += 5) {
      const { attenuation, boost } = splitLoudness(s);
      assert.ok(attenuation <= 1 && attenuation >= 0);
      assert.ok(boost >= 1);
      near(attenuation * boost, loudnessToGain(s));
    }
    assert.deepEqual(splitLoudness(50), { attenuation: 1, boost: 1 });
  });

  it('labels', () => {
    assert.equal(loudnessLabel(0), 'Muted');
    assert.equal(loudnessLabel(50), 'Default');
    assert.equal(loudnessLabel(100), '+12.0 dB');
    assert.equal(loudnessLabel(25), '-12.0 dB');
  });

  it('clamps garbage', () => {
    near(loudnessToGain(Number.NaN), 1);
    near(loudnessToGain(500), loudnessToGain(100));
  });
});

describe('speech speed', () => {
  it('½× … 1× … 2× with the middle exactly 1', () => {
    near(sliderToSpeed(0), 0.5);
    assert.equal(sliderToSpeed(50), 1);
    near(sliderToSpeed(100), 2);
  });

  it('round-trips through the slider', () => {
    for (const speed of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
      near(sliderToSpeed(speedToSlider(speed)), speed, 1e-9);
    }
  });

  it('labels', () => {
    assert.equal(speedLabel(50), 'Default (1×)');
    assert.equal(speedLabel(100), '2.0×');
    assert.equal(speedLabel(0), '0.5×');
  });
});

describe('wake sensitivity', () => {
  it('middle is the shipped threshold; right is more sensitive (lower threshold)', () => {
    assert.equal(wakeSensitivityToThreshold(50), WAKE_DEFAULT_THRESHOLD);
    assert.equal(wakeSensitivityToThreshold(100), WAKE_MOST_SENSITIVE_THRESHOLD);
    assert.equal(wakeSensitivityToThreshold(0), WAKE_STRICTEST_THRESHOLD);
    assert.ok(wakeSensitivityToThreshold(75) < wakeSensitivityToThreshold(25));
  });

  it('round-trips the legacy presets onto the slider', () => {
    for (const threshold of [0.45, 0.65, 0.8, 0.3, 0.15, 0.85]) {
      const slider = wakeThresholdToSensitivity(threshold);
      near(wakeSensitivityToThreshold(slider), threshold, 0.01);
    }
    assert.equal(wakeThresholdToSensitivity(0.45), 50);
  });

  it('thresholds outside the slider range land on its ends', () => {
    assert.equal(wakeThresholdToSensitivity(0), 100);
    assert.equal(wakeThresholdToSensitivity(1), 0);
  });

  it('labels', () => {
    assert.equal(wakeSensitivityLabel(50), 'Default');
    assert.equal(wakeSensitivityLabel(90), 'Very sensitive');
    assert.equal(wakeSensitivityLabel(30), 'Strict');
  });
});

describe('devices', () => {
  it('classifies common labels', () => {
    assert.equal(classifyAudioDevice('AirPods Pro (Bluetooth)'), 'bluetooth');
    assert.equal(classifyAudioDevice('iPhone Microphone'), 'built-in');
    assert.equal(classifyAudioDevice('MacBook Pro Microphone (Built-in)'), 'built-in');
    assert.equal(classifyAudioDevice('Jabra Evolve2 65'), 'bluetooth');
    assert.equal(classifyAudioDevice('USB Audio Device'), 'usb');
    assert.equal(classifyAudioDevice('Headphones (Realtek)'), 'headset');
    assert.equal(classifyAudioDevice('Default - Speakers', 'default'), 'default');
  });

  it('finds a remembered device by id, then by label, else null', () => {
    const list = [
      { deviceId: 'a', label: 'Built-in Microphone' },
      { deviceId: 'b2', label: 'AirPods' },
    ];
    assert.equal(matchRememberedDevice(list, 'a', null)?.deviceId, 'a');
    // Safari rotated the id; the label still finds it.
    assert.equal(matchRememberedDevice(list, 'b1', 'AirPods')?.deviceId, 'b2');
    assert.equal(matchRememberedDevice(list, 'gone', 'Gone headset'), null);
    assert.equal(matchRememberedDevice(list, null, null), null);
  });
});

describe('storage', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
    resetAudioPrefsCacheForTests();
  });

  it('defaults when nothing is stored', () => {
    assert.deepEqual(getAudioPrefs(), DEFAULT_AUDIO_PREFS);
  });

  it('persists and notifies', () => {
    const seen: number[] = [];
    onAudioPrefsChange((p) => seen.push(p.loudness));
    updateAudioPrefs({ loudness: 80, inputDeviceId: 'mic-1', inputLabel: 'USB mic' });
    assert.deepEqual(seen, [80]);
    resetAudioPrefsCacheForTests();
    const back = getAudioPrefs();
    assert.equal(back.loudness, 80);
    assert.equal(back.inputDeviceId, 'mic-1');
    assert.equal(back.speed, 50);
  });

  it('survives corrupt storage', () => {
    globalThis.localStorage.setItem('sq-audio-prefs', '{not json');
    assert.deepEqual(getAudioPrefs(), DEFAULT_AUDIO_PREFS);
  });

  it('normalizes hostile values', () => {
    assert.deepEqual(
      normalizeAudioPrefs({ loudness: 'loud', speed: -4, inputDeviceId: 7, outputDeviceId: '' }),
      { ...DEFAULT_AUDIO_PREFS, speed: 0 },
    );
  });
});
