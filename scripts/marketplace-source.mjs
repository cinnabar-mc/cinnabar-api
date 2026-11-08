/** Fetch pinned public client inputs and derive the marketplace's permission/import contract. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { deriveContract } from './marketplace-contract.mjs';
const source = JSON.parse(await readFile(new URL('../source.json', import.meta.url)));
if (!/^[0-9a-f]{40}$/.test(source.revision)) throw new Error('Pin an immutable client revision.');
const inputs = {};
for (const [name, path] of Object.entries(source.inputs)) {
  const response = await fetch(`https://raw.githubusercontent.com/${source.repository}/${source.revision}/${path}`,
    { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Client input ${name}: ${response.status}`);
  inputs[name] = await response.text();
}
const contract = deriveContract(inputs, source.revision);
await mkdir(new URL('../.generated/', import.meta.url), { recursive: true });
// Preserve the complete pinned definitions for wasm-tools world compatibility checks.
for (const [name, path] of Object.entries({ wit: 'extension.wit', drawing: 'deps/world-draw/drawing.wit',
  session: 'deps/session/session.wit', serverExperience: 'deps/server-experience/capabilities.wit' })) {
  const destination = new URL(`../.generated/wit/${path}`, import.meta.url);
  await mkdir(new URL('.', destination), { recursive: true });
  await writeFile(destination, inputs[name]);
}
await writeFile(new URL('../.generated/contract.json', import.meta.url), JSON.stringify(contract, null, 2) + '\n');
console.log(`Derived ${contract.capabilities.length} capabilities and ${contract.interfaces.length} interfaces from pinned client inputs.`);
