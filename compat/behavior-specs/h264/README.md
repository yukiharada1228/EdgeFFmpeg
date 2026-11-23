# Scoped progressive H264 vectors

`cases.json` contains72self-owned complete AnnexB streams and859Native frame
records.47normative streams cover POC0/1/2, frame-number wraps, signed POC
deltas, reference cycles, MMCO5, repeated resets and multiple slices. Seven
additional streams exercise independently assembled direct partitions and
OpenH264-generated CAVLC/CABAC. Eighteen x264-generated streams exercise moving
patterns, weighted P prediction, reference B pictures, spatial/temporal direct
prediction, 8x8 transforms and1918x1078cropping. All images are mathematical
patterns; no SDK sample footage or external audiovisual assets are included.

The differential test builds a guarded oracle from the current pinned Native
reference. It compares each frozen frame with fresh Native output before
checking public decoder pixels, metadata and clocks. Workers replay the same
vectors. Normal API profiles use16MiB Wasm with explicit32MiB reservations;
two HD profiles use64MiB Wasm with128MiB reservations and4MiB frame budgets.
These are payload/linear-memory bounds, not total isolate-memory certification.

Frames are checked after decoder closure and mutation of input packet arrays.
Comparisons include owned I420 planes, pixel SHA256, geometry/format/color range,
key/type, int64 PTS/duration/timebase, MMCO5 tokens and retained-counter cleanup.
This is not general H264, field/recovery, concealment, encoder or runtime
conformance certification.

`mp4.json` deduplicates26frozen MP4 inputs and146Native output expectations,
covering automatic/index/id/language/negative/optional mapping and frame limits
including zero and limits beyond EOF. Integration tests invoke the actual Node
launcher and current Native FFmpeg. R2 tests use bounded short reads/writes and
stream output hashes. Fifteen additional controls cover corrupt configuration,
late decode/NAL-length errors, changing input, resource exhaustion, cancellation,
no-overwrite and retaining old outputs. The HD failure test aborts multipart
uploads after actual parts were uploaded. These fault effects test transactional
storage guarantees; they do not claim general Native error-output equivalence.

## Reproduction

Build the independent codec using `docs/codecs/h264.md`. The normative and
hand-assembled generators in `tools/differential-runner/h264/fixtures` write to
`.build/h264-fixtures`. The four SDK-encoded vectors require this fixture-only
encoder build followed by `fixtures/generate-encoded.mjs`:

```sh
node tools/differential-runner/h264/build-fixture-encoder.mjs --emsdk /path/to/pinned/emsdk
node tools/differential-runner/h264/fixtures/generate-encoded.mjs
```

The x264 generators accept `EDGE_FFMPEG_X264` as an executable path and require
source version0.165.3222 b35605a. They record the exact binary SHA256 and full
source commit, disable assembly, use one thread and compare repeated encodes.
The encoder is only a developer fixture tool and is never a runtime fallback.
Frozen vectors need no x264 installation to run tests. After running the
applicable generators, check all72packet streams with:

```sh
node tools/differential-runner/h264/verify-fixtures.mjs
```

`manifest.json` binds generator/oracle sources and original Native provenance.
`mp4-manifest.json` records input-container origins and output expectations.
The packet generators reproduce all72AnnexB byte streams on the recorded host;
MP4 container serialization is a frozen input, not a mux bit-exact claim.
Missing or changed codec builds fail tests; no implicit download or test skip
substitutes for the explicitly supplied ABI2 module.
