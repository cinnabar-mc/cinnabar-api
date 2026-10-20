import type { Hub } from "./hub";

/** Returns the shared presence and release hub. Sharding also needs global lookups and release fan-out. */
export function hubFor(env: Env): DurableObjectStub<Hub> {
  return env.HUB.get(env.HUB.idFromName("global"), { locationHint: "weur" });
}
