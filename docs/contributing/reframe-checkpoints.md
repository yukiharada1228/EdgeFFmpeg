# Audio FIFO checkpoints

`createAudioReframeState(samples, pad, options, checkpoint?)` from
`@edge-ffmpeg/avfilter` exposes the actual packed/planar audio FIFO used by
`reframeAudio` and `asetnsamples`. It can save and restore pending samples across
fresh runtimes. This is component state continuation, rather than replaying an
entire command from its input.

```ts
const state = createAudioReframeState(3, true, {maxFrameBytes: 65536});
for (const output of state.push(inputFrame)) await commitFrame(output);
const bytes = serializeAudioReframeCheckpoint(state.checkpoint(), {
  maxFrameBytes: 65536,
});
// Persist bytes and the corresponding committed output boundary.
state.dispose();

const saved = deserializeAudioReframeCheckpoint(bytes, {maxFrameBytes: 65536});
const resumed = createAudioReframeState(3, true, {maxFrameBytes: 65536}, saved);
for (const output of resumed.push(nextInputFrame)) await commitFrame(output);
const tail = resumed.finish();
if (tail) await commitFrame(tail);
resumed.dispose();
```

Drain `push()` fully before taking a checkpoint or beginning another input frame.
A suspended iterator owns the input transition. Saving/reentry is rejected while
it is active, and abandoning it poisons the state. Completed old iterators cannot
clear a newer transition's busy flag. `finish()` emits the final partial/padded
frame once and is idempotent; finished snapshots do not emit the tail again.
Cancellation, disposal and malformed input fail explicitly.

The snapshot includes sample count/padding policy, format, compact pending plane
bytes, received/emitted counters, timestamp origin and terminal status. Counters
and origin use canonical decimal strings, exact as bigints within signed64 (the
range of native FFmpeg's sample counts and timestamps). Counters above
`2^63 - 1` and origins outside `[-2^63, 2^63 - 1]` are rejected when a snapshot is
serialized, decoded or restored. Live reframing still accepts any bigint origin;
only a snapshot of such a state fails explicitly. Versions,
configuration, format, counter relationships and pending payload length are
validated before restoring the FIFO allocation. Packed/planar u8/s16/s32/flt/dbl
formats retain exact payload bits. Unsigned-byte padding remains128. State copies
and emitted buffers do not alias future mutable FIFO storage.

The binary codec uses a four-byte little-endian JSON header length, a bounded
UTF-8 header (16 KiB maximum) and compact plane payload. The decoder is strict
and canonical: it accepts only the exact header bytes
`serializeAudioReframeCheckpoint` produces, so re-encoding a decoded snapshot
reproduces its input. Unknown or missing fields (including inside `format`),
whitespace, key reordering, string escapes, alternate number spellings,
duplicate keys and a BOM are rejected; a BOM is no longer stripped. Version
policy: decoders accept exactly format version 1, any change to fields or
encoding requires a new version number, and other versions are rejected, never
migrated. `maxFrameBytes` bounds
input/output/FIFO allocations and snapshot payload, not total runtime heap or the
combined cost of simultaneously retained caller buffers. The component codec
checks structure; persist state with immutable version pins or a verified content
digest before trusting its bytes.

## Execution identity envelope

Core exports `ExecutionCheckpoint`, `serializeExecutionCheckpoint`,
`deserializeExecutionCheckpoint` and `validateExecutionCheckpoint`. The version1
envelope records job/WorkUnit identity, graph hash, pinned input fingerprint,
implementation version, optional component state references and a bigint
`lastCommittedPosition`. Restore requires the expected identity; mismatched job,
graph, input or implementation is rejected before component decoding.

The metadata codec defaults to16 KiB and accepts a configured limit up to64 KiB.
Positions are nonnegative canonical decimal integers (up to4096 decimal digits).
Relative component references are validated structurally. This envelope does not
fetch state, authenticate a caller, verify external object contents or atomically
commit media outputs. The caller must validate content/version pins and ensure
its checkpoint position corresponds to committed output.

## Verified scope

[Unit tests](../../tests/unit/reframe-checkpoint.test.ts) also check that only
the canonical version 1 encoding decodes (unknown, missing and nested extra
fields, whitespace, reordering, escapes, number re-spellings, duplicate keys, a
BOM and version 2 fail) and that snapshot counters and origins are bounded to
signed64: origins at both extremes hand off exactly, forged out-of-range values
fail, and a live state with an out-of-range origin keeps running but fails
explicitly when its snapshot is serialized or restored.

Actual local workerd acceptance processes the first four stereo s16p samples at
8 kHz, commits a three-sample frame and saves the one-sample FIFO remainder to R2.
After disposing the entire runtime, a new Worker restores the binary state and
continues. For both padded and unpadded tails, final bytes and PTS match an
uninterrupted run and the pinned Native FFmpeg `asetnsamples` output.

The fixture validates the envelope first, checks committed prefix size, verifies
a content-addressed state digest, then restores the component. Wrong identity,
tampered state, cancellation and insufficient allocation limits produce no
resumed output. The fixture's output/state writes are not a cross-object atomic
transaction. It is evidence for this component's transferable state, not a
production checkpoint coordinator. A separate [coordinated journal API](media-checkpoint-journal.md)
now publishes FIFO state and raw output chunk references atomically in SQLite.

Whole-command job/Workflow runners still replay commands. Component continuation
at this FIFO boundary is driven by the [checkpointed runner](media-checkpoint-runner.md)
and [checkpoint Workflow](media-checkpoint-workflow.md), and the FIFO is one stage
of the scoped [checkpointed audio pipeline](checkpointed-audio-pipeline.md)
together with the [resampler](resample-checkpoints.md), [apad](pad-checkpoints.md)
and [WAV mux](wav-mux-checkpoints.md) states. Codec/Wasm state, other muxers,
other filter queues and the rest of a general running graph still require their
own verified state codecs before general pipeline continuation is available.
