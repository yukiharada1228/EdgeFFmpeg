# Signed video time and uninitialized decoder clocks

Finite rawvideo execution accepts signed `-ss` and `-to` values in the media and
timed backends. Negative durations remain rejected; `-to` must follow `-ss` in
time. Audio timing keeps its existing parser behavior. Output seeks shift the
encoder/copy clock without inventing source frames before the physical input.

Negative input seeking follows the pinned rawvideo demux behavior. A target rounded
to frame zero can seek successfully. A target below frame zero can fail after
flushing stream-info packet buffers; reading resumes at the underlying physical
position rather than clamping to frame zero. The finite adapter models default
probe-size/rate behavior, capped by input size. Decoder trim duration starts from
the first retained frame; streamcopy retains its independent cutoff semantics.

Forced decoder cadence changes filter parameters only after a frame has actually
been decoded. Empty sources and fully skipped sources retain physical demux timing
for tentative graph/encoder initialization. Per-source decoding flags drive EOF
clock selection. This also distinguishes a source with no frames from a decoded
source whose output is removed by time or frame limits.

The canonical corpus contains 8,038 jobs, split into bounded comparison groups:
108 signed seek pairs; 90 seek/duration boundaries; 1,296 physical/forced/empty
clock jobs; 2,160 time/frame-limit jobs; 3,360 jobs across fourteen pixel formats;
576 two-source hstack/EOF jobs; and 448 complete rawvideo byte comparisons.
Framecrc and raw output are stored as base64 of the complete Native output bytes.
Source/build/configuration/binary fingerprints are checked during regeneration.

Node and local workerd/R2 tests use public APIs. R2 fixtures bound request/input
sizes and allow at most512KiB output for high-rate CFR expansion. Another72 input
generation mutations reject replaced sources without publication or leftover
objects. A deliberate64KiB output budget exercises safe output failure and
cleanup. These fixture settings do not alter library resource budgets.

```sh
node tools/differential-runner/video-signed-time/generate.mjs
npx vitest run tests/differential/signed-video-time.test.ts tests/workers/signed-video-time.test.ts --maxWorkers=1
```

Rejected Native cases compare only success/failure classification, not exact
exit codes or diagnostics. Default probe behavior is not arbitrary probe-option
or network-seek conformance. Audio signed time, compressed-codec seeking, temporal
filter history, arbitrary multi-source graphs, unknown timestamps, production
Cloudflare execution, full CPU/heap enforcement and distributed recovery remain
unverified or unfinished. This remains partial implementation of the detailed
design, not FFmpeg compatibility certification.
