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
    const pkg = text.match(/^package\s+([^;]+);/m)?.[1];
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
  return { revision, capabilities, interfaces, signingKeys, component: componentLimits(inputs) };
}

/**
 * The client's executable component ceiling (mod-host `MAX_COMPONENT_BYTES`) and the presentation asset sections
 * (mod-api `COMPONENT_ASSET_SECTIONS`) it strips before applying that ceiling. Throws when either declaration changes
 * shape, so a new client limit is reviewed instead of silently ignored.
 */
export function componentLimits(inputs) {
  const expression = inputs.modHost.match(/^pub const MAX_COMPONENT_BYTES: usize = ([^;]+);/m)?.[1];
  const factors = expression?.split('*').map(factor => factor.trim().replaceAll('_', '')) ?? [];
  if (!factors.length || factors.some(factor => !/^\d+$/.test(factor))) throw new Error('Client component size limit changed.');
  const executableBytes = factors.reduce((product, factor) => product * Number(factor), 1);
  const list = inputs.modApi.match(/^pub const COMPONENT_ASSET_SECTIONS: \[&str; (\d+)\] = \[([^\]]*)\];/m);
  const names = list?.[2].split(',').map(name => name.trim()).filter(Boolean) ?? [];
  const sections = names.map(name => /^[A-Z][A-Z0-9_]*$/.test(name) && inputs.modApi.match(new RegExp(`^pub const ${name}: &str = "([^"\\\\]+)";`, 'm'))?.[1]);
  if (!list || names.length !== Number(list[1]) || sections.some(section => !section)) throw new Error('Client component asset sections changed.');
  return { executable_bytes: executableBytes, asset_sections: sections };
}
