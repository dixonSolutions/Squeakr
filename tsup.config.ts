import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries: the bridge, and the management CLI that looks after it.
  // bin/squeakr.mjs is a shim over dist/cli.js — see docs/35-cli.md.
  entry: { index: 'src/index.ts', cli: 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  // No shared chunks. `squeakr run` loads dist/cli.js and then dist/index.js
  // in the same process; if they shared a chunk they would share module state,
  // and the CLI's silenced pino logger would silence the bridge's own logs too.
  splitting: false,
  // Keep native / CJS-only modules external — resolved at runtime from node_modules
  // Channel libraries are optionalDependencies, imported on first use only
  // (docs/44): a failed install must leave the bridge running, not unbuildable.
  external: ['better-sqlite3', 'http-proxy', 'discord.js', '@discordjs/voice', 'opusscript', '@snazzah/davey', 'vosk-koffi', 'koffi', 'audio-decode'],
  // Inline everything else so the bridge is a single file
  noExternal: [],
});
