/** Derive capabilities, versioned host imports and public trust roots from immutable client files. */
export function deriveContract(inputs, revision) {
  const block = inputs.grants.split('grants! {')[1]?.split('\n}')[0];
  if (!block) throw new Error('Client grants declaration changed.');
  const capabilities = [...block.matchAll(/#\[permission\("([^"]+)", (true|false)(?:, (true|false))?\)\]\s+pub (\w+): (bool|Vec<String>),/g)]
    .map(([, label, sensitive, packetOnly, name, type]) => ({ name, label, sensitive: sensitive === 'true', packet_only: packetOnly === 'true', type }));
  if (!capabilities.length || capabilities.length !== [...block.matchAll(/pub \w+:/g)].length) {
    throw new Error('Unsupported client grant type; review the contract before accepting uploads.');
  }
  const interfaces = [...new Set(Object.values(inputs).flatMap(text => {
    const pkg = text.match(/package\s+([^;]+);/)?.[1];
    if (!pkg) return [];
    const [base, version] = pkg.split('@');
    return [...text.matchAll(/^interface\s+([\w-]+)\s*\{/gm)].map(([, name]) => `${base}/${name}${version ? '@' + version : ''}`)
      .concat([...text.matchAll(/\bimport\s+([\w:-]+\/[\w-]+@[\d.]+);/g)].map(([, name]) => name));
  }))];
  const signingKeys = JSON.parse(inputs.marketplaceKeys).ed25519;
  if (!Array.isArray(signingKeys) || signingKeys.length === 0 || signingKeys.some(key =>
    typeof key !== 'string' || Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key)) {
    throw new Error('Pin the client Ed25519 public keys before provisioning the marketplace signer.');
  }
  return { revision, capabilities, interfaces, signingKeys };
}
