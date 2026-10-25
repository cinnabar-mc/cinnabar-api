/** Bundle shared policy into the separate Node scanner; native libraries and trusted Wasm remain dependencies. */
import { build } from 'esbuild';
await build({ entryPoints: { 'scanner-engine': 'scanner/engine.ts', 'scanner-worker': 'scanner/worker.ts', 'scanner-policy': 'src/marketplace/scanning.ts' },
  outdir: '.build', outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external' });
