// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//! Original squat and hip pulse on the catalog joint rig.
use super::*;

/// Indices required by the bent-knee solver, resolved independently for each skeleton.
struct ArticulatedJoints {
    body: usize,
    legs: [[usize; 3]; 2],
}

impl ArticulatedJoints {
    /// Resolves the body and leg chains required by the schema-owned authoring rig.
    fn resolve(names: &[Box<str>]) -> Option<Self> {
        let find = |name: &str| names.iter().position(|part| part.as_ref() == name);
        Some(Self {
            body: find("body")?,
            legs: [
                [
                    find("leftleg")?,
                    find("leftleg.cinnabar_knee")?,
                    find("leftleg.cinnabar_ankle")?,
                ],
                [
                    find("rightleg")?,
                    find("rightleg.cinnabar_knee")?,
                    find("rightleg.cinnabar_ankle")?,
                ],
            ],
        })
    }
}

/// Samples the authored squat with connected knees and level planted feet.
pub(super) fn targets(
    bones: &[RuntimeBone],
    names: &[Box<str>],
    rest: &[BoneTransform],
    seconds: f64,
    height: f32,
    _bounds: Option<&[Option<articulated::BoneBounds>]>,
) -> Vec<Option<BoneTransform>> {
    let joints = ArticulatedJoints::resolve(names).expect("schema joint rig");
    let angle = (seconds.rem_euclid(DURATION) / DURATION * std::f64::consts::TAU) as f32;
    let hip_y = height * (0.625 + 0.10 * sin_cos(angle).1);
    let hip_z = height * (0.33 + 0.10 * sin_cos(angle).1);
    let torso_height = rest[joints.body].translation_scale[1] - height;
    let shoulder_y = height * 0.625 + torso_height * sin_cos(37.0_f32.to_radians()).1;
    let lean = ((shoulder_y - hip_y) / torso_height).clamp(-1.0, 1.0);
    let lean = acos(lean);
    let twist = 6.0 * sine(angle);
    let torso = quat_from_euler([-lean.to_degrees(), twist, 0.0]);
    let offset = [0.0, hip_y - height, hip_z];
    let mut targets: Vec<_> = bones
        .iter()
        .zip(names)
        .zip(rest)
        .map(|((bone, name), rest)| {
            let rotation = match name.as_ref() {
                "waist" | "body" => torso,
                "head" => [0.0, 0.0, 0.0, 1.0],
                "leftarm" => quat_from_euler([-16.0, twist, -3.0]),
                "rightarm" => quat_from_euler([-16.0, twist, 3.0]),
                _ if bone.parent.is_none() => [0.0, 0.0, 0.0, 1.0],
                _ => return None,
            };
            let mut target = *rest;
            let pivot = std::array::from_fn(|axis| rest.translation_scale[axis]);
            let relative = [pivot[0], pivot[1] - height, pivot[2]];
            let pivot = if matches!(
                name.as_ref(),
                "waist" | "body" | "head" | "leftarm" | "rightarm"
            ) {
                let tilted = rotate_vector(torso, relative);
                [tilted[0], height + tilted[1], tilted[2]]
            } else {
                pivot
            };
            target.rotation = quat_multiply(rotation, rest.rotation);
            for axis in 0..3 {
                target.translation_scale[axis] = pivot[axis] + offset[axis];
            }
            Some(target)
        })
        .collect();
    for [leg, knee, ankle] in joints.legs {
        let x = rest[leg].translation_scale[0];
        let foot_height = rest[ankle].translation_scale[1];
        let thigh_length = height - rest[knee].translation_scale[1];
        let shin_length = rest[knee].translation_scale[1] - foot_height;
        let hip = [x, hip_y, hip_z];
        let foot = [x + x.signum() * height * 0.16, foot_height, 0.0];
        let delta: [f32; 3] = std::array::from_fn(|axis| foot[axis] - hip[axis]);
        let distance = delta.iter().map(|v| v * v).sum::<f32>().sqrt();
        let direction = delta.map(|v| v / distance);
        // Solve thigh/shin to the ankle; the separate foot keeps its sole level.
        let perpendicular = [
            direction[0] * direction[2],
            direction[1] * direction[2],
            -1.0 + direction[2] * direction[2],
        ];
        let length = perpendicular.iter().map(|v| v * v).sum::<f32>().sqrt();
        let along = (thigh_length * thigh_length - shin_length * shin_length + distance * distance)
            / (2.0 * distance);
        let bend = (thigh_length * thigh_length - along * along)
            .max(0.0)
            .sqrt();
        let joint: [f32; 3] = std::array::from_fn(|axis| {
            hip[axis] + direction[axis] * along + perpendicular[axis] * bend / length
        });
        for (index, from, to, segment_length) in [
            (leg, hip, joint, thigh_length),
            (knee, joint, foot, shin_length),
        ] {
            let direction: [f32; 3] =
                std::array::from_fn(|axis| (to[axis] - from[axis]) / segment_length);
            let quaternion = [-direction[2], 0.0, direction[0], 1.0 - direction[1]];
            let length = quaternion.iter().map(|v| v * v).sum::<f32>().sqrt();
            let mut target = rest[index];
            target.rotation = quaternion.map(|v| v / length);
            target.translation_scale[..3].copy_from_slice(&from);
            targets[index] = Some(target);
        }
        let mut target = rest[ankle];
        target.rotation = [0.0, 0.0, 0.0, 1.0];
        target.translation_scale[..3].copy_from_slice(&foot);
        targets[ankle] = Some(target);
    }
    // Root height is authored motion, separate from the squat's joint positions.
    let root = names
        .iter()
        .position(|name| name.as_ref() == "root")
        .unwrap();
    targets[root] = Some(rest[root]);
    for (index, (_, parent, _)) in RIG.iter().enumerate() {
        if targets[index].is_some() {
            continue;
        }
        let parent = parent.expect("root has an explicit target");
        let pose = targets[parent].unwrap();
        let offset = rotate_vector(
            pose.rotation,
            std::array::from_fn(|axis| {
                rest[index].translation_scale[axis] - rest[parent].translation_scale[axis]
            }),
        );
        let mut target = rest[index];
        target.rotation = pose.rotation;
        for axis in 0..3 {
            target.translation_scale[axis] = pose.translation_scale[axis] + offset[axis];
        }
        targets[index] = Some(target);
    }
    targets
}

/// Inverts deterministic cosine without host-specific inverse trigonometry.
fn acos(value: f32) -> f32 {
    let (mut low, mut high) = (0.0, std::f32::consts::PI);
    for _ in 0..26 {
        let middle = (low + high) * 0.5;
        if sin_cos(middle).1 > value {
            low = middle;
        } else {
            high = middle;
        }
    }
    (low + high) * 0.5
}
