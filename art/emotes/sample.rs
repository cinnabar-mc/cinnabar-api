// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//! Samples the original Rust curves; export.py provides the schema-owned reference rig.
use std::io::{self, Write};
const DURATION: f64 = 6.4;
#[derive(Clone, Copy)]
struct BoneTransform {
    rotation: [f32; 4],
    translation_scale: [f32; 4],
}
struct RuntimeBone {
    parent: Option<usize>,
}
mod articulated {
    #[derive(Clone, Copy)]
    pub struct BoneBounds {
        pub min: [f32; 3],
    }
}
mod breakdance;
include!("rig.rs");

/// Samples each track on the same inclusive grid, converting model targets to logical-parent deltas.
fn main() {
    let names: Vec<Box<str>> = RIG.iter().map(|(name, _, _)| (*name).into()).collect();
    let rest: Vec<_> = RIG
        .iter()
        .map(|(_, _, pivot)| BoneTransform {
            rotation: [0.0, 0.0, 0.0, 1.0],
            translation_scale: [pivot[0], pivot[1], pivot[2], 1.0],
        })
        .collect();
    let bones: Vec<_> = RIG
        .iter()
        .map(|(_, parent, _)| RuntimeBone { parent: *parent })
        .collect();
    let bounds: Vec<_> = names
        .iter()
        .map(|name| {
            name.ends_with("cinnabar_wrist")
                .then_some(articulated::BoneBounds { min: [-2.0; 3] })
        })
        .collect();
    let steps = (DURATION * 60.0).round() as usize;
    let mut out = io::BufWriter::new(io::stdout().lock());
    write!(
        out,
        "{{\"version\":1,\"duration\":{DURATION},\"loop\":true,\"tracks\":["
    )
    .unwrap();
    for (joint, (name, parent, _)) in RIG.iter().enumerate() {
        if joint > 0 {
            write!(out, ",").unwrap();
        }
        write!(out, "{{\"joint\":\"{name}\",\"keys\":[").unwrap();
        for frame in 0..=steps {
            let time = DURATION * frame as f64 / steps as f64;
            let targets =
                breakdance::targets(&bones, &names, &rest, time, REFERENCE_HEIGHT, Some(&bounds));
            let target = targets[joint].unwrap();
            let (rotation, offset) = if let Some(parent) = parent {
                let pose = targets[*parent].unwrap();
                let q = pose.rotation;
                let inverse = [-q[0], -q[1], -q[2], q[3]];
                let delta = std::array::from_fn(|axis| {
                    target.translation_scale[axis] - pose.translation_scale[axis]
                });
                let local = rotate_vector(inverse, delta);
                (
                    quat_multiply(inverse, target.rotation),
                    std::array::from_fn::<_, 3, _>(|axis| {
                        (local[axis]
                            - (rest[joint].translation_scale[axis]
                                - rest[*parent].translation_scale[axis]))
                            / REFERENCE_HEIGHT
                    }),
                )
            } else {
                (
                    target.rotation,
                    std::array::from_fn(|axis| {
                        (target.translation_scale[axis] - rest[joint].translation_scale[axis])
                            / REFERENCE_HEIGHT
                    }),
                )
            };
            let norm = rotation
                .iter()
                .map(|value| value * value)
                .sum::<f32>()
                .sqrt();
            let rotation = rotation.map(|value| (value / norm).clamp(-1.0, 1.0));
            if frame > 0 {
                write!(out, ",").unwrap();
            }
            write!(out, "{{\"time\":{time:.8},\"rotation\":[{:.7},{:.7},{:.7},{:.7}],\"offset\":[{:.7},{:.7},{:.7}]}}",
                rotation[0],rotation[1],rotation[2],rotation[3],offset[0],offset[1],offset[2]).unwrap();
        }
        write!(out, "]}}").unwrap();
    }
    writeln!(out, "]}}").unwrap();
}

/// Converts intrinsic XYZ degree rotations to a quaternion.
fn quat_from_euler(rotation: [f32; 3]) -> [f32; 4] {
    let [x, y, z] = rotation.map(|value| value.to_radians() * 0.5);
    let (sx, cx) = x.sin_cos();
    let (sy, cy) = y.sin_cos();
    let (sz, cz) = z.sin_cos();
    [
        sx * cy * cz - cx * sy * sz,
        cx * sy * cz + sx * cy * sz,
        cx * cy * sz - sx * sy * cz,
        cx * cy * cz + sx * sy * sz,
    ]
}

/// Composes quaternion rotations in parent-then-child order.
fn quat_multiply(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}

/// Rotates a vector by a unit quaternion.
fn rotate_vector(rotation: [f32; 4], vector: [f32; 3]) -> [f32; 3] {
    let qvector = [vector[0], vector[1], vector[2], 0.0];
    let inverse = [-rotation[0], -rotation[1], -rotation[2], rotation[3]];
    let result = quat_multiply(quat_multiply(rotation, qvector), inverse);
    [result[0], result[1], result[2]]
}
