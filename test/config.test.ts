/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import configText from "../wrangler.jsonc?raw";
import * as worker from "../src/index";

describe("deployment config", () => {
  it("pins the Cloudflare account", () => {
    const config = JSON.parse(configText.replace(/^\s*\/\/.*$/gm, ""));
    expect(config.account_id).toBe("a16be1f911ae0c715166f97c4af654eb");
  });

  it("serves the custom domain while keeping the workers.dev origin", () => {
    const config = JSON.parse(configText.replace(/^\s*\/\/.*$/gm, ""));
    expect(config.routes).toEqual([{ pattern: "api.cinnabar.gg", custom_domain: true }]);
    expect(config.workers_dev).toBe(true);
  });

  // workerd refuses to start a Worker whose entrypoint exports anything but handlers and classes.
  it("exports only handlers and classes from the entrypoint", () => {
    for (const [name, value] of Object.entries(worker)) {
      expect(typeof value === "function" || typeof (value as { fetch?: unknown })?.fetch === "function", name).toBe(true);
    }
  });
});
