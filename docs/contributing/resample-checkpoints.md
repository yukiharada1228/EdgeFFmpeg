# Default resampler checkpoints

`createAudioResampleState(outputRate, options, checkpoint?)` from
`@edge-ffmpeg/swresample` exposes the default Kaiser FIR described in
[resampling](resampling.md) as an explicit state object. `resampleAudio` now runs
through it, so continuous and restored execution share one implementation. It
takes the same `AudioResampleOptions` (`maxFrameBytes`, `maxStateBytes`, optional
`sampleFormat` and `signal`). This is component state continuation (design 11.3
"Stateful Continuation"), analogous to the [audio FIFO](reframe-checkpoints.md)
and [apad](pad-checkpoints.md) checkpoints, not a replay of a whole command.

```ts
const options = {maxFrameBytes: 256, maxStateBytes: 131072, sampleFormat: 's16'} as const;
const state = createAudioResampleState(48000, options);
for (const output of state.push(inputFrame)) await commitFrame(output);
const bytes = serializeAudioResampleCheckpoint(state.checkpoint(), options);
state.dispose();

const resumed = createAudioResampleState(48000, options, deserializeAudioResampleCheckpoint(bytes, options));
for (const output of resumed.push(nextInputFrame)) await commitFrame(output);
for (const output of resumed.finish(1)) await commitFrame(output); // optional bounded EOF tail step
for (const output of resumed.finish()) await commitFrame(output);
resumed.dispose();
```

`push(frame)` returns a generator that consumes one whole input frame and yields
every output frame that becomes available. `finish(maxFrames?)` marks end of
input on its first call and drains the reflected tail, at most `maxFrames` output
frames per call; `state.finished` reports completion and `finish()` is idempotent
afterwards. `push()` after end of input is rejected. Snapshots, `push()` and
`finish()` are rejected while either iterator is suspended, so a snapshot always
lies between input-frame transitions or bounded tail steps. Abandoning an
iterator, malformed or discontinuous input, non-finite samples and cancellation
poison the state; completed old iterators cannot alter a newer transition's
busy/poison status. Disposal releases the coefficient bank, history ring and
pending output, after which every call fails explicitly. Input planes are only
read during `push()`; yielded frames and snapshots never alias state storage.

## Snapshot contents

The snapshot binds configuration and the resampling plan instead of carrying
coefficients:

- `outputRate` and the requested `sampleFormat` option (`null` when inferred).
- `plan`: input/output rate, channels, FIR precision (`s16`/`flt`/`dbl`), taps,
  phases and the interpolation flag. Restore recomputes the plan from the rates,
  channels and precision and rejects any difference (`plan mismatch`). The
  coefficient bank is rebuilt deterministically from those values; it is never
  serialized.
- `format`: the packed or planar frame format, channel layout and output frame
  size (`floor(maxFrameBytes / (channels * width))` samples).
- The input sample PTS origin (or `null`), received input samples, emitted output
  samples, the end-of-input flag and terminal status. Counters and origin are
  canonical decimal strings, exact as bigints within the signed64 range native
  FFmpeg uses for sample counts and timestamps.
- Payload: the retained history window, then the pending partial output frame.

Only the history that any later output can read is stored: samples from
`max(0, min(floor(emitted * I / O) - center, received - taps - 1))` to `received`,
interleaved little-endian in FIR precision. This is at most `taps + 1` sample
frames, regardless of stream length. Stale ring slots, the output PTS origin, the
started flag, the pending count (`emitted mod frameSamples`) and the history start
are derived on restore rather than stored, so each logical state has exactly one
encoding. Pending output (fewer than one frame) is stored compacted per plane, so
restored output keeps identical frame boundaries, bytes and PTS.

There is no separate phase or position accumulator to store. The input position
is the exact rational `emitted * I / O`: its integer part selects the history
window, `(emitted * I mod O) * phases / O` selects the coefficient phase, and the
remainder of that division is the interpolation fraction above 1024 phases. All
three are recomputed from the `emitted` counter with exact bigint integers (the
fraction becomes floating point only where each output sample uses it), so a
restored state continues on exactly the same phases with no accumulated rounding.

## Validation and codec

The version 1 binary layout is a four-byte little-endian header length, exactly
that many bytes of canonical BOM-free UTF-8 JSON (16 KiB maximum), then the
history and pending payloads, whose lengths are implied by the counters. The
decoder is strict and canonical: it decodes only the exact bytes the serializer
produces, so `serialize(deserialize(x))` equals `x`. It rejects other versions and
kinds, unknown or missing fields at any level, whitespace, key reordering, string
escapes, alternate number spellings, duplicate keys, a BOM, invalid UTF-8,
truncation and trailing bytes. Other versions are rejected, never migrated: any
field or encoding change requires a new version number.

Counter relationships are checked exactly. A streaming state must have emitted
`resampledStreamingSampleCount(received)` samples. A bounded end-of-input state
stops only after a whole output frame, strictly between the streaming and final
counts. A finished state has emitted `resampledSampleCount(received)` and carries
no history or pending output. Unconfigured snapshots contain no samples, and
equal-rate bypass emits exactly what it receives. History and pending lengths must
match the counters, and floating history samples must be finite.

Counters above `2^63 - 1` and origins outside `[-2^63, 2^63 - 1]` are rejected as
`exceeds signed64`, even when they are otherwise consistent: decimal syntax and the
128-digit string cap alone used to admit such forged states. Live streaming is
unchanged and still accepts any bigint input origin. A state whose origin lies
outside signed64 cannot be snapshotted: `serializeAudioResampleCheckpoint` and
restore both fail explicitly. Output PTS are not bounded. Upsampling an in-range
origin near the limit yields exact bigint output PTS beyond signed64, where native
FFmpeg's intermediate rescale already overflows. Timestamp behavior that close to
the int64 range is not native-verified.

Before any payload is copied or coefficients are rebuilt, the decoder bounds total
input at `4 + 16 KiB + maxStateBytes + maxFrameBytes`. It rejects a plan whose
coefficient bank and history ring exceed `maxStateBytes`, and an output frame
larger than `maxFrameBytes`. Restore also requires the same output rate, requested
precision and output frame size as the snapshot, or it fails with
`configuration mismatch`. As with the other component codecs, structure is
validated, not authenticity. Finite sample bits can be altered undetectably, so
persist state with immutable version pins or a verified content digest, as the
workerd fixture does.

The [apad](pad-checkpoints.md) and audio FIFO decoders now apply the same exact
field sets and canonical re-encoding comparison to their JSON headers. Their
earlier lax acceptance of unknown keys, non-canonical JSON and (for the FIFO) a
leading BOM is rejected. Both also reject counters and origins outside signed64
in the same way.

## Verified scope

Unit tests cover eight rate pairs: 8000->44100, 44100->48000, 48000->8000,
44100->22050, 8000->16000, 44100->48001 and 48001->44100 (both interpolating above
1024 phases), and 16000->16000 bypass. Each runs with s16, flt and dbl, mono and
stereo, packed and planar, with 24-sample output frames and 14 irregular input
frames. Serialized state moves to a fresh object at every input-frame and every
one-frame EOF tail boundary, singly and chained. Output bytes, frame sizes, PTS and
ownership match uninterrupted `resampleAudio`, every snapshot re-encodes
byte-identically, and restored states snapshot identically. Short streams are
handed off at every boundary too: 8000->44100 s16, 44100->22050 dbl and
44100->48001 flt, stereo, in one-sample input frames and three-sample output
frames, at lengths around the shortest stream that produces output and around
`taps + 1`. These reach every pre-start count and empty, reflected-short and full
EOF tails. Further cases cover
unknown/negative origins, origins at both signed64 extremes, forged out-of-range
counters and origins, unconfigured/finished/short streams, aliasing, 37 corrupt
fields, canonical-encoding variants, truncation at every byte position, trailing
bytes, header-length tampering, allocation limits including a hostile
2147483647->1 plan, configuration mismatch, busy/poison/disposal and
cancellation.

A drift guard pins `resampleAudio` to the implementation it replaced. Before the
refactor, outputs were recorded as SHA-256 digests and frame counts for 11 rate
pairs (including both interpolating ratios and bypass). Each pair covers
s16/flt/dbl, packed/planar, mono/stereo and three PTS, frame-budget and chunking
variants. The unit test recomputes them from the current code. The digests cover
bytes, PTS, frame boundaries and each frame's own property names. An earlier
one-off comparison over 9216 cases, which also checked error messages, is not part
of the repository.

The guard depends on the V8 build's architecture. The dbl inputs and coefficient
banks take `Math.sin`/`Math.cos` results, whose last bits differ between arm64 and
x64, so the combined digests reproduce only on arm64, where they were recorded.
The tests are split three ways, and `compat/test-contracts.json` gates them:

- the 11 combined s16/flt/dbl tests run on darwin-arm64 only and are reported as
  not applicable elsewhere;
- 11 tests hash the s16 and flt rows alone. Their digests were recorded on
  darwin-arm64 from the run that reproduces every combined digest, so they are the
  pre-checkpoint s16/flt output. int16 and float32 rounding absorbs the
  architecture difference, and x64 V8 (Node 24.22.3) gives the same digests, so
  they run on every platform;
- 11 tests pin the dbl rows on x64 V8. These are regression pins recorded from the
  current implementation in the pinned linux/amd64 image, not pre-checkpoint
  evidence. The combined digests of that run equal the eleven GitHub Actions run
  45548679318 observed on x86_64. They run on linux-x64 only.

Edge's own dbl resampling output therefore depends on the host CPU through
`Math.sin`. Making the dbl coefficients host-independent is a separate decision.

Differential tests (pinned native build, `-cpuflags 0`) use a 464-sample fixture
split into 10 input frames. Each case is handed off at every input and EOF tail
boundary and once fully chained:

- Forced signed16 FIR (`-af aresample=<rate>:tsf=s16p`), byte for byte: six rate
  pairs including both interpolating ratios, mono/stereo and packed/planar (24
  fixtures).
- Default `-af aresample=<rate>`, byte for byte: eight float fixtures (8000->44100,
  44100->48000, 48000->8000, 8000->16000; mono/stereo) and ten signed16 fixtures
  through the default float FIR (8000->44100, 44100->48000, 48000->8000,
  44100->22050, 48001->44100; mono/stereo). This is identity for these recorded
  fixtures, not general float bit-exactness.
- Double (five rate pairs) and interpolating float (two pairs): handoff output is
  byte-identical to the uninterrupted run, and native agreement is only within the
  recorded 2e-12 / 1e-6 absolute tolerances.

Local workerd acceptance processes 400 stereo s16p samples in eight frames through
the forced signed16 profile for 44100->48000, 48000->8000, 44100->48001 and
8000->44100. Each is checkpointed mid-stream, after the last input frame and after
one EOF tail frame. These states include startup history without output, pending
partial output, a mid-tail end-of-input state and a finished state. Each is stored
in local R2 with an execution identity envelope and content-addressed digest. The
whole runtime is disposed and the stream resumes in a fresh one. Resumed PCM and
per-frame sample counts/PTS match an uninterrupted Worker run, and PCM matches the
pinned native output byte for byte. Cancellation, an insufficient state budget,
wrong identity and a tampered state blob produce no resumed output. The fixture's
output/state writes are not a cross-object atomic transaction.

The resampler state reaches the [coordinated journal](media-checkpoint-journal.md),
the [runner](media-checkpoint-runner.md) and the
[checkpoint Workflow](media-checkpoint-workflow.md) only as one stage of the scoped
[checkpointed audio pipeline](checkpointed-audio-pipeline.md), whose own evidence
is recorded there.

Not implemented or not verified: bit identity of double or interpolating float
output with native, checkpoints of the sample-format conversions around the FIR
(u8/s32 endpoints, rematrix), integration with the CLI `-ar` path or the
whole-command job/Workflow runners (which still replay commands), non-default
resampler options, compensation,
production Workers and canonical Linux reference builds. This does not establish
general aresample or FFmpeg compatibility.
