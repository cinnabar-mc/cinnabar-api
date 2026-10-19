import { generateKeyPair } from "jose";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Hub } from "../src/hub";
import { clientKey, connect, hello, hub, installFakeIssuer, issuer, login, mintToken, sign, type Client } from "./helpers";

const open: Client[] = [];
const track = (client: Client) => (open.push(client), client);

beforeAll(installFakeIssuer);
afterEach(() => Promise.all(open.splice(0).map((c) => (c.close(), c.closed))));

/** Sends hello with `token` and expects the unauthorized error followed by close 4401. */
async function expectRejectedToken(token: string) {
  const client = track(await connect());
  client.send(hello(token));
  expect(await client.next()).toEqual({ type: "error", code: "unauthorized" });
  expect((await client.closed).code).toBe(4401);
}

describe("handshake", () => {
  it("retains verified display names without retaining identity tokens", async () => {
    const key = await clientKey();
    const client = track(await connect());
    const token = await mintToken({ cpk: key.cpk, xname: "Alex" });
    client.send(hello(token));
    await client.next();
    await runInDurableObject(hub(), (_: Hub, state) => {
      const attachments = state.getWebSockets().map((ws) => ws.deserializeAttachment());
      expect(attachments).toContainEqual(expect.objectContaining({ displayName: "Alex", stage: "proof" }));
      expect(JSON.stringify(attachments)).not.toContain(token);
    });
  });

  it("welcomes a client that proves possession of the token's key", async () => {
    const key = await clientKey();
    const client = track(await connect());
    client.send(hello(await mintToken({ cpk: key.cpk, xid: "2535412345678901", xname: "Alex" })));
    const challenge = await client.next();
    expect(challenge.type).toBe("challenge");
    client.send({ type: "proof", signature: await sign(key, challenge.nonce as string) });
    expect(await client.next()).toEqual({
      type: "welcome", xuid: "2535412345678901", loadout_revision: 0, owned_cosmetics: [],
      lookup_batch_max: 128, lookup_bucket_capacity: 1024, lookup_refill_per_min: 512,
      cache_ttl_ms: 120_000, ping_interval_ms: 30_000, reconnect_max_ms: 300_000,
    });
  });

  it("answers ping with pong at any stage", async () => {
    const client = track(await connect());
    client.send("ping");
    expect(await client.next()).toEqual({ type: "pong" });
  });

  it("ignores unknown message types and unknown fields", async () => {
    const key = await clientKey();
    const client = track(await connect());
    client.send({ ...hello(await mintToken({ cpk: key.cpk })), extra: "ignored" });
    const challenge = await client.next();
    expect(challenge.type).toBe("challenge");
    client.send({ type: "proof", signature: await sign(key, challenge.nonce as string), extra: true });
    expect((await client.next()).type).toBe("welcome");
    client.send({ type: "future_thing", data: 1 });
    expect((await client.lookup([])).type).toBe("lookup_result");
  });

  it("issues a fresh nonce per connection", async () => {
    const key = await clientKey();
    const token = await mintToken({ cpk: key.cpk });
    const a = track(await connect());
    const b = track(await connect());
    a.send(hello(token));
    b.send(hello(token));
    expect((await a.next()).nonce).not.toBe((await b.next()).nonce);
  });
});

describe("bad tokens", () => {
  it("rejects unknown kids with 4401 without refetching within the refresh interval", async () => {
    const key = await clientKey();
    const client = track(await connect());
    client.send(hello(await mintToken({ cpk: key.cpk })));
    expect((await client.next()).type).toBe("challenge");
    const fetches = issuer.fetches.length;
    for (let i = 0; i < 3; i++) {
      await expectRejectedToken(await mintToken({ cpk: key.cpk, kid: crypto.randomUUID() }));
    }
    expect(issuer.fetches).toHaveLength(fetches);
  });

  it("rejects a token signed by another key", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    await expectRejectedToken(await mintToken({ cpk: (await clientKey()).cpk, key: privateKey }));
  });

  it("rejects a token for another audience", async () => {
    await expectRejectedToken(await mintToken({ cpk: (await clientKey()).cpk, aud: "api://somewhere-else" }));
  });

  it("accepts an audience list that contains the multiplayer audience", async () => {
    const key = await clientKey();
    const client = track(await connect());
    client.send(hello(await mintToken({ cpk: key.cpk, aud: ["other", "api://auth-minecraft-services/multiplayer"] })));
    expect((await client.next()).type).toBe("challenge");
  });

  it("rejects a token from another issuer", async () => {
    await expectRejectedToken(await mintToken({ cpk: (await clientKey()).cpk, iss: "https://evil.test/" }));
  });

  it("rejects a token expired beyond the 60 s leeway but accepts one within it", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expectRejectedToken(await mintToken({ cpk: (await clientKey()).cpk, exp: now - 61, nbf: now - 3600 }));
    const client = track(await connect());
    client.send(hello(await mintToken({ cpk: (await clientKey()).cpk, exp: now - 30, nbf: now - 3600 })));
    expect((await client.next()).type).toBe("challenge");
  });

  it("rejects a token not yet valid beyond the leeway", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expectRejectedToken(await mintToken({ cpk: (await clientKey()).cpk, nbf: now + 120 }));
  });

  it("rejects a token whose cpk isn't a P-384 key", async () => {
    await expectRejectedToken(await mintToken({ cpk: "bm90IGEga2V5" }));
  });

  it("rejects a token with a non-numeric xid", async () => {
    await expectRejectedToken(await mintToken({ cpk: (await clientKey()).cpk, xid: "steve" }));
  });

  it("rejects a structurally broken token", async () => {
    await expectRejectedToken("aaa.bbb.ccc");
  });
});

describe("bad proofs", () => {
  async function challenged(key = undefined as Awaited<ReturnType<typeof clientKey>> | undefined) {
    const owner = key ?? (await clientKey());
    const client = track(await connect());
    client.send(hello(await mintToken({ cpk: owner.cpk })));
    const challenge = await client.next();
    return { client, nonce: challenge.nonce as string };
  }

  async function expectRejectedProof(client: Client, signature: string) {
    client.send({ type: "proof", signature });
    expect(await client.next()).toEqual({ type: "error", code: "unauthorized" });
    expect((await client.closed).code).toBe(4401);
  }

  it("rejects a proof signed by a different key", async () => {
    const { client, nonce } = await challenged();
    await expectRejectedProof(client, await sign(await clientKey(), nonce));
  });

  it("rejects a proof over a different nonce", async () => {
    const key = await clientKey();
    const { client } = await challenged(key);
    await expectRejectedProof(client, await sign(key, "A".repeat(43)));
  });

  it("rejects a proof that isn't 96 bytes of base64url", async () => {
    const { client } = await challenged();
    client.send({ type: "proof", signature: "abc" });
    expect((await client.closed).code).toBe(1008);
  });

  it("rejects a proof sent before hello", async () => {
    const client = track(await connect());
    client.send({ type: "proof", signature: "A".repeat(128) });
    expect(await client.next()).toEqual({ type: "error", code: "unauthorized" });
    expect((await client.closed).code).toBe(4401);
  });

  it("rejects lookups before authentication", async () => {
    const client = track(await connect());
    client.send({ type: "lookup", id: 1, xuids: [] });
    expect(await client.next()).toEqual({ type: "error", code: "unauthorized" });
    expect((await client.closed).code).toBe(4401);
  });
});

describe("handshake timeout", () => {
  it("schedules an alarm and closes unauthenticated sockets with 4401 once 10 s pass", async () => {
    const before = Date.now();
    const client = track(await connect());
    const alarm = await runInDurableObject(hub(), (_: Hub, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm! - before).toBeLessThanOrEqual(10_000);

    const { client: authed } = await login();
    track(authed);
    await runInDurableObject(hub(), (instance: Hub) => {
      expect(instance.expireHandshakes(Date.now() + 9_000)).not.toBeNull();
      instance.expireHandshakes(Date.now() + 10_001);
    });
    expect((await client.closed).code).toBe(4401);
    expect((await authed.lookup([])).type).toBe("lookup_result");
  });
});

describe("handshake deadline", () => {
  it("closes with 4401 when a valid proof lands after the deadline but before the alarm", async () => {
    const key = await clientKey();
    const client = track(await connect());
    client.send(hello(await mintToken({ cpk: key.cpk })));
    const nonce = (await client.next()).nonce as string;
    await runInDurableObject(hub(), (_: Hub, state) => {
      for (const ws of state.getWebSockets()) {
        const attachment = ws.deserializeAttachment();
        if (attachment?.nonce === nonce) ws.serializeAttachment({ ...attachment, deadline: Date.now() - 1 });
      }
    });
    await evictDurableObject(hub());
    client.send({ type: "proof", signature: await sign(key, nonce) });
    const outcome = await Promise.race([client.next().then((m) => m.type), client.closed.then((c) => c.code)]);
    expect(outcome).toBe(4401);
  });
});

describe("framing", () => {
  it("closes with 1009 on a frame over 16 KiB", async () => {
    const client = track(await connect());
    client.send(JSON.stringify({ type: "padding", pad: "x".repeat(16 * 1024) }));
    expect((await client.closed).code).toBe(1009);
  });

  it("counts UTF-8 bytes, not UTF-16 units", async () => {
    const client = track(await connect());
    client.send(JSON.stringify({ type: "padding", pad: "é".repeat(8200) }));
    expect((await client.closed).code).toBe(1009);
  });

  it("accepts an unknown message just under the limit", async () => {
    const { client } = await login();
    track(client);
    const frame = JSON.stringify({ type: "padding", pad: "" });
    client.send(JSON.stringify({ type: "padding", pad: "x".repeat(16 * 1024 - frame.length) }));
    client.send("ping");
    expect(await client.next()).toEqual({ type: "pong" });
  });

  it("closes with 1007 on non-JSON or a message without a type", async () => {
    const a = track(await connect());
    a.send("{nope");
    expect((await a.closed).code).toBe(1007);
    const b = track(await connect());
    b.send({ kind: "hello" });
    expect((await b.closed).code).toBe(1007);
  });

  it("closes with 1008 on a known message that fails the schema", async () => {
    const client = track(await connect());
    client.send({ ...hello("a.b.c"), channel: "alpha" });
    expect((await client.closed).code).toBe(1008);
  });
});
