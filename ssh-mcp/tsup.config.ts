import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  // Single self-contained file: the dynamic imports in src/index.ts are inlined
  // so that `npx @get-bot/ssh-mcp` only ever needs dist/index.js.
  splitting: false,
  clean: true,
  dts: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
  external: ['ssh2', '@modelcontextprotocol/sdk', 'zod', '@inquirer/select', '@inquirer/input'],
});
