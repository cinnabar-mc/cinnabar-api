import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, rmdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkSigner, publicKey, provision } from './marketplace-signing.mjs';

test('PKCS#8 signer matches raw client trust and rejects missing, wrong and unpinned keys', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const secret = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const raw = publicKey(secret);
  assert.equal(Buffer.from(raw, 'base64').length, 32);
  assert.equal(checkSigner(secret, [raw]), raw);
  assert.throws(() => checkSigner('', [raw]), /required/);
  assert.throws(() => checkSigner('bad', [raw]), /PKCS#8/);
  assert.throws(() => checkSigner(secret, []), /not pinned/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.throws(() => checkSigner(rsa.export({ format: 'der', type: 'pkcs8' }).toString('base64'), [raw]), /Ed25519/);
});

test('provision keeps the secret on stdin and refuses implicit rotation or partial trust changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'marketplace-keys-'));
  const dir = join(root, 'crates/launcher-host/data');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'marketplace-keys.json');
  writeFileSync(file, '{"ed25519":[]}');
  try {
    let secret;
    const raw = provision(root, (_command, args, options) => {
      if (args[1] === 'list') return { status: 0, stdout: '[]' };
      secret = options.input;
      assert(!args.some(value => value.includes(secret)));
      return { status: 0 };
    });
    assert.deepEqual(JSON.parse(readFileSync(file)).ed25519, [raw]);
    const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw, 'base64').toString('base64url') };
    assert(verify(null, Buffer.from('fixture'), createPublicKey({ key: publicJwk, format: 'jwk' }), sign(null, Buffer.from('fixture'), { key: Buffer.from(secret, 'base64'), type: 'pkcs8', format: 'der' })));
    assert.throws(() => provision(root, () => ({ status: 0, stdout: '[{"name":"MARKETPLACE_SIGNING_KEY"}]' })), /already exists/);
    assert.throws(() => provision(root, (_command, args) => args[1] === 'list' ? { status: 0, stdout: '[]' } : { status: 1 }), /unchanged/);
    assert.deepEqual(JSON.parse(readFileSync(file)).ed25519, [raw]);
    writeFileSync(file + '.tmp', 'occupied');
    let writes = 0;
    assert.throws(() => provision(root, (_command, args) => {
      if (args[1] !== 'list') writes++;
      return { status: 0, stdout: '[]' };
    }), /EEXIST/);
    assert.equal(writes, 0, 'a public-file preparation failure must not create an orphaned signer');
    rmSync(file + '.tmp');
    assert.throws(() => provision(root, (_command, args, options) => {
      if (args[1] === 'list') return { status: 0, stdout: '[]' };
      secret = options.input;
      renameSync(file, file + '.original');
      mkdirSync(file);
      return { status: 0 };
    }), /recover its public pin/);
    assert(JSON.parse(readFileSync(file + '.tmp')).ed25519.includes(publicKey(secret)));
    rmSync(file + '.tmp');
    rmdirSync(file);
    renameSync(file + '.original', file);
  } finally {
    rmSync(file, { force: true });
    rmdirSync(dir);
    rmdirSync(join(root, 'crates/launcher-host'));
    rmdirSync(join(root, 'crates'));
    rmdirSync(root);
  }
});
