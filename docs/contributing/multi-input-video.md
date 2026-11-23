# Multiple-input video APIs and CLI

The programmatic frame APIs support multiple declared raw-frame sources. Complex
CLI execution also accepts multiple finite declared rawvideo inputs, with scoped
input time options and named output maps to rawvideo or framecrc. Neither API
claims general FFmpeg graph conformance.

## Multiple-input CLI

```text
-f rawvideo -pixel_format gray -s 2x2 -framerate 25 -i /a.raw
-f rawvideo -pixel_format gray -s 2x2 -framerate 30 -i /b.raw
-filter_complex "[0:v][1:v]hstack[o]"
-map "[o]" -c:v rawvideo -bitexact -f framecrc /joined.crc
```

The multiple-physical-input path binds decimal file indices and the single rawvideo
stream (`0`, `0:0`, `0:v`, `0:v:0` forms). Unlabeled pads use unused inputs in
file order; explicit stream reuse is possible. Each physical input is opened once,
and replay traversals share its version-bound reader. Each output has an independent
replay path, scoped seek/duration/frame limit and backpressure. All outputs prepare
before ordered publication; publication across objects is recoverable, not atomic.

Rawvideo CLI input rates and timebases are normalized before graph configuration.
Direct frame APIs retain caller-supplied rational representations. Mixed stack
rates become unknown: default rawvideo CFR falls back to25fps, while framecrc VFR
can retain the filter clock. Complex-graph outputs accept `-r`, `-fps_mode`
(`auto`, `cfr`, `vfr`, `passthrough`) and `-enc_time_base` (`0`, `filter`, `demux`,
or a positive numeric clock). These options are scoped to each output video
stream. A requested rate conflicts with VFR/passthrough and fails before I/O.
Stream copy, compressed inputs and arbitrary stream specifiers remain unsupported.

Encoder clock values support decimal/scientific values, colon ratios and bounded
arithmetic expressions with `+ - * / ^`, parentheses, hexadecimal integers and
`PI`, `E`, `PHI`, `QP2LAMBDA` constants. Expression limits are256 characters,
32 nesting levels and128 operations. General functions/state and
exhaustive platform-libm equivalence remain unimplemented or unverified.

Clock initialization retains at most the first admitted frame. If no post-trim
frame exists, Native uses the tentative filter clock; even a requested encoder
clock is not selected. A stack-generated frame has no demux clock, while
metadata-preserving filters retain it. Zero-frame output avoids data reads where
clock selection is already unambiguous; explicit CFR framecrc may need priming.

Native can intermittently fail encoder initialization when an independent output
is empty and a sibling has frames. Edge initializes each output independently
and may succeed in those cases. The repeated observations and affected recipes
are recorded in [the known difference](../../compat/known-differences/video-empty-output-initialization.json).
Those outcomes are not counted as full conformance.

The planner reserves output frame/packet buffers and preflights replay payloads,
source decoder/read buffers and a4096 source-traversal ceiling before opening files.
This is a conservative typed-payload estimate; it is not a measured isolate heap or
CPU-time guarantee. Replays may increase reads and computation. General CPU budget
enforcement and durable continuation remain incomplete. Single-physical-input
commands without the new output options retain their existing execution path
when they have a single external graph source. Explicit reuse of one source on
multiple graph inputs and the new options use the generalized execution path.

Local workerd tests exercise the public CLI over version-bound R2 readers and
compare six jobs to recorded complete Native files, including a vertical join,
input/output time limits, empty input and zero-frame output. Fault cases cover
input replacement, cancellation and uncertain/published output recovery. This
local runtime evidence does not establish production Cloudflare conformance.
The output-clock suite adds13 Native-anchored jobs over the public CLI, including
empty CFR output, arithmetic clocks, preserved/missing demux clocks and recovery.

## Synchronized frame batches

```ts
import {compileMultiInputVideoFilterGraph} from '@edge-ffmpeg/avfilter';
const graph = compileMultiInputVideoFilterGraph('[a][b]hstack[out]');
const plan = graph.plan([
  {format: 'gray', width: 3, height: 2},
  {format: 'gray', width: 5, height: 2},
], ['gray']);
const outputs = plan.applyBatch([frameA, frameB], {
  maxFrameBytes: 65536, maxStateBytes: 65536, maxResidentBytes: 1048576,
});
```

Source descriptors follow `graph.graph.inputs` external-pad order, independent of
node declaration order. There must be one descriptor and one frame per external
input, with at most 32 inputs. The frames must represent the same physical timestamp
(or all have null PTS). Positive padded strides are accepted within the frame budget.
Every output owns tight planes. `processBatches` consumes synchronized source batches
without prefetch and closes upstream on cancellation or early termination.

The supported filters and fourteen layouts are the same as the
[bounded complex-video path](complex-video.md). Joint format negotiation considers
every input pad. `inputTrim` can describe per-source implicit trim registration;
`inputRegistrationOrder` controls Native library query creation order and is not a
CLI file-map ordering option. Source iteration and trimming remain the caller's job.
Every stack node selects its own Native common clock. This preserves unreduced
rational representations: reducing `2/50` before negotiation can change Native's
chosen link time base, even though it represents the same physical unit as `1/25`.

## Finite replayable streams

`createReplayVideoExecution(description, sources, targets, budget, options)` evaluates
separate source timelines, synchronizing at each join. Each source has `geometry`,
`timeBase` and `open(signal)`, which creates an asynchronous frame iterator.
`open` must replay the same finite immutable input version with known, nondecreasing PTS on every call. For R2,
bind all replays to one versioned `ReadHandle`; re-opening a mutable object for each
branch does not provide that guarantee.

```ts
import {createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
const execution = createReplayVideoExecution(description, sources, ['gray'], {
  maxFrameBytes: 65536,
  maxStateBytes: 1048576,
  maxResidentBytes: 8388608,
  maxSourceTraversals: 16,
  maxOperatorSteps: 100000,
  signal,
});
try {
  for await (const frame of execution.outputs[0]!.frames) {
    await consumeFrame(frame);
  }
} finally {
  await execution.close();
}
```

Each output can be acquired once. Independent branches retain independent clocks;
a global source barrier would fabricate output repetition. Shared input paths are
recomputed through separate iterators, avoiding bounded fanout queue deadlocks in
nested joins. This increases I/O and computation compared with Native shared
scheduling. `sourceTraversals` and `requiredPayloadBytes` expose the conservative
preflight estimates; limits reject before source factories are opened.

Source storage is cloned before retention, and final output planes are copied so
producer reuse and caller mutation do not corrupt held join frames. Configure
`maxFrameStorageBytes` for padded source storage and `readBufferBytes` for adapter
read buffers. Internal typed-payload bounds exclude global caches, runtime objects,
garbage collection and caller-retained inputs/outputs. Whole-isolate memory still
requires measurement.

`maxOperatorSteps` bounds attempted operator work. Optional `checkpoint` and
`checkpointEvery` provide cooperative yield/cancellation hooks. They do not measure
CPU time or persist resumable state. Async source operations must cooperate with
the supplied signal. Failures cancel independent consumers; closing the execution
can separately report iterator cleanup errors. Storage publication belongs to the
calling backend and should remain deferred until every output has prepared.

Unknown or non-replayable sources, spill/cache scheduling, encoder rate/duration
planning and durable restart remain unimplemented. Unrequested terminal branches
are not drained by this API; exact CLI error/consumption behavior needs separate
validation.

## Synchronization primitive and evidence

`synchronizeFrames` exposes the all-input `sync=1` state machine with stop-before,
repeat-after and shortest behavior. Caller-provided retention leases reserve before
allocation and release on advancement and cleanup. Consumers borrow selected frames
until their next iterator request. General main/secondary priorities, nearest mode,
unknown PTS and feedback execution remain unsupported.

Native comparisons cover 9,408 two-source format/geometry cases, 6,272 complete
pixel outputs, 6,272 synchronization timelines, eight join-clock boundary cases and
384 replayed stream graphs. Real Node filesystem and local workerd/R2 checks cover nine Native-anchored graphs;
R2 checks additionally cover
version changes, resource preflight, work limits, cooperative cancellation and
publication recovery. Local workerd evidence is not deployed Cloudflare verification.
All affected capabilities remain `partial`.

The C shims under `tools/differential-runner` are development-only. Native-dependent
suites compile them with `build-oracle.mjs`, which verifies pinned commit/flags,
host, reference binaries, source and library hashes and records compiler provenance.
Run `npm run reference:stream-workers` to regenerate the R2 stream fixture recipes
and recorded Native expectations.

### Maximum frame rate and clock suffixes

`-fpsmax[:v|:0|:v:0]` caps the output rate for CFR/VSCFR. Unknown sink
rates select the cap; lower known rates are retained. Native floating-point
comparison ties are preserved. A cap conflicts with `-r` on the same output
and with VFR/passthrough. Contradictions are rejected before I/O. Each output
has its own options. Empty output initialization retains Native behavior.

Encoder clock expressions accept SI, binary `i`, byte `B` and `dB` suffixes.
`-3dB` converts a negative decibel value; `-(3dB)` is a negative time base
and is rejected. Signed hexadecimal floating literals follow pinned Native
parsing; an unsigned `0x` prefix follows integer parsing. Hexadecimal binary64
conversion rounds ties to even, including subnormals. Existing 256-character,
32-level and 128-operation limits apply. General expression functions/state
and exhaustive cross-platform libm equivalence remain incomplete.
Reference-host/local workerd tests do not certify production Cloudflare.

Encoder-clock powers retain the pinned Native identities `1^NaN = 1` and
`(-1)^(+/-inf) = 1`. These differ from ECMAScript Math.pow. Evidence includes
81 special-value combinations and 104 complete-file/rejected-clock cases through
Node and local workerd. Arbitrary finite transcendental identity remains unverified.

The dB sign check follows C strtod's longest numeric token. For example,
`-(-0x1.8dB)` is rejected rather than treating the trailing hex digits as a
decibel suffix; `-0x1.8p0dB` has a separate exponent and suffix.
Linux glibc 2.36 differs from the development-host math profile for some dB
values; see `compat/known-differences/expression-linux-profile.json`.
