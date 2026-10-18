import { Validator, type Schema } from "@cfworker/json-schema";
import schema from "../schema/v1.json";

const definition = schema.$defs.EmoteClip;
const validator = new Validator({ $ref: `${schema.$id}#/$defs/EmoteClip` }, "2020-12");
validator.addSchema(schema as unknown as Schema);

type Key = { time: number; rotation: number[]; offset: number[] };
export type EmoteClip = { version: number; duration: number; loop: boolean; tracks: { joint: string; keys: Key[] }[] };

/** Applies the schema and its cross-field invariants before a clip may enter the catalog. */
export function validEmoteClip(value: unknown, bytes: number): value is EmoteClip {
  if (bytes > definition["x-max-bytes"] || !validator.validate(value).valid) return false;
  const clip = value as EmoteClip;
  const joints = new Set<string>();
  let count = 0;
  for (const track of clip.tracks) {
    if (joints.has(track.joint)) return false;
    joints.add(track.joint);
    count += track.keys.length;
    if (count > definition["x-max-total-keyframes"]) return false;
    if (track.keys[0]!.time !== 0 || (track.keys.length > 1 && track.keys.at(-1)!.time !== clip.duration)) return false;
    for (const [index, key] of track.keys.entries()) {
      if (key.time > clip.duration || (index > 0 && key.time <= track.keys[index - 1]!.time)) return false;
      const norm = key.rotation.reduce((sum, value) => sum + value * value, 0);
      if (Math.abs(norm - 1) > definition["x-quaternion-tolerance"]) return false;
    }
  }
  return true;
}
