# Checkpointed audio conversion pipeline

`createAudioCheckpointPipeline(config, input)` from `@edge-ffmpeg/avformat`
chains the four checkpointable components into one continuation:

1. a ranged WAV read (`openWav` header, then `unitSamples` sample frames per unit),
2. the default resampler state ([resampler checkpoints](resample-checkpoints.md)),
3. one stage: the audio FIFO `asetnsamples` ([reframe checkpoints](reframe-checkpoints.md))
   or finite `apad` ([apad checkpoints](pad-checkpoints.md)),
4. the WAV mux state ([WAV mux checkpoints](wav-mux-checkpoints.md)).

It is the continuation of this pinned native command, one bounded unit at a time,
across Worker invocations:

```sh
ffmpeg -cpuflags 0 -i in.wav -af aresample=<outputRate>[:tsf=<precision>p],<stage> -c:a <codec> [-bitexact] out.wav
```

`<stage>` is `asetnsamples=n=<samples>:p=<0|1>` or `apad=<mode>=<limit>`. `tsf` is
needed only where native's default internal format differs from `precision`: with
a rate change it picks `fltp` for s16/f32 input and `dblp` for f64 input, so the
`s16` FIR is `aresample=<rate>:tsf=s16p`.

Without a rate change there is no FIR. Native's `swr_init` then has no resample,
rematrix or dither and takes `full_convert` (`libswresample/swresample.c`): the
input converts straight to the output format and `tsf` is ignored. The pipeline
does the same. Its resampler state then passes frames through in the output format,
and `precision` is validated but unused. For example, f32 input with `precision:
's16'` and f32 output returns the input samples unchanged.

The returned object is structurally a runtime `MediaCheckpointComponent`
(`create`, `restore`, `process`, `serialize`, `verify`, `dispose`), so the
[runner](media-checkpoint-runner.md) and the [checkpoint Workflow](media-checkpoint-workflow.md)
drive it without either side knowing the other. Media semantics stay in the media
layer: `@edge-ffmpeg/runtime-cloudflare` carries none (design section 9.1), and
`@edge-ffmpeg/avformat` has no runtime dependency. This is design 11.3 "Stateful
Continuation", feeding Phase 6 "Output Finalization" through 10.4 option 3
(assembly at final commit). Design context: sections 9.1, 9.3, 10.4 and 11.1-11.5
of the [detailed design](../architecture/detailed-development-design.md).

## Use in a Workflow

The [workerd fixture](../../tests/workers/audio-checkpoint-pipeline-fixture.ts)
is the runnable example. The spec carries the pipeline configuration as JSON; the
Worker registers the code.

```ts
import {audioCheckpointPipelinePatches,createAudioCheckpointPipeline} from '@edge-ffmpeg/avformat';
const pipeline = {
  outputRate: 48000, precision: 's16', codec: 'pcm_s16le', bitexact: false,
  stage: {filter: 'asetnsamples', samples: 64, pad: true},
  // or {filter: 'apad', mode: 'pad_len'|'whole_len'|'pad_dur'|'whole_dur', limit: '77', packetSamples: 4096, packetsPerUnit: 2}
  unitSamples: 40,
  limits: {maxFrameBytes: 512, maxStateBytes: 1048576, maxReadBytes: 1024, maxUnitBytes: 16384, maxUnits: 256},
};
const registry = new Map([['audio-pipeline', {implementationVersion: 'audio-checkpoint-pipeline-v1',
  bind: async ({spec, bucket}) => {
    const input = pinnedReadHandle(bucket, spec.inputs[0]);
    await planned(spec, spec.config.pipeline, input); // inspect, then compare with the journal limits
    return {
      component: createAudioCheckpointPipeline(spec.config.pipeline, input),
      filesystem: outputFiles(bucket),
      patches: ({state, bytes}) => audioCheckpointPipelinePatches(state, bytes, spec.config.pipeline),
    };
  }}]]);
export class AudioPipelineWorkflow extends MediaCheckpointWorkflow { protected components() { return registry; } }
```

`input` is a core `ReadHandle`. The fixture's handle reads only through the spec's
pinned ETag and version and refuses any read longer than `maxReadBytes`, so a
whole-object read cannot happen.

`inspectAudioCheckpointPipeline(config, input)` reads only the header and returns
the static plan without allocating any child state: `units`, the per-unit output
bound `unitBytes`, a bound on every serialized state `stateBytes`, and the exact
output length. The pipeline does not know the journal. The fixture's `planned`
binding step therefore compares the plan with the journal's limits: at most 256
units (the revision budget), and `unitBytes` and `stateBytes` within the policy's
`maxObjectBytes`. It also rethrows the pipeline's own rejections
(`AudioCheckpointPipelineError`, `WavError`, `AudioConversionError`) as `RangeError`.
Because the binding runs `planned` in the validation step, which has no retries,
a tagged or over-budget input ends the instance there, before any unit step; the
workerd test checks that no checkpoint or output object exists afterwards. The
validation step fails on any error type, so the mapping matters only when the
same check runs again in a unit step's binding: there the Workflow treats
`TypeError` and `RangeError` as deterministic and retries every other error up to
`maxRetries` times. Pipeline refusals raised later by `restore` or `process`, and
read failures from the pinned handle (a changed object or a short read; an
out-of-range request is a `RangeError`), stay plain errors and are retried.
`stateBytes` is loose: each child codec's JSON header cap (16 KiB, 1 KiB for the
WAV mux) plus the resampler history, its pending frame and the FIFO remainder.

## One unit

`process(state, position, signal)` requires `position` to equal the state's own
counters, then:

- The first unit emits the WAV header with native's pre-trailer placeholders.
- While input remains it reads `min(unitSamples, remaining)` sample frames with
  ranged reads, decodes them (`pcm_s16le`, `pcm_f32le` or `pcm_f64le`), converts
  them to the FIR precision (without a rate change, straight to the output format),
  pushes them through the resampler, converts its frames to the output sample
  format and feeds the stage, then encodes and writes each stage frame to the mux.
  `inputPosition` advances by the frames read.
- The unit that reads the last sample drains the resampler's reflected tail and
  finishes the stage. The FIFO finishes at once (padding the last frame when
  `pad` is true). apad emits at most `packetsPerUnit` silence packets per unit, so
  a long pad drains over later units that advance only the output.
- The WAV trailer (`mux.finish()`, the pad byte for odd data) comes with the unit
  that finishes the stage, and that unit is terminal.

apad is configured with the negotiated output format, so it pads even when the
resampler emitted no sample (very short inputs), as native and the CLI's
configured input do. Output frame boundaries do not affect WAV bytes. The
resampler emits frames of `floor(maxFrameBytes / (channels * widest sample
width))` samples and holds a partial frame as pending state, so smaller frames
make output reach the mux every few units instead of at the end.

Abort is observed between and inside stages (through each child's signal and the
ranged reads). Any failure, including abort, poisons the in-memory state:
`verify` returns false and `serialize` throws, and the runner restores from the
last committed revision.

## Configuration and static limits

`validateAudioCheckpointPipelineConfig` returns a frozen canonical copy and
rejects unknown or missing keys at every level. When the input header is read
(`create`, `restore`, `inspectAudioCheckpointPipeline`), and before any child
state, coefficient bank or frame is allocated, the pipeline rejects explicitly:

- an input codec other than `pcm_s16le`, `pcm_f32le` or `pcm_f64le`, an output
  codec outside the same set, and a precision other than `s16`, `flt` or `dbl`
- an empty input, and a channel count with neither an input mask nor a default
  layout (the output mask is the input's, else the default layout's, as in the CLI)
- input chunks that native may carry into the output, rejected conservatively.
  `openWav` skips every chunk but `fmt ` and `data`, while native's WAV demuxer
  turns LIST/INFO entries, `bext` (description, originator, date) and ID3 into
  tags, and `-i in.wav` copies the tags the WAV muxer knows into the output's INFO
  list, with or without `-bitexact`. The differential test verifies this only for
  a title (native output carries `INAM`; the artist tag written with it is not
  checked as `IART`) and a `bext` description (carried as `ICMT`). The pipeline scans the chunk headers
  itself, in `maxReadBytes` slices without touching sample data, and rejects:
  - `LIST`/`list` chunks other than an `INFO` list whose entries are all `ISFT`
  - malformed INFO lists
  - `bext`, `ID3 `, `id3 `, `cue ` (chapters), `SMV0` (a video stream) and `XMA2`.
    The `XMA2` rejection is in the code but has no test.
  - bytes after the RIFF chunk, which native also parses

  Not every rejected input would change native's output. A review probe (not a
  test) found native output unchanged for an INFO list holding only an unknown
  key (`IXYZ`), for a `cue ` chunk and for a `LIST/adtl` list, because the WAV
  muxer writes only known INFO keys and no chapters. Those inputs are unsupported,
  not carried. The rejection messages therefore state only that the pipeline does
  not carry input metadata or chunks into the output, without claiming what
  native does with them.

  An `ISFT`-only list is accepted because the muxer always replaces or drops
  `encoder` (`libavformat/mux.c`). Native's own non-bitexact WAVs carry exactly
  that list. Native skips every other chunk (`JUNK`, `PEAK`, and `fact` for these
  PCM codecs), and so does the pipeline. Only the `fact` case is native-compared:
  the native-written float inputs of the differential test carry one. `JUNK` and
  `PEAK` acceptance is unit-tested against the pipeline's own untagged output only.
- `unitSamples` frames that do not fit `maxFrameBytes` at the widest of the input,
  working (FIR, or output without a rate change) and output widths, or
  `maxReadBytes` at the input block size
- a resampler plan above `maxStateBytes`, or an `asetnsamples` frame or the largest
  apad packet above `maxFrameBytes`
- an output that needs RF64 (computed from the exact output sample count)
- more than `maxUnits` units (input units plus apad drain units)
- a per-unit output bound above `maxUnitBytes`. The bound is the header, plus
  `ceil((unitSamples + taps + 1) * outputRate / inputRate)` resampled samples plus
  one pending frame, plus `2 * samples` for the FIFO or `packetsPerUnit *
  packetSamples` for apad, plus the pad byte. A unit that would exceed it at
  runtime fails before its output is assembled. No tested case reaches that check.

Anything other than exactly one `asetnsamples` or `apad` stage is rejected.

## Snapshot codec and verify

`serializeAudioCheckpointPipeline(snapshot, config)` writes version 1: a
four-byte little-endian header length, that many bytes of canonical BOM-free
UTF-8 JSON `{version, kind, config, input, parts}`, then the resampler, stage and
WAV mux snapshots in their own canonical codecs. `parts` holds their byte
lengths. `input` binds the parsed header (codec, channels, rate, effective mask,
data offset, sample count). `deserializeAudioCheckpointPipeline(bytes, config)`
decodes only those exact bytes: whitespace, key order, escapes, unknown, missing
or extra fields, wrong part lengths, truncation and trailing bytes all fail, and
each part passes its own strict decoder. Limits come from the caller's
configuration, never from the snapshot, and bound the input length before parsing;
a snapshot for any other configuration is a `configuration mismatch`. Other
versions are rejected, never migrated: any change needs a new version number.

Both directions, and `verify`, check that the child counters chain:

- the resampler's received count is the input position, and its format, plan,
  frame size and origin match the configuration and input
- resampler emitted minus its pending frame equals the stage's received count
- the stage's output (FIFO emitted, or apad received plus padded) equals the mux's
  sample count, and the mux format, profile and `bitexact` match
- the phase is one the pipeline produces: fresh (nothing read, mux not started),
  streaming (input left, nothing at end of input), apad draining (input and
  resampler done, apad not finished, mux open) or finished (all done)

`verify(state, position)` additionally requires the input position to equal the
resampler's received count, the output position to equal the mux's byte count,
and revision 0 exactly when the mux has not started. `restore` re-reads the input
header and rescans its chunks. It rejects any difference from the snapshot's
`input`, and any tag chunk, even one added after the data. The resampler part's
format is the working format: `precision`, or the output format without a rate
change. As with the child
codecs, structure is checked, not authenticity: persist the state through the
journal's pinned, digest-verified objects.

A single snapshot cannot always tell where it stands: while the resampler's whole
output is still one pending frame, two streaming resampler parts chain
identically, and only the journal position (`verify`) tells them apart. The unit
tests cover that case.

## Final assembly

`audioCheckpointPipelinePatches(state, bytes, config)` strictly decodes the
terminal committed state, requires a finished mux whose byte count equals the
journal's output length, and returns `wavMuxPatches` (RIFF size, `fact` count for
float, data size). Pass it as the finalize `patches` callback, which receives the
pinned terminal state; see [final assembly with patches](wav-mux-checkpoints.md#final-assembly-with-patches).

## Workflow driver fix: replay-stable busy sleeps

The workerd test found a defect in the [Workflow driver](media-checkpoint-workflow.md):
after a full runtime restart, the local engine replays `run()`, and a busy sleep
that had already completed was replayed through `step.sleepUntil` with its
original timestamp. The local engine keys `sleepUntil` by the duration from the
current clock and rejects a timestamp in the past, so the instance ended with
`You can't sleep until a time in the past`. The busy step result now also
persists `sleepMs` (`wakeAt - now`, computed inside the step) and the driver calls
`step.sleep('busy-<n>', sleepMs)`, so a replay passes the same name and duration.
`MediaCheckpointWorkflowStep` declares `sleep` instead of `sleepUntil`. The
existing driver unit and workerd tests pass unchanged apart from the unit test's
fake engine, which implements `sleep`. Production Workflows replay behaviour was
not exercised.

## Verified evidence

- [Unit](../../tests/unit/audio-checkpoint-pipeline.test.ts), 8 tests:
  - configuration canonicalization and rejection
  - every static limit, rejected by `inspect` and `create` without reading any
    sample data
  - restore into a fresh component at every unit boundary in 408 cases drawn
    from 4 rate pairs (including 44100->48001 and 16000->16000), 1 and 3 channels, 6
    codec/precision profiles, 5 stages and 1, 20 or 173 samples (every
    combination at 173 samples, a third of the others). Output and snapshots are
    identical to the uninterrupted run, every snapshot re-encodes identically,
    and the patched output equals an independent finite composition
    (`resampleAudio`, `reframeAudio`/`padAudio`, `muxWav`; without a rate change
    it also converts straight to the output format). Unit count, output length,
    the per-unit bound and the state bound match the static plan, and the
    unpatched stream differs only in the patched size fields.
  - without a rate change, six profiles whose precision is narrower than the input
    or output: the data equals a direct conversion of the input, and the input
    samples themselves when the input and output formats match
  - tag and chunk handling:
    - 14 inputs rejected by `inspect` and `create` without reading sample data,
      and a restore refused once tags are appended after the data
    - `ISFT`-only lists (before and after the data), `JUNK`/`PEAK` and `fact`
      accepted with output identical to the untagged input
    - chunk headers read in 3-byte slices
  - non-canonical, inconsistent, truncated, swapped-child and phase-violating
    snapshots, and restore against a different input header
  - verify against wrong positions, abort before and inside a unit, poisoning
    and disposal
  - patch derivation from the terminal state only
- [Differential](../../tests/differential/audio-checkpoint-pipeline.test.ts)
  (pinned native build, sha256 `1b86106f...ab92`, `-cpuflags 0`), 4 tests:
  - Byte for byte with native after a restore at every unit boundary, 720 cases.
    Inputs are written by native with `-bitexact`.
    - The s16 FIR (`tsf=s16p`, s16 or f32 input, s16 output) on 6 rate-changing
      pairs: 8000->11025, 44100->48000, 48000->8000, 22050->44100, and the
      interpolating 44100->48001 and 48001->44100.
    - The float FIR for s16->s16 and f32->f32 on the 4 non-interpolating pairs.
    - Without a rate change (8000->8000 and 44100->44100, native given
      `tsf=<precision>p`): all nine input/output format pairs in 10 profiles,
      mostly with a precision narrower than the input or output.
    - 1, 2 and 3 channels; `asetnsamples` with and without padding and all four
      apad modes; with and without `-bitexact`.
    - The sample count (1, 2, 33, 120, 173, 250, 301), unit size (4, 7, 13, 29,
      64), frame size and `-bitexact` vary independently of the stage. The test
      asserts that every stage met every value, including single-sample apad
      inputs where the resampler emits nothing.
    - Tight frames (at least 40 samples, at least one unit) make output reach the
      FIFO, apad and mux mid-stream. 4096-byte frames often keep a short input's
      whole resampled output pending until EOF.
  - Restore at every single unit boundary, and fully chained, for three
    tight-frame cases: s16 FIR stereo 44100->48000 `asetnsamples=n=33:p=1`, mono
    48000->8000 apad with `-bitexact`, and float 3-channel 8000->11025
    `asetnsamples=n=7:p=0`. The test asserts that these boundaries include
    states with a pending resampler frame, samples already in the mux, and a
    partial FIFO frame or apad mid-stream.
  - Tolerance only (restore output still byte-identical to the uninterrupted
    run): the double FIR (2e-12), the interpolating float FIR (1e-6 for f32,
    1 LSB for s16) and s16 input with float FIR into f32 output (1e-6), on the
    rate-changing pairs. 288 cases.
  - Tags:
    - Native's non-bitexact input, with its LIST/INFO `ISFT`: the pipeline
      output equals native's, with and without `-bitexact`.
    - Native inputs with `-metadata title/artist`, or a `bext` description:
      native's output carries `INAM`/`ICMT`, and the pipeline rejects the input
      instead of dropping them.

  The float FIR byte identity holds only for these recorded fixtures, not as
  general float bit-exactness (as for the [resampler](resample-checkpoints.md#verified-scope)).
  Outside them, treat float precision as tolerance-only. For example, f32 mono
  11025->8000 `asetnsamples=n=7:p=1` with `-bitexact` matches native with 301
  samples, but with 200 samples one output sample differs by 5.96e-8. That was
  observed in a review probe, not a test.
- [Workerd](../../tests/workers/audio-checkpoint-pipeline.test.ts): real local
  Workflows (`MediaCheckpointWorkflow` unchanged), the SQLite coordinator and
  R2. The coordinator subclass `PipelineCheckpointCoordinator` only adds a fault:
  a planned commit is applied and its acknowledgement is then lost once. The main
  case, s16 FIR stereo 44100->48000 `asetnsamples=n=64:p=1` over 600 samples in 15
  units of 40, runs two units per Workflow step with a 250 ms delay per unit:
  1. A stale owner claims first and stages revision 1 under generation 1. The
     instance reports `busy` (the test asserts that at least one step did),
     sleeps out that lease and claims a newer generation (asserted to be at
     least 2). The stale owner's later commit is refused (`stale committer`).
  2. Revision 3 is applied but its acknowledgement is lost. The runner replays the
     identical descriptor, and the coordinator records that it already held it.
  3. Once at least five revisions have committed (and fewer than 15), the whole
     runtime is disposed and restarted, and the instance is reactivated with
     `pause()`/`resume()`. Completed steps, including the earlier busy sleep,
     replay, and the run finishes at 15 revisions. The pre-restart commits are unchanged, generations never
     decrease, no commit belongs to the stale owner, and every yielded step ran
     at most two units.
  4. The published WAV equals native byte for byte and the manifest's
     `outputSha256` is its SHA-256.
  5. Orphan collection deletes exactly the unreferenced attempt objects (at least
     the stale owner's two), and keeps every committed one.
  6. Afterwards every committed state still decodes strictly and chains to its
     journal positions, the unpatched stream differs from native only in the
     size fields, direct publication re-verifies the destination and returns the
     same manifest, finalizing to a new path gives native bytes, and a replay to
     the published path verifies it without changing its version.

  Five more cases run through the same Workflow, three units per step, without
  faults. Each publishes native bytes and leaves no orphan:
  - s16 FIR mono 48000->8000 apad `pad_len=77` with `-bitexact` (15 input + 3
    drain units)
  - float FIR f32 stereo 8000->11025 `asetnsamples=n=5:p=0`
  - s16 FIR 3-channel 44100->48001 `asetnsamples=n=7:p=1`
  - float FIR s16 stereo 22050->44100 apad `whole_len=900` with `-bitexact` (5
    input + 4 drain units)
  - f32 stereo 16000->16000 with `precision: 's16'`. Native ignores `tsf=s16p`,
    its data equals the input's, and so does the published WAV.

  Two refusals then run through the same Workflow. Each instance errors from the
  validation step, and no checkpoint or output object exists:
  - a native input tagged `-metadata title=Hello`
  - the main input with `unitSamples: 2`, which needs 300 units

## Not implemented

- Other input containers and codecs (u8, s24, s32, G.711, AIFF, AU, raw, FLAC),
  channel remix, `aformat`, more than one stage or a stage list, other filters,
  and non-default resampler options. Timestamps are zero-based sample positions.
- Input metadata. Inputs with LIST/INFO tags other than `ISFT`, `bext`, ID3, cue
  points or SMV video are rejected, never passed through or dropped. So are bytes
  after the RIFF chunk. Carrying tags into the output INFO list is not implemented.
- Native byte identity of the double FIR, the interpolating float FIR and other
  float fixtures; RF64; multiple outputs; parallel WorkUnits or splitting one
  stream across several WorkUnits.
- Lease renewal during a long unit: one unit, including its ranged reads and the
  resampler coefficient rebuild on restore, must fit `leaseMs`.
- Production Workflows, R2 and Durable Objects. Byte limits bound objects,
  frames and units, not total heap or CPU.

This is local workerd and Node evidence against the pinned native build. It does
not establish production deployment readiness or full FFmpeg compatibility.
