import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveContract } from './marketplace-contract.mjs';

/** Synthetic public inputs exercise declaration extraction without downloading client code. */
function inputs(type = 'bool') {
  return {
    grants: `grants! {\n    #[permission("HUD", false)]\n    pub hud: bool,\n    #[permission("Packets", true, true)]\n    pub packets: ${type},\n}`,
    wit: 'package cinnabar:extension@0.1.0;\ninterface clock {\n}\nworld extension { import cinnabar:world-draw/drawing@0.2.0; }',
    drawing: 'package cinnabar:world-draw@0.2.0;\ninterface drawing {\n}',
    marketplaceKeys: JSON.stringify({ ed25519: [Buffer.alloc(32).toString('base64')] }),
  };
}

test('derives optional packet-only markers and exact interface versions from pinned declarations', () => {
  const contract = deriveContract(inputs(), 'a'.repeat(40));
  assert.deepEqual(contract.capabilities.map(cap => [cap.name, cap.packet_only]), [['hud', false], ['packets', true]]);
  assert.ok(contract.interfaces.includes('cinnabar:extension/clock@0.1.0'));
  assert.ok(contract.interfaces.includes('cinnabar:world-draw/drawing@0.2.0'));
  assert.equal(contract.interfaces.includes('cinnabar:world-draw/drawing@0.1.0'), false);
  assert.equal(new Set(contract.interfaces).size, contract.interfaces.length);
});

test('refuses unsupported grant types and malformed trust roots instead of dropping declarations', () => {
  assert.throws(() => deriveContract(inputs('u64'), 'a'.repeat(40)), /grant type/);
  assert.throws(() => deriveContract({ ...inputs(), marketplaceKeys: '{"ed25519":[]}' }, 'a'.repeat(40)), /public keys/);
});
