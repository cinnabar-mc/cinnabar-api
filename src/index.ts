import { catalogResponse, assetResponse } from "./cosmetics";
import { authorizePublisher, entitlementCommand } from "./cosmetics-admin";
import { Hono } from "hono";
import { isReleaseHookRequest } from "./protocol";
import { cachedOnlineCount, cachedOnlineHistory, hubFor } from "./routing";
import { HISTORY_RANGES, type HistoryRange } from "./presence-history";

export { Hub } from "./hub";

const MAX_HOOK_BODY_BYTES = 1024;

const app = new Hono<{ Bindings: Env }>();

app.get("/v1/health", (c) => c.json({ ok: true, api: "v1" }));

app.get("/v1/presence/count", async (c) => {
  const online = await cachedOnlineCount(c.env);
  return c.json({ online }, 200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=30",
  });
});

app.get("/v1/presence/players", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!(await bearerMatches(c.req.header("Authorization"), c.env.PRESENCE_READ_SECRET))) return c.body(null, 401);
  return c.json({ names: await hubFor(c.env).onlineNames() });
});

app.get("/v1/cosmetics/catalog", (c) => catalogResponse(c.req.raw, c.env.COSMETIC_ASSETS));

app.get("/v1/presence/history", async (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  const range = c.req.query("range") ?? "24h";
  if (!Object.hasOwn(HISTORY_RANGES, range)) return c.json({ error: "unsupported range" }, 400);
  return c.json(await cachedOnlineHistory(c.env, range as HistoryRange), 200, {
    "Cache-Control": "public, max-age=60",
  });
});
app.get("/v1/cosmetics/assets/:hash", (c) => assetResponse(c.req.param("hash"), c.env.COSMETIC_ASSETS));

app.post("/v1/cosmetics/entitlements", async (c) => {
  if (!(await authorizePublisher(c.req.header("Authorization"), c.env))) return c.body(null, 401);
  const text = await readBounded(c.req.raw.body, 40_000);
  if (text === null) return c.body(null, 400);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return c.body(null, 400); }
  const command = entitlementCommand(value);
  if (!command) return c.body(null, 400);
  const result = await hubFor(c.env).setCosmeticEntitlements(command.xuid, command.item_ids, command.owned);
  return result === null ? c.body(null, 400) : c.json({ owned_cosmetics: result });
});

app.post("/v1/releases", async (c) => {
  if (!(await bearerMatches(c.req.header("Authorization"), c.env.RELEASE_HOOK_SECRET))) return c.body(null, 401);
  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (!(declared <= MAX_HOOK_BODY_BYTES)) return c.body(null, 400);
  const text = await readBounded(c.req.raw.body, MAX_HOOK_BODY_BYTES);
  if (text === null) return c.body(null, 400);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.body(null, 400);
  }
  if (!isReleaseHookRequest(body)) return c.body(null, 400);
  await hubFor(c.env).recordRelease(body.channel, body.version, body.build);
  return c.body(null, 204);
});

app.get("/v1/connect", (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.body(null, 426, { Upgrade: "websocket" });
  return hubFor(c.env).fetch(c.req.raw);
});

/** Reads the body as UTF-8, or returns null (cancelling the stream) once it passes `max` bytes. */
async function readBounded(stream: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Compares the bearer token with the secret in constant time via fixed-length digests; false when the secret is unset. */
async function bearerMatches(header: string | undefined, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export default {
  fetch: app.fetch,
  /** Samples at execution time, so delayed cron delivery cannot fabricate past counts. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await hubFor(env).recordOnlineCount();
  },
} satisfies ExportedHandler<Env>;
