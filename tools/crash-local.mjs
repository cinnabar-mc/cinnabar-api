/** Builds an ignored local Wrangler configuration without adding unprovisioned production bindings. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const parsed = ts.readConfigFile(resolve(root, "wrangler.jsonc"), ts.sys.readFile);
if (parsed.error) throw new Error("Cannot read the production Wrangler configuration");
const base = parsed.config;
const local = JSON.parse(readFileSync(resolve(root, "crash-bindings.local.json"), "utf8"));
const config = {
  ...base,
  main: resolve(root, base.main),
  triggers: { crons: [...base.triggers.crons, ...local.triggers.crons] },
  r2_buckets: [...base.r2_buckets, ...local.r2_buckets],
  d1_databases: local.d1_databases.map((entry) => ({ ...entry, migrations_dir: resolve(root, entry.migrations_dir) })),
  ratelimits: local.ratelimits,
};
writeFileSync(resolve(root, ".wrangler.crash-local.json"), JSON.stringify(config, null, 2) + "\n");
