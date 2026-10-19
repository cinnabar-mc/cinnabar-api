/// <reference types="vite/client" />
import { expect, it } from "vitest";
import cases from "../schema/fixtures/emote-clips.json";
import { validEmoteClip } from "../src/emote-clips";
import { catalog } from "../src/cosmetics";

it.each(cases)("checks the shared client conformance case: $name", ({ clip, valid }) => {
  expect(validEmoteClip(clip, new TextEncoder().encode(JSON.stringify(clip)).length)).toBe(valid);
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

it("requires catalog clip IDs that the existing emote wire messages can carry", async () => {
  const { Validator } = await import("@cfworker/json-schema");
  const { default: schema } = await import("../schema/v1.json");
  const validator = new Validator({ $ref: `${schema.$id}#/$defs/CatalogEmote` }, "2020-12");
  validator.addSchema(schema);
  expect(validator.validate(catalog.emotes[0]).valid).toBe(true);
  expect(validator.validate({ ...catalog.emotes[0], id: "fixture:path/clip" }).valid).toBe(false);
});
