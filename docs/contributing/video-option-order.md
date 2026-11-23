# Video option order and rawvideo clocks

The finite rawvideo paths of `createMediaBackend` and `createTimedVideoBackend`
resolve output string options using the last matching video stream option.
Unused string values are ignored; numeric frame counts are validated when read,
even if a later option replaces them. Single declared video-stream selectors use
the existing pinned base-zero integer parsing and signed32 narrowing rules.

For rawvideo input, typed `-s`, `-r` and `-pix_fmt` options override generic
`-video_size`, `-framerate` and `-pixel_format` dictionaries after option parsing.
The last typed input `-r`, including nonmatching media selectors, controls the
physical demux rate. The last matching `-r` independently forces decoder cadence.
Physical seeking uses the demux clock, decoded frame timestamps use the forced
rate, and streamcopy preserves packet timing while rescaling to its output clock.

`compat/behavior-specs/video-option-order` records 2,086 option-order jobs across
fourteen eight-bit rawvideo formats, plus 800 mixed-clock jobs. The latter cover
five rate pairs, input seeks/durations, output trims, passthrough/CFR output,
filter/demux encoder timebases, encoding and streamcopy. Tests compare complete
Native framecrc texts through public APIs in Node and local workerd/R2. Failure
cases compare success/failure projection and absence of published output, without
claiming exact Native exit codes or diagnostic wording. Tests check disposal and
one handle acquisition per input. This is not production Cloudflare verification.

Regenerate after building the pinned development reference:

```sh
node tools/differential-runner/video-option-order/generate.mjs
npx vitest run tests/differential/video-option-order.test.ts tests/workers/video-option-order.test.ts --maxWorkers=1
```

The generator verifies source/build/flags/binary fingerprints and isolates each
Native job. Reference provenance records the actual host numeric profile; the
local macOS oracle does not certify Linux or a reproducible compiler toolchain.
General stream lists, compressed-codec clocks, unknown timestamps, full CLI
semantics, complete resource measurements and distributed recovery remain open.
