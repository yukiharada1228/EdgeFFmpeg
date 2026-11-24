# aderivative

`aderivative` outputs the first difference of each channel: `dst[n] = src[n] - prev`, then `prev = src[n]`. It is adapted from `libavfilter/af_aderivative.c` at commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8` (provenance in `packages/avfilter/NOTICE-ADERIVATIVE`). The descriptor is `packages/avfilter/src/audio/aderivative.ts`, registered with one line in `packages/avfilter/src/audio/registry.ts`.

## Syntax

| Token | Result |
|---|---|
| `aderivative` | accepted |
| `aderivative=enable=…` | `aderivative timeline enable is not implemented`. Native accepts it, and its timeline path resets the previous sample to silence. |
| `aderivative=` | `Unsupported aderivative option: `. Native accepts the empty argument. |
| `aderivative=<anything else>` | `Unsupported aderivative option: <text>`. Native rejects `aderivative=1` and `aderivative=foo=1` too. |

Every refusal is an `AudioFilterError` raised while the chain compiles, so on the CLI it fails before any output is opened. Runtime commands are not implemented, like for every other audio filter.

## Behaviour

- **Stream step.** One previous value per channel starts at 0 and carries across frames, so frame splits (for example `asetnsamples=7,aderivative`) give the same samples as one frame.
- **Arithmetic.** `s16p` and `s32p` differences wrap in two's complement, like the `int16_t`/`int32_t` stores in C. `fltp` differences are rounded once with `Math.fround`, which is the correctly rounded float subtraction. `dblp` uses plain double subtraction. There is no multiply, so FMA contraction cannot change results.
- **Non-finite input.** A NaN or infinite `flt`/`dbl` input sample is refused with `Non-finite aderivative input is not yet supported`, because native's NaN payloads are not reproduced.
- **Counts and packets.** Sample counts, frame sizes, packet boundaries and timestamps are unchanged.
- **Capabilities.** `generatesOutput: false`, `reframes: true` (implied for a stream step), `allocatesFrames: true`, `formatConstraint`, `rateConversion` and `timeSelection` false, no `flacInput`. There is no constraint: every channel count, layout and rate runs.
- **Reservation.** `reserve()` declares one output frame and `stateBytes = channels × working width`. The working width is 2 bytes for u8 and s16 input, 4 for s32 and flt, and 8 for dbl.

## Sample-format negotiation

`formats()` returns the native list `['s16p','fltp','s32p','dblp']` (`FILTER_SAMPLEFMTS`). The chain's native negotiation model picks the format. On its own:

| Input | Working format |
|---|---|
| u8, u8p | s16p |
| s16, s16p | s16p |
| s32, s32p | s32p |
| flt, fltp | fltp |
| dbl, dblp | dblp |

Neighbouring lists merge as they do natively: `aderivative,aformat=s16p` on float input works in `s16p`, `aderivative,volume=0.5` in `fltp`, and `aderivative,volume=0.5:precision=fixed` on float input in `s32p`. The differential test compares these with native byte for byte. Merges the model cannot reproduce are refused before output with `aderivative with <input> input requires unimplemented format negotiation`. One example is fixed volume before it on float or u8 input, where native merges `{s16p,s32p}`.

## Unsupported

- Options, `enable` and runtime commands (above).
- Automatic sample-rate conversion: `aderivative with sample rate conversion is not implemented` (native list, so `rateConversion` is derived false).
- FLAC input: refused before decoding with `FLAC input to aderivative requires additional Native evidence`. No FLAC evidence exists.
- Non-finite floating input.
- `aintegral`, which is defined in the same upstream file.

## Evidence

The native reference is `.build/reference/ffmpeg` (FFmpeg 9.0.2, Linux x86_64, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`).

`tests/differential/aderivative.test.ts` generates its inputs in the test. Integer inputs mix every byte pattern with alternating full-scale extremes that force wrap. Float inputs stay finite in [-1, 1] and include -0 and ±1 steps. Each input has 20000 samples at 8000 Hz, so the stream is split into several frames. Float-to-integer output uses `-cpuflags 0` and runs only on Linux x64. The test makes 534 byte comparisons and checks 8 refusals:

- 108 framecrc comparisons: u8/s16/s32/f32/f64 sources, 1–3 channels, output in the native codec and in s16, with the chains `aderivative`, `asetnsamples=7,aderivative`, `aderivative,apad=pad_len=5` and `aderivative,aderivative`;
- 72 file comparisons: WAV and raw output from WAV and raw stereo input, in the native codec and in s16;
- 192 framecrc comparisons with output `-ss`, `-t`, `-ss -t`, `-ss -to`, `-frames:a` and a sub-sample `-t` (u8/s16/s32/f64 sources, mono and stereo, three chains), each of which filters the whole input;
- 162 framecrc comparisons of neighbour merges: `aformat` pins and volume (float, fixed) before and after it;
- native's exit status for 2 refusals native shares (`aderivative=1`, `aderivative=foo=1`) and 6 runs native accepts but EdgeFFmpeg refuses before output (empty argument, two `enable` forms, `-ar 16000`, fixed volume before it on float input, with and without a following `anull`).

`tests/unit/aderivative.test.ts` covers:

- syntax with exact messages;
- capabilities, `planSamples`, `packetSections` (alone and composed), rate and `apply()` refusals;
- `reservations` and `plannedReservations` for every input format and 1–3 channels;
- `negotiatedSampleFormats` for every input format under five output hints, `requiresScalarRounding`, and the merge refusals;
- output against a direct transcription of the C loop for s16/s32/flt/dbl, 1–3 channels and four frame splits, including full-scale wrap;
- conversion from u8 and packed input;
- ownership (inputs unchanged, no shared buffers), the allocation limit, non-finite refusal, and cancellation before and between frames.

## Proposed test contracts

| File | Test | Scope |
|---|---|---|
| `tests/differential/aderivative.test.ts` | matches native framecrc across source formats, channel counts, frame splits and padding in the native format and s16 | CLI framecrc |
| `tests/differential/aderivative.test.ts` | writes native-identical WAV and raw PCM from WAV and raw inputs | CLI WAV/raw bytes |
| `tests/differential/aderivative.test.ts` | filters the whole input before output -ss, -t, -to and -frames:a, as native does | CLI output time selection |
| `tests/differential/aderivative.test.ts` | matches native where neighbouring format lists merge with its own, across source formats | CLI negotiation |
| `tests/differential/aderivative.test.ts` | fails explicitly before output for options, timeline enable and neighbour merges native would run in another format | CLI refusals |
| `tests/unit/aderivative.test.ts` | matches a C transcription with two's-complement wrap and float32 rounding, independent of frame splits | stream arithmetic |
| `tests/unit/aderivative.test.ts` | negotiates native picks: u8 and s16 to s16p, s32 to s32p, flt to fltp and dbl to dblp, with a single rounding only from float input | negotiation |
