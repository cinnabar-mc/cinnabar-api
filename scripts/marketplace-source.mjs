/** Fetch pinned public client inputs and derive the marketplace's permission/import contract. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const source = JSON.parse(await readFile(new URL('../source.json', import.meta.url)));
if (!/^[0-9a-f]{40}$/.test(source.revision)) throw new Error('Pin an immutable client revision.');
const inputs = {};
for (const [name, path] of Object.entries(source.inputs)) {
  const response = await fetch(`https://raw.githubusercontent.com/${source.repository}/${source.revision}/${path}`,
    { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Client input ${name}: ${response.status}`);
  inputs[name] = await response.text();
}
const block = inputs.grants.split('grants! {')[1]?.split('\n}')[0];
if (!block) throw new Error('Client grants declaration changed.');
const capabilities = [...block.matchAll(/#\[permission\("([^"]+)", (true|false)\)\]\s+pub (\w+): (bool|Vec<String>),/g)]
  .map(([, label, sensitive, name, type]) => ({ name, label, sensitive: sensitive === 'true', type }));
if (!capabilities.length || capabilities.length !== [...block.matchAll(/pub \w+:/g)].length) {
  throw new Error('Unsupported client grant type; review the contract before accepting uploads.');
}
const interfaces = Object.values(inputs).flatMap(text => {
  const pkg = text.match(/package\s+([^;]+);/)?.[1];
  if (!pkg) return [];
  const [base, version] = pkg.split('@');
  return [...text.matchAll(/^interface\s+([\w-]+)\s*\{/gm)].map(([, name]) => `${base}/${name}${version ? '@' + version : ''}`)
    .concat([...text.matchAll(/\bimport\s+([\w:-]+\/[\w-]+@[\d.]+);/g)].map(([, name]) => name));
});
await mkdir(new URL('../.generated/', import.meta.url), { recursive: true });
await writeFile(new URL('../.generated/contract.json', import.meta.url), JSON.stringify({
  revision: source.revision, capabilities, interfaces,
}, null, 2) + '\n');
console.log(`Derived ${capabilities.length} capabilities and ${interfaces.length} interfaces from pinned client inputs.`);
