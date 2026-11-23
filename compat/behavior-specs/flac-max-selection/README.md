# Advanced FLAC stream-map Native evidence

Development-only independent evidence, not a production-conformance claim.

`cases.json` contains 60 actual sequential invocations of the pinned Native
FFmpeg binary SHA-256
`1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92`,
upstream commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`.
The complete reference build metadata and actual FLAC Wasm hash are recorded.
The Wasm hash identifies the integration target; this generator does not execute
Wasm or import production helpers.

Run from the repository root:

    node tools/differential-runner/flac-max-selection/generate.mjs --verify

Verification validates the existing evidence without Native invocations. Ordinary
execution also reuses matching evidence. If existing evidence has a different
fingerprint, generation refuses to overwrite it automatically. Fresh generation
uses only `.build/temp/flac-max-selection-*` transient paths, cleans them in a
finally block, and atomically renames the completed corpus into place. Inputs,
outputs and captured logs are bounded to 512 KiB each; calls have a 10-second
timeout. There are no parallel Native calls or fixture reencodes.

## Inputs and recorded observations

Three inputs each exercise 20 map combinations:

- Unchanged canonical `16-2-extremes-5/s16le` FLAC from
  `flac-decode-cli/cases.json`.
- The same audio with the existing saved encoded BMP PICTURE block appended.
- The same audio with the existing saved encoded PNG picture embedded in a
  `METADATA_BLOCK_PICTURE` Vorbis comment.

Each row contains its input bytes/hash, source provenance, virtual CLI arguments
using `/in.flac` and `/out`, actual exit code, output bytes/hash or null, normalized
Native stderr, input descriptor metadata, and selected input stream IDs in output
order. Selections come from Native's `Stream mapping` log, not a reimplementation
of the selection algorithm. An empty selection on an early failure means no
mapping was emitted, not a prediction of hypothetical output streams.

The 60 calls yielded 41 successes (exit 0) and 19 retained failures (exit 234).
All successful outputs are stream-copy framecrc, avoiding image reencoding.

Important pinned observations:

- `0:V?` excludes attached pictures but, when it matches nothing, leaves automatic
  selection enabled: pictured framecrc inputs select `[1, 0]`, not audio alone.
  Required `0:V` fails for all three inputs.
- `0:m:title:cover` selects picture ID 1 on either pictured input and fails on the
  clean audio input. `0:disp:attached_pic` behaves similarly.
- `0:m:encoder?` fails on all three inputs. In this pinned parser the question
  mark belongs to the metadata key; it is not treated as an optional-map suffix.
  Likewise `0:m:title:cover?` fails because the value is literally `cover?`.
  Plain `0:m:encoder` also fails because these inputs have no stream-level
  encoder tag. Container encoder metadata is not stream metadata.
- Negative disposition/metadata maps remove selected pictures, and removing a
  duplicate picture selection removes every existing matching duplicate.
- An initial required negative picture map fails even on pictured inputs; its
  optional form leaves automatic selection enabled. Negative unmatched selectors
  after an existing positive map do not fail.
- Explicit maps preserve order: `0:m:title:cover`, then `0:a`, selects `[1, 0]`;
  mapping all selects `[0, 1]`. Removing then readding pictures selects `[0, 1]`.

## Remaining integration/architecture gaps

This corpus does not implement or validate production advanced-map support,
Workers resource reservations, cancellation, bounded streaming, cleanup, atomic
media publication, or the full 22-chapter architecture goal. The coordinator owns
backend integration and conformance tests. Coverage is one clean stereo audio
stream plus at most one encoded attached picture, not multiple pictures,
multi-input mapping, arbitrary stream tags, or all disposition expressions.
PNG is copied as an encoded packet; successful copying is not a claim that the
saved PNG decodes correctly. Native descriptor metadata is preserved verbatim
alongside structured codec/type/attached-picture/tag fields.
