import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  // One file: hooks embed this file's path (import.meta.url), so code must not move into chunks.
  splitting: false,
  // Bundle dependencies so hooks start fast and `npx` in CI installs nothing extra at runtime.
  noExternal: [/.*/],
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});
