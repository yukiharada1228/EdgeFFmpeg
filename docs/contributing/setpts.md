# Video timestamp transform

`@edge-ffmpeg/avfilter` exports `createVideoPtsTransform` and
`createSetptsStream`. Both require an explicit expression `numericProfile`.
The transform implements the video variables in pinned FFmpeg `setpts.c`,
including prior input/output times, first known timestamp, frame count,
interlacing, injected wall clock and expression commands. Successful commands
replace expression state and reset `T_CHANGE`; failed compilation retains the
previous evaluator. `stripFps` clears duration and advertises an unknown rate.

The stream takes a source factory receiving an AbortSignal. `open()` and its
iterator are single-use. Sources send frame events with duration, followed by an
explicit EOF or error event carrying the input link's status timestamp. The stage
retains raw transformed status PTS separately from effective output link PTS;
unknown input status falls back to the last known input timestamp. `completion`
resolves after source cleanup. Consumers must inspect terminal status or completion
before treating output as successful.

There is one upstream pull per downstream request. Frame headers and metadata
objects are copied while pixel planes are shared. `maxFrameBytes` bounds the sum
of plane view lengths (up to eight planes); it does not bound backing stores,
metadata, all runtime allocations or total job CPU. The stage checks time-base
consistency. It is not a pixel-format or geometry validator.

Closing an acquired iterator before its first read does not open the source.
Cancellation requires source cooperation with its AbortSignal; an uncooperative
pending promise cannot be forcibly interrupted. Source return waits for a pending
read to settle and runs at most once. Read/upstream failures remain primary and
cleanup failures are retained separately. Commands require a frame boundary.

The cached Native corpus covers 596 frame cases and 288 EOF cases per reference
profile. These are sampled graph comparisons, not complete filter conformance.
The current implementation is an explicit stage API; CLI graph parsing, automatic
link insertion, replay and muxer output publication are not yet connected.

The state evaluator adapts `upstream/ffmpeg/libavfilter/setpts.c` at commit
`946fcce07b6dcd0331c8cc609192aeff5e1924f8`; see `packages/avfilter/NOTICE` and
`LICENSES/LGPL-2.1-or-later.txt`.

Run `node tools/differential-runner/video-setpts/generate-host.mjs` on the
recorded Darwin arm64 reference host to regenerate its cached graph results.
The EOF oracle reads pinned internal link state; its builder verifies the
internal header contents against the locked Git commit before compilation.
Run `node tools/differential-runner/video-setpts/generate-linux.mjs` to regenerate
the Linux frame, EOF and error-status corpus with the pinned container. It
records CPUID features and verifies the pinned internal headers before building.

`openFrames()` exposes a frame-only sink view and turns terminal error status into
a thrown primary error. A successful end waits for EOF cleanup before the frame
iterator reports completion. Returning this view aborts a pending cooperative
read, including when the iterator was acquired but never started. Output code
using this view can finalize only after successful exhaustion; it still must
implement its own transactional publication and recovery.

Replay and framesync now preserve backward known timestamps rather than rejecting
them. A 1,152-case Native comparison covers backward/repeated input points with
three distinct time bases on each input, shortest/longest operation, and empty
streams; the same matrix runs in local workerd. Unknown PTS support is now sampled against 2,178 Native stack cases on Node
and local workerd (`compat/known-differences/frame-sync-unknown-pts.json`).
Internal unknown sync events retain the AV_NOPTS sentinel; stack output follows
the Native same-clock rescaling that maps that sentinel to MIN+1. Explicit
EOF/error link timestamps across replay joins remain incomplete.
The graph parser still does not register setpts, so existing stateless batch
processing cannot silently ignore its state. Connecting the timed protocol through
replay, joins and output synchronization remains required before CLI support.

`createVideoPtsTransform` and `createSetptsStream` accept optional `onPrint`
and `logLevel` expression effects. The callback receives AVExpr's formatted
`{value, level, text}` record. These settings are snapshotted and survive
successful expression commands; a rejected command preserves the active
expression. Print runs on each requested evaluation, including explicit EOF
transformation. The stream does not read ahead to reproduce CLI scheduling.
Callback exceptions follow the existing processing/cleanup error protocol.
This API does not itself write CLI logs or promise Native CLI prefetch order.
