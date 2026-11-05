/** Provision the signer through GitHub's encrypted environment secret; publish only its public half. */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

/** Derive the raw Ed25519 public key from the Worker's base64 PKCS#8 secret. */
export function publicKey(secret) {
  const key = createPrivateKey({ key: Buffer.from(secret.trim(), 'base64'), type: 'pkcs8', format: 'der' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The marketplace signer must use Ed25519.');
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

/** Refuse deployment when the signer cannot be verified by the pinned client contract. */
export function checkSigner(secret, keys) {
  if (!secret) throw new Error('MARKETPLACE_SIGNING_KEY is required.');
  let derived;
  try { derived = publicKey(secret); }
  catch { throw new Error('MARKETPLACE_SIGNING_KEY must be a base64 PKCS#8 Ed25519 key.'); }
  if (!Array.isArray(keys) || !keys.includes(derived)) throw new Error('The signer is not pinned by the client. Ship its public key and refresh source.json first.');
  return derived;
}

/** Store a fresh private key without arguments/files/logs, then atomically append its public trust root. */
export function provision(client, run = spawnSync) {
  const path = resolve(client, 'crates/launcher-host/data/marketplace-keys.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(config.ed25519) || config.ed25519.length >= 8) throw new Error('Invalid or full client signing-key set.');
  const args = ['--repo', 'cinnabar-mc/cinnabar-api', '--env', 'production'];
  const listed = run('gh', ['secret', 'list', ...args, '--json', 'name'], { encoding: 'utf8', shell: false });
  if (listed.status !== 0) throw new Error('Could not inspect the production environment secrets.');
  if (JSON.parse(listed.stdout).some(value => value.name === 'MARKETPLACE_SIGNING_KEY')) {
    throw new Error('A signer already exists. Derive its public key from your secure copy; do not rotate it implicitly.');
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  const secret = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const raw = publicKey(secret);
  config.ed25519.push(raw);
  const temporary = path + '.tmp';
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  const stored = run('gh', ['secret', 'set', 'MARKETPLACE_SIGNING_KEY', ...args], {
    input: secret, encoding: 'utf8', shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (stored.status !== 0) {
    rmSync(temporary);
    throw new Error('Could not save the signer; the client key set is unchanged.');
  }
  try { renameSync(temporary, path); }
  catch { throw new Error(`Signer saved; recover its public pin from ${temporary}. Public key: ${raw}`); }
  return raw;
}

/** Run explicit setup or deployment verification without ever printing secret material. */
function main(args) {
  if (args.length === 2 && args[0] === 'provision') {
    console.log('Pinned public key:', provision(args[1]));
  } else if (args.length === 1 && args[0] === 'check') {
    const contract = JSON.parse(readFileSync(new URL('../.generated/contract.json', import.meta.url)));
    checkSigner(process.env.MARKETPLACE_SIGNING_KEY, contract.signingKeys);
    console.log('Marketplace signer matches the pinned client key set.');
  } else {
    throw new Error('Usage: node scripts/marketplace-signing.mjs provision CLIENT_CHECKOUT | check');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
