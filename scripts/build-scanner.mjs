/** Bundle shared policy into the separate Node scanner; native libraries and trusted Wasm remain dependencies. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Fail at build time for absent tooling or invalid trusted WIT, rather than blaming an upload.
execFileSync(fileURLToPath(new URL('../.generated/wasm-tools/wasm-tools', import.meta.url)),
  ['component', 'wit', fileURLToPath(new URL('../.generated/wit/', import.meta.url))], { stdio: ['ignore', 'ignore', 'inherit'] });
await build({ entryPoints: { 'scanner-engine': 'scanner/engine.ts', 'scanner-worker': 'scanner/worker.ts', 'scanner-policy': 'src/marketplace/scanning.ts' },
  outdir: '.build', outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external' });
