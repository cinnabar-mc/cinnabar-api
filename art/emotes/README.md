# Emote authoring

The catalog owns the original Rust curves and joint solving for all emotes. The client
contains only the articulated rig and generic clip playback. These sources retain
the cosmetic artwork license in `../cosmetics/LICENSE`.

Run `python3 art/emotes/export.py` from the repository root. Each
`*.emote.json` file supplies the catalog metadata, duration and loop flag for its
matching Rust choreography module. The exporter compiles `sample.rs` with Rust
2024 and samples each clip at 60 Hz through its inclusive endpoint. It converts
model-space targets to local quaternion rotations and bind-relative offsets.
Fixed scalar trigonometry makes the encoded clips reproducible on macOS and
Linux. Reference pivots and logical parents come from
`schema/v1.json`'s `EmoteClip.x-rig`; offsets use reference leg-height units.
Floor correction remains a client responsibility. Grounded dances use zero root
height; support-pivot placement stays in the child channels. Explicit vertical
root offsets remain available for authored airborne motion.
The script writes the named clip, its hash-addressed deployment copy and catalog
metadata. Repeating it does not change the catalog version.

`pnpm check:cosmetics` regenerates the sample and checks every byte and catalog
reference. `pnpm test` checks the clip against the shared schema and invariants.
`schema/fixtures/emote-clips.json` contains synthetic conformance cases shared with
the client's parser; it contains no catalog choreography.

Version 1 uses seconds, quaternion XYZW rotations and offsets in leg-height units
on the mirrored client model axes. Each joint uses its schema-defined logical
parent rather than the skin hierarchy. Rotations use shortest-path normalized
linear interpolation; offsets interpolate linearly. Missing tracks use identity
rotation and zero offset. A single key at zero is constant; other tracks cover
zero through duration with strictly increasing times. Non-looping clips hold the
last pose. Encoded size, duration, tracks, keys, offsets and quaternion norms are
bounded by the schema. Unsupported versions are rejected.
