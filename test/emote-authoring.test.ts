import { expect, it } from "vitest";
import schema from "../schema/v1.json";
import twerkSource from "../art/emotes/twerk.clip.json?raw";
import breakdanceSource from "../art/emotes/breakdance.clip.json?raw";

type Vector = [number, number, number];
type Quaternion = [number, number, number, number];
type Pose = { rotation: Quaternion; position: Vector };
type Key = { time: number; rotation: Quaternion; offset: Vector };
type Clip = { duration: number; tracks: { joint: string; keys: Key[] }[] };

/** Composes rotations in parent-then-child order. */
function multiply(a: Quaternion, b: Quaternion): Quaternion {
  return [
    a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
    a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
    a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
    a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2],
  ];
}

/** Rotates a point by an exported unit quaternion. */
function rotate(q: Quaternion, point: Vector): Vector {
  return multiply(multiply(q, [...point, 0]), [-q[0], -q[1], -q[2], q[3]]).slice(0, 3) as Vector;
}

/** Reconstructs one exported frame independently from the authoring solver. */
function frame(clip: Clip, index: number): Map<string, Pose> {
  const poses = new Map<string, Pose>();
  const rig = schema.$defs.EmoteClip["x-rig"];
  const height = rig.find((joint) => joint.joint === "leftleg")!.pivot[1]!;
  for (const joint of rig) {
    const key = clip.tracks.find((track) => track.joint === joint.joint)!.keys[index]!;
    const parent = joint.parent && poses.get(joint.parent);
    let position = joint.pivot.map((value, axis) => value + key.offset[axis]!*height) as Vector;
    let rotation = key.rotation;
    if (parent) {
      const bind = rig.find((other) => other.joint === joint.parent)!.pivot;
      const moved = rotate(parent.rotation, position.map((value, axis) => value-bind[axis]!) as Vector);
      position = moved.map((value, axis) => value+parent.position[axis]!) as Vector;
      rotation = multiply(parent.rotation, rotation);
    }
    poses.set(joint.joint, { position, rotation });
  }
  return poses;
}

it("keeps Twerk's feet planted and shoulders level while the pelvis pulses", () => {
  const clip: Clip = JSON.parse(twerkSource);
  const first = frame(clip, 0);
  let lowestHip = Infinity;
  let highestHip = -Infinity;
  for (let index = 0; index < clip.tracks[0]!.keys.length; index++) {
    const pose = frame(clip, index);
    expect(pose.get("head")!.position[1]).toBeCloseTo(first.get("head")!.position[1], 4);
    const hip = pose.get("leftleg")!.position[1];
    lowestHip = Math.min(lowestHip, hip);
    highestHip = Math.max(highestHip, hip);
    for (const name of ["leftleg.cinnabar_ankle", "rightleg.cinnabar_ankle"]) {
      const foot = pose.get(name)!;
      foot.position.forEach((value, axis) => expect(value).toBeCloseTo(first.get(name)!.position[axis]!, 4));
      expect(Math.abs(foot.rotation[3])).toBeCloseTo(1, 5);
      foot.rotation.slice(0, 3).forEach((value) => expect(value).toBeCloseTo(0, 5));
    }
  }
  expect(highestHip-lowestHip).toBeGreaterThan(2);
});

it.each([twerkSource, breakdanceSource])("keeps grounded choreography out of the airborne root-height channel", (source) => {
  const clip: Clip = JSON.parse(source);
  const root = clip.tracks.find((track) => track.joint === "root")!;
  expect(root.keys.every((key) => key.offset[1] === 0)).toBe(true);
  for (const track of clip.tracks) {
    const a = track.keys[0]!;
    const b = track.keys.at(-1)!;
    a.offset.forEach((value, axis) => expect(value).toBeCloseTo(b.offset[axis]!, 5));
    expect(Math.abs(a.rotation.reduce((sum, value, axis) => sum+value*b.rotation[axis]!, 0))).toBeCloseTo(1, 5);
  }
});
