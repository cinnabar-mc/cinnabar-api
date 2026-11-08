/** Install the official scanner validator locally, verifying the pinned release archive before extraction. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const version = '1.245.1';
const releases = {
  x64: ['x86_64-linux', 'b171e20fd107e63e89ef6c936b5581597666a086af677d7818de92b7cdd5a86d'],
  arm64: ['aarch64-linux', 'e01ef74b8e7b4a819d91122fdd87084fb25a938e4bfa4179cc5524b961468c85'],
};
const release = process.platform === 'linux' && releases[process.arch];
if (!release) throw new Error('The scanner requires Linux x64 or arm64. Use scanner/Dockerfile on other platforms.');
const [target, checksum] = release;
const destination = new URL('../.generated/wasm-tools/', import.meta.url);
await mkdir(destination, { recursive: true });
const marker = new URL('archive.sha256', destination);
try {
  if ((await readFile(marker, 'utf8')).trim() === checksum
    && execFileSync(fileURLToPath(new URL('wasm-tools', destination)), ['--version'], { encoding: 'utf8' }).trim() === `wasm-tools ${version}`) {
    console.log(`wasm-tools ${version} already installed.`);
    process.exit(0);
  }
} catch { /* A missing or incomplete installation is replaced below. */ }
const temporary = await mkdtemp(new URL('../.generated/wasm-tools-download-', import.meta.url));
try {
  const name = `wasm-tools-${version}-${target}`;
  const response = await fetch(`https://github.com/bytecodealliance/wasm-tools/releases/download/v${version}/${name}.tar.gz`,
    { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`wasm-tools download: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== checksum) throw new Error('wasm-tools archive checksum mismatch.');
  const archive = `${temporary}/release.tar.gz`;
  await writeFile(archive, bytes);
  execFileSync('tar', ['-xzf', archive, '-C', temporary]);
  // Keep the release's license notices alongside the executable.
  for (const file of ['wasm-tools', 'LICENSE-APACHE', 'LICENSE-MIT', 'LICENSE-Apache-2.0_WITH_LLVM-exception']) {
    await rename(`${temporary}/${name}/${file}`, new URL(file, destination));
  }
  await writeFile(marker, `${checksum}\n`);
  console.log(`Installed wasm-tools ${version} (${target}, SHA-256 verified).`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
