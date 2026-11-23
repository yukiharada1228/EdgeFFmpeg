# Finite rawvideo streamcopy

`createMediaBackend` copies finite declared rawvideo packets without decoding or
encoding. Output `-pix_fmt`, `-s`, `-fps_mode` and `-enc_time_base` do not alter
streamcopy output, including values never parsed by an encoder. Video filters
still conflict with copy. Rate and maximum-rate options retain validation and
cannot be combined. A valid maximum rate does not limit copied packets.

Output `-r` chooses the streamcopy timebase and average rate without duplicating
or dropping packets. Physical demux timestamps and durations are rescaled to that
clock. This remains distinct from the matching forced input rate and physical
rawvideo input rate described in [input clock behavior](video-option-order.md).

The canonical `compat/behavior-specs/video-streamcopy` corpus contains 2,520 jobs:
fourteen declared eight-bit pixel formats plus the gray8 alias, three input clock configurations, five
output-rate choices, seeks/durations/frame limits and sixteen output-option
patterns, plus 240 high-rate jobs around the 1,000/2,000 fps probe-duration
thresholds, coarse output clocks and packet timestamp collisions. Complete rawvideo bytes (including high-bit bytes) and framecrc output
are compared through public APIs on Node and local workerd/R2. Rejected cases
check success/failure projection, no input reads and no published output. R2 tests
also verify no remaining temporary objects and one handle per used input. Another 64 input-generation mutation scenarios
(60 ordinary and four high-rate configurations) reject replaced input without
publishing output or leaving temporary objects.

```sh
node tools/differential-runner/video-streamcopy/generate.mjs
npx vitest run tests/differential/video-streamcopy.test.ts tests/workers/video-streamcopy.test.ts --maxWorkers=1
```

Regeneration verifies the fixed development reference source, flags and binary.
The oracle records its actual numeric profile. These tests do not establish exact
Native error status/diagnostics, compressed-codec copy, actor backend streamcopy,
production Cloudflare execution, complete memory/CPU enforcement, distributed
recovery or full CLI compatibility.
