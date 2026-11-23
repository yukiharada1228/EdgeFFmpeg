# Finite apad checkpoints

`createAudioPadState(options, checkpoint?)` from `@edge-ffmpeg/avfilter` exposes
the finite apad state machine that `padAudio` and the CLI `apad` step now run
through; there is one implementation, not a parallel checkpoint copy. It takes
the same `AudioPadOptions` as `padAudio` (exactly one of `padSamples`,
`wholeSamples`, `padDurationMicros`, `wholeDurationMicros`, plus `packetSamples`,
`maxFrameBytes`, optional `emptyInput` and `signal`). This is component state
continuation, analogous to the [audio FIFO checkpoints](reframe-checkpoints.md),
not a replay of a whole command.

```ts
const options = {padSamples: 5n, packetSamples: 2, maxFrameBytes: 65536};
const state = createAudioPadState(options);
await commitFrame(state.push(inputFrame)); // the same borrowed frame, validated
for (const silence of state.finish(1)) await commitFrame(silence); // optional bounded tail step
const bytes = serializeAudioPadCheckpoint(state.checkpoint(), options);
state.dispose();

const resumed = createAudioPadState(options, deserializeAudioPadCheckpoint(bytes, options));
for (const silence of resumed.finish()) await commitFrame(silence);
resumed.dispose();
```

`push(frame)` validates the frame and returns it unchanged; apad never copies or
retains input payload, so there is no pending sample buffer to snapshot.
`finish(maxPackets?)` marks end of input on its first call and yields owned
silence packets of `min(packetSamples, remaining)` samples, at most `maxPackets`
per call. A long tail can therefore be checkpointed between packets, and
`state.finished` reports whether more silence remains. `finish()` is idempotent
after completion, and `push()` after end of input is rejected. Snapshots,
`push()` and reentrant `finish()` are rejected while a `finish()` iterator is
suspended; abandoning it (or a malformed/discontinuous `push()`) poisons the
state. Completed old iterators cannot alter a newer iterator's ownership.
Cancellation and disposal fail explicitly.

## Snapshot contents and validation

The snapshot records configuration (mode `pad_len`/`whole_len`/`pad_dur`/`whole_dur`,
the finite limit in samples or microseconds, `packetSamples` and the `emptyInput`
descriptor), the configured stream format, sample PTS origin, received input
samples, emitted padding samples, the end-of-input flag and terminal status.
Counters, limit, origin and descriptor PTS fields use canonical decimal strings,
exact as bigints within signed64, the range of native FFmpeg's sample counts and
timestamps. Duration modes are resolved to samples from the
stored format rate, exactly as during uninterrupted execution.

Restore requires identical configuration and checks the version and kind, mode,
signed64 limit, packet size, sample format/rate/channels, a received count of
zero only for an end-of-input state configured from a matching `emptyInput`
descriptor (including its derived origin), zero padding before end of input,
padding not exceeding the required total, packet-aligned progress for an
unfinished tail, consistency of `finished`, and that the largest remaining
silence packet fits `maxFrameBytes`. Fixed-count modes also recheck the initial
packet preflight. Rejected snapshots never yield output.

Every integer in a snapshot must fit signed64: the limit, counters and origin, and
the descriptor PTS value. Descriptor time-base terms must lie in `[1, 2^63 - 1]`.
Anything else is rejected as `exceeds signed64` or as an invalid descriptor. The
`emptyInput` descriptor is range-checked identically at configuration
(`createAudioPadState`/`padAudio`) and in snapshots. Its sample rate must be an
integer in `[1, 2^31 - 1]`, channels a positive safe integer and the sample format
a supported packed/planar format. A descriptor such as
rate `8000.5`, channels `-3`, format `bogus` or time base `-1/0` used to be accepted
and failed only in `finish()` (as a raw `RangeError` for a fractional rate). It now
fails at configuration and in decoding with `AudioPadError`. Sample alignment of
the descriptor PTS is still checked only when the empty input is actually padded.
Live padding still accepts any bigint frame origin. A state whose origin lies
outside signed64 cannot be snapshotted: serialization and restore fail explicitly.

The binary codec is a four-byte little-endian header length followed by exactly
that many bytes of BOM-free UTF-8 JSON (16 KiB maximum); there is no sample
payload and trailing bytes are rejected. The decoder is strict and canonical. It
accepts only the exact bytes `serializeAudioPadCheckpoint` produces for a valid
state, so re-encoding a decoded snapshot reproduces its input. It rejects unknown
or missing fields at any level (including `emptyInput`, its `pts` and `format`),
whitespace, key reordering, string escapes, alternate number spellings such as
`2.0` or `2e0`, duplicate keys and a BOM.

Version policy: decoders accept exactly format version 1. Any change to fields or
encoding requires a new version number. Snapshots with another version are
rejected, never migrated; earlier encodings with extra fields are no longer
accepted. In-memory checkpoint objects passed directly to `createAudioPadState`
are validated semantically; key strictness applies to the serialized form.

Structural validation cannot detect every semantically valid tamper (for example
an altered received count in fixed-count mode), so persist state with immutable
version pins or a verified content digest, as the workerd fixture does.

## Verified scope

Unit tests run ten packed/planar formats against six option sets (additional
count, minimum count above/below input, additional/minimum duration, zero) and
hand serialized state to a fresh object at every input-frame and every
silence-packet boundary, singly and chained; bytes, PTS, silence values and
buffer ownership match an uninterrupted `padAudio` run. Unknown and large
negative origins, configured empty input mid-tail, finished snapshots, corrupt
fields, configuration mismatch, allocation budget, truncated/extended/
non-canonical/BOM/invalid UTF-8 envelopes, busy/poison and disposal paths are
covered. Further tests cover out-of-range descriptors at configuration and in snapshots,
descriptor PTS and time-base terms at the signed64 extremes, origins at both
signed64 extremes, and forged out-of-range counters, origins and limits.
Canonical-encoding tests cover a counted snapshot and one carrying an
`emptyInput` descriptor. Both re-encode byte-identically and reject unknown,
missing and nested extra fields, whitespace, reordering, escapes, number
re-spellings, duplicate keys and version 2.

Local workerd acceptance processes 8 stereo s16p samples at 8 kHz in [3,3,2]
frames for five apad option sets, checkpoints between input frames and after the
first silence packet, saves state to R2 with an execution identity envelope and a
content-addressed digest, disposes the runtime and resumes in a fresh one. Raw
PCM and per-packet sample counts/PTS match an uninterrupted run and the pinned
native FFmpeg (`aformat=s16p,asetnsamples=n=3:p=0,apad=...,asetpts=PTS+123`)
output and framecrc. Cancellation, an insufficient budget, wrong identity and a
tampered state blob produce no resumed output. The fixture's output/state writes
are not a cross-object atomic transaction.

Finite apad reaches the [coordinated journal](media-checkpoint-journal.md), the
[runner](media-checkpoint-runner.md) and the
[checkpoint Workflow](media-checkpoint-workflow.md) only as the stage of the scoped
[checkpointed audio pipeline](checkpointed-audio-pipeline.md), whose own evidence
is recorded there.

Not implemented: infinite/default apad, timeline enable, integration with the
whole-command job/Workflow runners (which still replay commands), and checkpoints
for the rest of a running graph. This does not establish general apad or FFmpeg
compatibility.
