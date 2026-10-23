import type { MiddlewareHandler } from "hono";
import { count } from "./metrics";

/** Caches explicitly anonymous routes under canonical URLs, independent of credentials and irrelevant queries. */
export function publicCache(cacheControl: string, query: Readonly<Record<string, string>> = {}): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const key = new URL(c.req.url);
    key.search = "";
    for (const [name, fallback] of Object.entries(query)) key.searchParams.set(name, c.req.query(name) ?? fallback);
    let edge: Cache | undefined;
    try {
      edge = await caches.open("cinnabar-api-v1");
      const response = await edge.match(key.href);
      if (response) { c.res = response; return; }
    } catch { count(c.env.METRICS, "cache_failed"); }
    await next();
    const existing = c.res.headers.get("Cache-Control");
    if (c.res.headers.has("Set-Cookie") || /(?:^|,)\s*(?:private|no-store|no-cache)\b/i.test(existing ?? "")) return;
    if (c.res.status === 200) c.header("Cache-Control", cacheControl);
    else if (c.res.status !== 404 || !existing) return;
    if (edge) c.executionCtx.waitUntil(edge.put(key.href, c.res.clone()).catch(() => count(c.env.METRICS, "cache_failed")));
  };
}
