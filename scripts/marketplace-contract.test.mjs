import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveContract } from './marketplace-contract.mjs';

/** Synthetic public inputs exercise declaration extraction without downloading client code. */
function inputs(type = 'bool') {
  return {
    compatibilityRevisions: JSON.stringify(['1'.repeat(40), '2'.repeat(40)]),
    grants: `grants! {\n    #[permission("HUD", false)]\n    pub hud: bool,\n    #[permission("Packets", true, true)]\n    pub packets: ${type},\n}`,
    wit: 'package cinnabar:extension@0.1.0;\ninterface clock {\n}\nworld extension { import cinnabar:world-draw/drawing@0.2.0; }',
    drawing: 'package cinnabar:world-draw@0.2.0;\ninterface drawing {\n}',
    marketplaceKeys: JSON.stringify({ ed25519: [Buffer.alloc(32).toString('base64')] }),
    modHost: '/// Maximum bytes accepted before compilation.\npub const MAX_COMPONENT_BYTES: usize = 4 * 1024 * 1024;\n',
    modApi: 'pub const NOTICES_SECTION: &str = "cinnabar:extension/notices@1";\npub const ICON_SECTION: &str = "cinnabar:extension/icon@1";\n'
      + 'pub const COMPONENT_ASSET_SECTIONS: [&str; 2] = [\n    NOTICES_SECTION,\n    ICON_SECTION,\n];\n',
  };
}

test('derives optional packet-only markers and exact interface versions from pinned declarations', () => {
  const contract = deriveContract(inputs(), 'a'.repeat(40));
  assert.deepEqual(contract.capabilities.map(cap => [cap.name, cap.packet_only]), [['hud', false], ['packets', true]]);
  assert.ok(contract.interfaces.includes('cinnabar:extension/clock@0.1.0'));
  assert.ok(contract.interfaces.includes('cinnabar:world-draw/drawing@0.2.0'));
  assert.equal(contract.interfaces.includes('cinnabar:world-draw/drawing@0.1.0'), false);
  assert.equal(new Set(contract.interfaces).size, contract.interfaces.length);
  assert.deepEqual(deriveContract({ ...inputs(), serverExperience: 'package cinnabar:dependency@1.0.0;\ninterface private-host {}' },
    'a'.repeat(40)).interfaces, contract.interfaces);
});

test('refuses unsupported grant types and malformed trust roots instead of dropping declarations', () => {
  assert.throws(() => deriveContract(inputs('u64'), 'a'.repeat(40)), /grant type/);
  assert.throws(() => deriveContract({ ...inputs(), marketplaceKeys: '{"ed25519":[]}' }, 'a'.repeat(40)), /public keys/);
});

test('derives the executable component ceiling and the asset sections the client strips before applying it', () => {
  assert.deepEqual(deriveContract(inputs(), 'a'.repeat(40)).component,
    { executable_bytes: 4 * 1024 * 1024, asset_sections: ['cinnabar:extension/notices@1', 'cinnabar:extension/icon@1'] });
  const base = inputs();
  for (const changed of [
    { modHost: base.modHost.replace('4 * 1024 * 1024', 'limits::COMPONENT') },
    { modHost: '' },
    { modApi: base.modApi.replace('[&str; 2]', '[&str; 3]') },
    { modApi: base.modApi.replace('pub const ICON_SECTION', 'const ICON') },
  ]) assert.throws(() => deriveContract({ ...base, ...changed }, 'a'.repeat(40)), /Client component/);
});

test('derives the newest stable API revision from the ordered compatibility history', () => {
  assert.equal(deriveContract(inputs(), 'a'.repeat(40)).api_revision, '2'.repeat(40));
  assert.equal(deriveContract({ ...inputs(), compatibilityRevisions: JSON.stringify(['3'.repeat(40)]) }, 'a'.repeat(40)).api_revision, '3'.repeat(40));
});

test('refuses missing, empty or changed API compatibility history shapes', () => {
  for (const compatibilityRevisions of [undefined, '', '{}', 'null', '[]', '[42]',
    JSON.stringify(['a'.repeat(40), 'bad']), JSON.stringify(['A'.repeat(40)]), JSON.stringify(['a'.repeat(39)])]) {
    assert.throws(() => deriveContract({ ...inputs(), compatibilityRevisions }, 'a'.repeat(40)), /compatibility revisions/i);
  }
});
