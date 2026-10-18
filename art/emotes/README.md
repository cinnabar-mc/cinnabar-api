# Emote authoring

The catalog owns Breakdance's original Rust curves and joint solving. The client
contains only the articulated rig and generic clip playback. These sources retain
the cosmetic artwork license in `../cosmetics/LICENSE`.

Run `python3 art/emotes/export.py` from the repository root. It compiles `sample.rs`
with Rust 2024, samples the curves in `breakdance.rs` and `breakdance/joints.rs` at
60 Hz over the inclusive 6.4-second loop, and converts their model-space targets
to local quaternion rotations and bind-relative offsets. The reference pivots and
logical parents come from `schema/v1.json`'s `EmoteClip.x-rig`. Offsets are divided
by the reference leg height. Floor correction remains a client responsibility.
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
