# Wake / noise bench corpus

Speech for measuring wake-phrase spotting, false triggers and call noise
suppression. The results are in
[docs/50](../../50-wake-accuracy-and-call-denoise.md). The bench itself is
the `wake-noise-bench` Claude skill (`.claude/skills/wake-noise-bench/`).

- **398 clips**, about 13 minutes in total.
- **Format:** Ogg/Opus, mono, 48 kHz, 48 kbps, written with
  `encodeOggOpus` (`src/channels/audio.ts`). That is the same codec Discord
  sends.
- **Voices:** generated with Kokoro-82M (via speaches), so there are no
  recordings of real people.

`manifest.json` lists the phrases under test and every clip:

| `set` | Clips | What |
|---|---|---|
| `wake` | 380 | `split` `dev` (14 voices, for tuning) / `test` (14 other voices and sentences, held out); `kind` `pos` / `near` / `talk` |
| `commands` | 12 | Spoken commands, for transcription accuracy |
| `babble` | 6 | Conversation, layered into the "babble" noise |

For the `wake` clips:
- `kind`:
  - `pos`: the phrase, said alone, before a command, after a lead-in, or
    fast;
  - `near`: a look-alike sentence;
  - `talk`: ordinary speech.
- `phrase`: the phrase a `pos` clip says, or a `near` clip imitates.

The noise is not stored. The bench generates it deterministically: mouse,
keyboard, fan, vacuum, traffic, siren, hammering, music, chatter, and all of
them at once.
