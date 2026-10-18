/// <reference types="vite/client" />
import { expect, it } from "vitest";
import cases from "../schema/fixtures/emote-clips.json";
import { validEmoteClip } from "../src/emote-clips";
import { catalog } from "../src/cosmetics";
import { env, exports } from "cloudflare:workers";

it.each(cases)("checks the shared client conformance case: $name", ({ clip, valid }) => {
  expect(validEmoteClip(clip, new TextEncoder().encode(JSON.stringify(clip)).length)).toBe(valid);
});

it("validates and serves every exported catalog clip through the cosmetics asset path", async () => {
  const files = import.meta.glob("../assets/cosmetics/*", { query: "?raw", import: "default", eager: true });
  for (const item of catalog.emotes) {
    const text = files[`../assets/cosmetics/${item.clip.sha256}`] as string;
    const bytes = new TextEncoder().encode(text);
    expect(validEmoteClip(JSON.parse(text), bytes.length)).toBe(true);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    expect(Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(item.clip.sha256);
    expect(bytes.length).toBe(item.clip.bytes);
    await env.COSMETIC_ASSETS.put(item.clip.sha256, bytes);
    const response = await exports.default.fetch(`https://api.test${item.clip.url}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.text()).toBe(text);
  }
});

it("keeps the rig vocabulary and track budget derived from the same schema rig", async () => {
  const { default: schema } = await import("../schema/v1.json");
  const rig = schema.$defs.EmoteClip["x-rig"];
  expect(schema.$defs.EmoteTrack.properties.joint.enum).toEqual(rig.map((joint) => joint.joint));
  expect(schema.$defs.EmoteClip.properties.tracks.maxItems).toBe(rig.length);
  for (const [index, joint] of rig.entries()) {
    if (joint.parent !== null) expect(rig.slice(0,index).some((parent) => parent.joint === joint.parent)).toBe(true);
  }
});
