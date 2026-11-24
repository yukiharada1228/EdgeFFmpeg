# aintegral

`aintegral` is the per-channel running sum of FFmpeg `libavfilter/af_aderivative.c` (`ff_af_aintegral`, the `INTEGRAL(flt, float)` and `INTEGRAL(dbl, double)` loops), added through the [audio filter registry](audio-filter-registry.md) as `packages/avfilter/src/audio/aintegral.ts`. It is a separate module and shares no code with `aderivative`. Provenance: `packages/avfilter/NOTICE-AINTEGRAL`.

## Syntax

| Form | Result |
|---|---|
| `aintegral` | accepted |
| `aintegral=enable=…` (any position) | `AudioFilterError: aintegral timeline enable is not implemented` (native accepts it) |
| `aintegral=`, `aintegral=<anything else>` | `AudioFilterError: aintegral accepts no options` (native fails with `Option not found`, exit 8) |

The filter has no options. Native supports timeline `enable` (`AVFILTER_FLAG_SUPPORT_TIMELINE_INTERNAL`); that is refused. The chain has no runtime command interface, and native aintegral defines no `process_command`. On the CLI every refusal surfaces as `unsupported-filter` before any output is opened.

## Arithmetic

`stream()` keeps one accumulator per channel. It starts at 0 and carries across frames. For each sample, `dst = current + acc; acc = dst`:

- `fltp`: `Math.fround(current + acc)`. The operands are already float32 values, so the double add rounded once to float32 equals the C float add;
- `dblp`: a plain double add.

There are only additions, so FMA contraction cannot change the result. Input is converted to the negotiated format with `convertAudioFrame`. Output frames own their planes, inputs are never mutated, and pts is kept. A sample-format or channel-count change between frames fails with `aintegral input format changed between frames`.

## Negotiation

`formats()` returns the native `FILTER_SAMPLEFMTS` list `['fltp','dblp']`. The chain's native model then picks:

| Input | Working format |
|---|---|
| u8, s16, s32, flt (and planar forms) | fltp |
| dbl, dblp | dblp |

s32→fltp is lossy, as in the native swr conversion. Later conversions to the encoder are the chain's own. A float-to-integer conversion of a magnitude above 32768, which the integral of a DC input quickly reaches, fails with `Non-finite or out-of-range floating PCM requires an unimplemented runtime conversion profile`. Native clips instead.

## Capabilities and memory

`generatesOutput:false`, `reframes:true`, `allocatesFrames:true`, `formatConstraint:false`, `rateConversion:false` (forced false for a native list anyway), `timeSelection:false`, and no `flacInput`. Counts and packet boundaries are unchanged. `reserve()` declares one output frame and `channels × 8` state bytes. The accumulator is a `Float64Array` whichever format the step negotiates, so this is exact for the implementation.

## Unsupported

- Timeline `enable` and all options.
- FLAC input: refused before decoding (`FLAC input to aintegral requires additional Native evidence`). With `-t`, the timed refusal comes first.
- Automatic sample-rate conversion around the step (`aintegral with sample rate conversion is not implemented`).
- Integer output where the integral exceeds the scalar conversion bound (above). s16 output is only claimed for inputs whose integral stays within ±1, and only under `-cpuflags 0`.
- u8 and s32 encoder output are not compared with native.

## Evidence

`tests/unit/aintegral.test.ts` (7 tests) covers syntax refusals with exact messages; `negotiatedSampleFormats` for every input format; `requiresScalarRounding`; the rate and `apply()` refusals; `planSamples`, `packetSections`, `reservations` and `plannedReservations`; output against a direct transcription of the C loop for flt and dbl, mono to three channels, under five frame splits; s16→fltp input; ownership; the frame-allocation limit; the later s16 conversion refusal; format-change refusal; abort before and during the stream; and the FLAC refusals.

`tests/differential/aintegral.test.ts` runs `.build/reference/ffmpeg` (FFmpeg 9.0.2, Linux x86_64, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`) at test time. Inputs are generated in the test.

- **Float output (Linux x64 gated).** 800 exact byte comparisons: 5 sources (u8, s16le, s32le, f32le, f64le stereo) × 5 chains (`aintegral`, `asetnsamples=7,aintegral`, `aintegral,asetnsamples=11:p=0`, `asetnsamples=1,aintegral,asetnsamples=13`, `asetnsamples=16:p=0,aintegral,aintegral`) × (6 time scenarios × raw f32le/f64le + 2 scenarios × framecrc f32/f64) × 2 I/O budgets. The time scenarios are none, output `-ss`, `-t`, `-ss`+`-t`, `-ss`+`-frames:a`, and input `-ss`/`-t`.
- **s16 output (Linux x64 gated, `-cpuflags 0`).** 360 comparisons: low-amplitude, zero-mean sine/cosine input from every source format × the first four chains × 6 scenarios × s16le, framecrc and WAV.
- **Refusals.** `aintegral=foo=1` (native exit 8), `aintegral=enable=1` (native exit 0) and an out-of-range integral into s16 (native exit 0, clipped) all fail on our side, with the exact message and no output written.

## Proposed test contracts

| id | file | test title | scope |
|---|---|---|---|
| `filter.aintegral.float` | `tests/differential/aintegral.test.ts` | matches native aintegral f32 and f64 output for every source format, frame split and output time selection | f32/f64 output bytes and framecrc from five stereo source formats, five chains with asetnsamples splits, output -ss/-t/-frames:a and input trim; Linux x64 |
| `filter.aintegral.s16` | `tests/differential/aintegral.test.ts` | matches native aintegral s16 output with -cpuflags 0 from low-amplitude zero-mean input whose integral stays within one | s16le, framecrc and WAV output with -cpuflags 0 where the integral stays within ±1; Linux x64 |
| `filter.aintegral.refusals` | `tests/differential/aintegral.test.ts` | refuses aintegral options, timeline enable, and integer output beyond the scalar conversion bound before writing output | explicit CLI refusals against native status |
| `filter.aintegral.unit` | `tests/unit/aintegral.test.ts` | matches the C transcription across frames and frame splits for float and double | INTEGRAL loop transcription, accumulator carried across frames |
