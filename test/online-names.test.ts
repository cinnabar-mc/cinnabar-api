import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { Validator, type Schema } from "@cfworker/json-schema";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hub } from "../src/hub";
import worker from "../src/index";
import schemaJson from "../schema/v1.json";
import { SESSION_IDLE_TIMEOUT_MS } from "../src/protocol";
import { hub, installFakeIssuer, login, type Client } from "./helpers";

const clients: Client[] = [];
const schema = schemaJson as unknown as Schema & { $id: string };
const namesResponse = new Validator({ $ref: `${schema.$id}#/$defs/OnlineNamesResponse` }, "2020-12");
namesResponse.addSchema(schema);

/** Opens a verified session and retains its socket for deterministic cleanup. */
async function player(options: Parameters<typeof login>[0]) {
  const session = await login(options);
  clients.push(session.client);
  return session.client;
}

/** Queries the private directory with the specified authorization header. */
function directory(authorization = "Bearer test-presence-secret") {
  return exports.default.fetch("https://api.test/v1/presence/players", {
    headers: { Authorization: authorization },
  });
}

beforeAll(installFakeIssuer);
afterEach(() => Promise.all(clients.splice(0).map((client) => (client.close(), client.closed))));

describe("private online directory", () => {
  it("fails closed when the deployment secret is absent", async () => {
    const response = await worker.fetch(new Request("https://api.test/v1/presence/players", {
      headers: { Authorization: "Bearer test-presence-secret" },
    }), { ...env, PRESENCE_READ_SECRET: undefined });
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects missing, malformed, wrong and unrelated credentials without caching", async () => {
    for (const header of ["", "Basic test-presence-secret", "Bearer wrong", "Bearer test-hook-secret"]) {
      const response = await directory(header);
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });

  it("returns names only, once per visible online account, including after hibernation", async () => {
    await player({ xuid: "101", xname: "Alex" });
    await player({ xuid: "101", xname: "Alex" });
    await player({ xuid: "102", xname: "Steve" });
    await player({ xuid: "103", xname: "Hidden", visible: false });
    const disconnected = await player({ xuid: "104", xname: "Offline" });
    disconnected.close();
    await disconnected.closed;
    await evictDurableObject(hub());
    const response = await directory();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(namesResponse.validate(body).valid).toBe(true);
    expect(body).toEqual({ names: ["Alex", "Steve"] });
  }, 10_000);

  it("excludes idle sessions using the same deadline as the count", async () => {
    await player({ xuid: "201", xname: "Idle" });
    await runInDurableObject(hub(), (instance: Hub) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + SESSION_IDLE_TIMEOUT_MS + 1);
      try {
        expect(instance.onlineNames()).toEqual([]);
        expect(instance.onlineCount()).toBe(0);
      } finally { clock.mockRestore(); }
    });
  });

  it("reauthenticates older attachments that lack verified names", async () => {
    const client = await player({ xuid: "301", xname: "Legacy" });
    await runInDurableObject(hub(), (_instance: Hub, state) => {
      const socket = state.getWebSockets().find((ws) => ws.deserializeAttachment()?.xuid === "301")!;
      const attachment = socket.deserializeAttachment();
      delete attachment.displayName;
      socket.serializeAttachment(attachment);
      const restored = new Hub(state, env);
      expect(restored.onlineCount()).toBe(0);
      expect(restored.onlineNames()).toEqual([]);
    });
    expect((await client.closed).code).toBe(1012);
  });
});
