/** Exercises the generated local Worker with the same root secrets file as normal development. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("local crash configuration loads the root development secrets", { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "crash-local-fixture-"));
  let child;
  let exited;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGINT");
      const deadline = setTimeout(() => child.kill("SIGTERM"), 3000);
      deadline.unref();
      await exited;
      clearTimeout(deadline);
    }
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(resolve(root, "tools"));
  mkdirSync(resolve(root, "src"));
  for (const file of ["wrangler.jsonc", "crash-bindings.local.json", "package.json", "tools/crash-local.mjs"])
    copyFileSync(resolve(repository, file), resolve(root, file));
  symlinkSync(resolve(repository, "node_modules"), resolve(root, "node_modules"), "dir");
  writeFileSync(resolve(root, ".dev.vars"), 'CRASH_OWNER_SECRET="synthetic-fixture-only"\n');
  writeFileSync(resolve(root, "src/index.ts"), `
    import { DurableObject } from "cloudflare:workers";
    export class Hub extends DurableObject {}
    export default { fetch(_request, env) {
      return new Response(null, { status: env.CRASH_OWNER_SECRET ? 204 : 401 });
    } };
  `);
  const generated = spawnSync(process.execPath, [resolve(root, "tools/crash-local.mjs")], { cwd: root });
  assert.equal(generated.status, 0, "local configuration generation failed");
  const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts;
  const configuration = scripts["dev:crashes"].match(/--config\s+(\S+)/)[1];
  child = spawn(process.execPath, [resolve(repository, "node_modules/wrangler/bin/wrangler.js"),
    "dev", "--local", "--config", configuration, "--ip", "127.0.0.1", "--port", "0"], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
    });
  exited = once(child, "exit");
  child.stderr.resume();
  let url;
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    const ready = line.match(/Ready on (http:\/\/127\.0\.0\.1:\d+)/);
    if (ready) { url = ready[1]; break; }
  }
  assert.ok(url, "local Worker did not become ready");
  assert.equal((await fetch(url, { signal: AbortSignal.timeout(5000) })).status, 204);
});
