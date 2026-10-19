/// <reference types="vite/client" />
import { Validator, type Schema } from "@cfworker/json-schema";
import schema from "../schema/v1.json";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Hub } from "../src/hub";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { hub, installFakeIssuer, login, type Client } from "./helpers";
import { identityUuid } from "../src/identity";
import { admitLoadout, catalog } from "../src/cosmetics";

const open: Client[] = [];
const A = "2535400000000411", B = "2535400000000412";
const item = catalog.items[0]!;
beforeAll(installFakeIssuer);
afterEach(() => Promise.all(open.splice(0).map((client) => (client.close(), client.closed))));

/** Authenticates a fixture account and owns its cleanup. */
async function player(xuid: string) {
  const { client } = await login({ xuid });
  open.push(client);
  return client;
}
/** Orders previous frames and checks that no unrelated frame was queued. */
async function flush(client: Client) {
  expect(await client.lookup([], 777)).toMatchObject({ type: "lookup_result", id: 777 });
}
/** Replaces only nearby subscriptions, independently of the persistent selection. */
function watch(client: Client, xuids: string[]) {
  client.send({ type: "emote_state", emote_id: null, elapsed_ms: 0, xuids });
}
/** Publishes a full replacement with an account-ordered revision. */
function equip(client: Client, revision: number, slots: Record<string, string | null> = { [item.slot]: item.id }) {
  client.send({ type: "loadout", revision, slots });
}

it.each(catalog.items.filter((item) => item.free))("publishes free catalog item $display_name only to mutual nearby watchers and ignores legacy hats", async (item) => {
  const a = await player(A), b = await player(B), other = await player("2535400000000413");
  watch(a, [B]); equip(a, 1, { [item.slot]: item.id }); await flush(a); await flush(b);
  watch(b, [A]);
  expect(await b.next()).toMatchObject({ type: "loadout", xuid: A, uuid: await identityUuid(A), revision: 1, slots: { [item.slot]: item.id } });
  a.send({ type: "emote_state", emote_id: null, elapsed_ms: 0, hat_id: "crown" });
  await flush(a); await flush(b); await flush(other);
  equip(a, 2, { head: null });
  expect(await b.next()).toMatchObject({ revision: 2, slots: { head: null } });
});

it("keeps the newest revision across sockets, including equal revisions and disconnects", async () => {
  const a = await player(A), a2 = await player(A), b = await player(B);
  watch(a, [B]); watch(a2, [B]); watch(b, [A]); await flush(a); await flush(a2); await flush(b);
  equip(a, 8); await b.next();
  equip(a2, 7, {}); equip(a2, 8, {}); await flush(a2); await flush(b);
  a.close(); await a.closed;
  expect(await b.next()).toMatchObject({ revision: 8, slots: { head: item.id } });
  equip(a2, 9, {});
  expect(await b.next()).toMatchObject({ revision: 9, slots: {} });
});

it.each(["visibility", "close", "departure"] as const)("withdraws on %s", async (reason) => {
  const a = await player(A), b = await player(B);
  watch(a, [B]); watch(b, [A]); await flush(a); await flush(b);
  equip(a, 1); await b.next();
  if (reason === "close") { a.close(); await a.closed; }
  else if (reason === "visibility") a.send({ type: "visibility", visible: false });
  else watch(a, []);
  expect(await b.next()).toMatchObject({ type: "loadout", slots: {} });
  await flush(b);
});

it("restores session loadouts through hibernation without an emote lease", async () => {
  const a = await player(A), b = await player(B);
  watch(a, [B]); equip(a, 3); await flush(a);
  await runInDurableObject(hub(), async (_, state) => {
    const rebuilt = new Hub(state, env);
    const receiver = state.getWebSockets().find((ws) => ws.deserializeAttachment()?.xuid === B)!;
    await rebuilt.webSocketMessage(receiver, JSON.stringify({ type: "emote_state", emote_id: null, elapsed_ms: 0, xuids: [A] }));
  });
  expect(await b.next()).toMatchObject({ type: "loadout", revision: 3, slots: { head: item.id } });
});

it.each([
  { departure: "absent", remaining: false },
  { departure: "closing", remaining: false },
  { departure: "absent", remaining: true },
  { departure: "closing", remaining: true },
])("updates nearby loadouts after a publisher disconnects during hibernation ($departure, remaining socket: $remaining)", async ({ departure, remaining }) => {
  const a = await player(A), b = await player(B);
  const a2 = remaining ? await player(A) : undefined;
  watch(a, [B]); watch(b, [A]);
  if (a2) { watch(a2, [B]); await flush(a2); }
  await flush(a); await flush(b);
  equip(a, 4); await b.next();
  await runInDurableObject(hub(), async (_, state) => {
    const sockets = state.getWebSockets();
    const publisher = sockets.find((ws) => ws.deserializeAttachment()?.xuid === A)!;
    const receiver = sockets.find((ws) => ws.deserializeAttachment()?.xuid === B)!;
    const listed = vi.spyOn(state, "getWebSockets").mockReturnValue(
      departure === "absent" ? sockets.filter((ws) => ws !== publisher) : sockets,
    );
    const readyState = vi.spyOn(publisher, "readyState", "get").mockReturnValue(
      departure === "absent" ? WebSocket.CLOSED : WebSocket.CLOSING,
    );
    const sent = vi.spyOn(receiver, "send");
    try {
      const rebuilt = new Hub(state, env);
      const closing = rebuilt.webSocketClose(publisher, 1000, "");
      expect(sent.mock.calls.map(([frame]) => JSON.parse(frame as string))).toEqual([
        { type: "loadout", xuid: A, uuid: await identityUuid(A), revision: 4, slots: remaining ? { head: item.id } : {} },
      ]);
      await closing;
      sent.mockClear();
      await rebuilt.webSocketClose(publisher, 1000, "");
      expect(sent).not.toHaveBeenCalled();
    } finally {
      listed.mockRestore();
      readyState.mockRestore();
      sent.mockRestore();
    }
  });
});

it("ignores unknown slots and items, and rejects wrong-slot replacements atomically", async () => {
  const a = await player(A), b = await player(B);
  watch(a, [B]); watch(b, [A]); await flush(a); await flush(b);
  equip(a, 1, { head: item.id, "future:slot": item.id, back: "future:unknown" });
  expect(await b.next()).toMatchObject({ slots: { head: item.id } });
  equip(a, 2, { back: item.id });
  expect(await a.next()).toMatchObject({ type: "error", code: "invalid_loadout" });
  await flush(b);
});

it("checks grants for non-free items and treats free items as owned by everyone", () => {
  expect(admitLoadout({ head: item.id }, () => false)).toEqual({ head: item.id });
  const paid = { ...item, free: false };
  expect(admitLoadout({ head: item.id }, () => false, [paid])).toBeNull();
  expect(admitLoadout({ head: item.id }, (id) => id === item.id, [paid])).toEqual({ head: item.id });
});

it("serves a schema-valid versioned catalog, conditional ETags and only reviewed R2 hashes", async () => {
  const response = await exports.default.fetch("https://api.test/v1/cosmetics/catalog");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(catalog);
  const conditional = await exports.default.fetch("https://api.test/v1/cosmetics/catalog", { headers: { "If-None-Match": response.headers.get("ETag")! } });
  expect(conditional.status).toBe(304);
  expect(await conditional.text()).toBe("");
  expect(response.headers.get("Cache-Control")).toContain("max-age");
  const asset = item.assets.texture;
  const missing = await exports.default.fetch(`https://api.test${asset.url}`);
  expect(missing.status).toBe(404);
  await env.COSMETIC_ASSETS.put(asset.sha256, new Uint8Array(asset.bytes));
  const served = await exports.default.fetch(`https://api.test${asset.url}`);
  expect(served.status).toBe(200);
  expect(served.headers.get("Cache-Control")).toContain("immutable");
  expect(served.headers.get("Link")).toBe(`<${item.license}>; rel="license"`);
  // Repeated requests are answered without another R2 read.
  await env.COSMETIC_ASSETS.delete(asset.sha256);
  expect((await exports.default.fetch(`https://api.test${asset.url}`)).status).toBe(200);
  expect((await exports.default.fetch("https://api.test/v1/cosmetics/assets/unknown")).status).toBe(404);
});


it("keeps the free metadata fallback schema-valid without private authoring files", () => {
  const validator = new Validator({ $ref: `${schema.$id}#/$defs/CosmeticsCatalog` }, "2020-12");
  validator.addSchema(schema as unknown as Schema);
  expect(validator.validate(catalog).valid).toBe(true);
  expect(catalog.items.every((item) => item.free)).toBe(true);
});


it("preserves the account loadout on a new socket and restores visibility without reviving an older selection", async () => {
  const a = await player(A), b = await player(B);
  watch(a, [B]); watch(b, [A]); await flush(a); await flush(b);
  equip(a, 12); await b.next();
  const joined = await login({ xuid: A }); open.push(joined.client);
  expect(joined.welcome.loadout_revision).toBe(12);
  a.send({ type: "visibility", visible: false });
  expect(await b.next()).toMatchObject({ revision: 12, slots: {} });
  a.send({ type: "visibility", visible: true });
  expect(await b.next()).toMatchObject({ revision: 12, slots: { head: item.id } });
  await flush(b);
});


it("shares a hat and animated wings together and preserves wings when changing hats", async () => {
  const wings = catalog.items.find((item) => item.id === "cinnabar:dragon_wings")!;
  const crown = catalog.items.find((item) => item.id === "cinnabar:crown")!;
  expect(wings.slot).toBe("back");
  const a = await player(A), b = await player(B);
  watch(a, [B]); watch(b, [A]); await flush(a); await flush(b);
  equip(a, 1, { head: item.id, back: wings.id });
  expect(await b.next()).toMatchObject({ revision: 1, slots: { head: item.id, back: wings.id } });
  equip(a, 2, { head: crown.id, back: wings.id });
  expect(await b.next()).toMatchObject({ revision: 2, slots: { head: crown.id, back: wings.id } });
  equip(a, 3, { head: null, back: wings.id });
  expect(await b.next()).toMatchObject({ revision: 3, slots: { head: null, back: wings.id } });
});


it("shares the pet, head and back slots together and removes a pet independently", async () => {
  const pet = catalog.items.find((item) => item.id === "cinnabar:shoulder_parrot")!;
  const wings = catalog.items.find((item) => item.id === "cinnabar:dragon_wings")!;
  expect(pet.slot).toBe("pet");
  const a = await player(A), b = await player(B);
  watch(a, [B]); watch(b, [A]); await flush(a); await flush(b);
  equip(a, 1, { head: item.id, back: wings.id, pet: pet.id });
  expect(await b.next()).toMatchObject({ revision: 1, slots: { head: item.id, back: wings.id, pet: pet.id } });
  equip(a, 2, { head: item.id, back: wings.id, pet: null });
  expect(await b.next()).toMatchObject({ revision: 2, slots: { head: item.id, back: wings.id, pet: null } });
});
