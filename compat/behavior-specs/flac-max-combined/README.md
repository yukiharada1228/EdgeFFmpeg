# Combined FLAC transform and public-route evidence

Reference: FFmpeg 9.0.2, commit
`946fcce07b6dcd0331c8cc609192aeff5e1924f8`, Native binary SHA-256
`1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92`.
The trusted 69,607-byte decoder module has SHA-256
`d5f5015f019ecb59fcbce62c915e695aa97c5141379e72c06e7acd9b4394f65f`.

`cases.json` retains 40 actual Native executions across 16/24-bit stereo
sources with known and unknown total sample counts. `scalar.json` adds 18
actual executions with explicit `-cpuflags 0`; previously captured rows are
verified and reused by `scalar.mjs`, not executed again.

Public backend acceptance distinguishes output parity from compatibility gaps:

| Evidence | Count | Assertion |
| --- | ---: | --- |
| Default-profile supported combinations | 14 | Exact Native output bytes |
| Explicit scalar-profile combinations | 18 | Exact Native output bytes |
| Input seek | 8 | Explicit unsupported error before opening output |
| Unpinned scalar-sensitive arithmetic | 18 | Require `-cpuflags 0` before opening output |

The original Native-positive gap rows remain unchanged. Rejecting them is not
Native compatibility. In particular, input FLAC demux seeking cannot be
implemented by pretending it is output sample trimming. Unpinned SIMD rounding
also differs from the existing scalar FIR/conversion implementation.

The public pipeline snapshots policy, validates actual stream selection, opens
one decoder, counts the transformed stream using bounded storage, closes it,
then opens one decoder for atomic output publication. It checks metadata and
actual transformed sample/frame counts between passes. Matrix normalization
uses the final encoder's integer/float constraint independently of FIR storage
precision. No production path loads Native code or a `.build` artifact.

Tests: `tests/integration/flac-max-combined.test.ts` and
`tests/workers/flac-max-combined.test.ts`. The latter uses actual local
R2/workerd without Node compatibility. It additionally checks 26 FLAC packet
copy outputs and six cancellation/write/output-budget controls against an
existing object, including zero remaining staging objects/multipart uploads.
Two Native file-protocol `-blocksize` cases are modeled by VFS short reads;
the virtual backend does not implement that CLI protocol option.

The same actual public R2/workerd route also runs all 60 extended selection
rows using demuxed stream descriptors, not injected fixture descriptors. Across
the complete 145-row public matrix there are 80 exact output comparisons,
46 explicit unsupported-profile rejections and 19 Native error comparisons,
plus the six transactional failure controls.

`tests/integration/flac-max-public-selection.test.ts` separately covers the
60 selection rows: 21 audio-only outputs, 19 Native error results, and 20
explicit selected-picture output gaps. Metadata consumes a trailing `?` as
part of its key/value before Native `opt_map` processes optional-map remainder.
Container comments are not audio-stream tags.

This is bounded local evidence, not general resampler bit-exactness, arbitrary
filter/rate placement, input seeking, picture/chapter preservation, cross-platform
certification, or completion of the full architecture. Main feature capability
certification and the historical full-project compatibility report are not
upgraded by these comparisons.

Changed-rate `framecrc` and decoded frame limits explicitly reject before output:
FIR allocation chunks are not Native AVFrame packet boundaries. Changed-rate
filter chains currently require a final rate boundary and only anull, volume or
asetrate stages; other placement and buffering/padding graphs are not inferred.
Five actual Node launcher cases cover scalar volume/rate, unknown-total output
time selection, explicit fused float contraction, packet copy without loading a decoder, and explicit metadata/
padding/chapter-drop policy captured separately in `remux-policy.json`.
