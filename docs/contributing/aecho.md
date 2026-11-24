# aecho multi-tap echo

The bounded linear audio chain accepts `aecho`, adapted from `libavfilter/af_aecho.c` at the pinned FFmpeg 9.0.2 commit (provenance in `packages/avfilter/NOTICE-AECHO`). It is a registry descriptor, `packages/avfilter/src/audio/aecho.ts`, a stream step with an end-of-input tail. This is partial aecho compatibility for the raw PCM, WAV and framecrc CLI paths. FLAC input is refused before decoding (`FLAC input to aecho requires additional Native evidence`).

```sh
npm run ffmpeg -- --root ./media -- -i /input.wav -af 'aecho=0.8:0.9:1000|1800:0.3|0.25' /echo.wav
```

## Syntax

`aecho[=in_gain:out_gain:delays:decays]`. The options can be given by position in that order, or by name. A named option can follow positional ones, and the last value given wins. The defaults are `0.6:0.3:1000:0.5`.

| Option | Form | Native rule |
|---|---|---|
| `in_gain`, `out_gain` | plain decimal (`0.8`, `.25`, `1`) | double in [0, 1], stored as float32 |
| `delays` | `\|` list of plain decimals, in milliseconds | float32 (`sscanf("%f")`), each in (0, 90000] |
| `decays` | `\|` list of plain decimals | float32, each in (0, 1] |

Empty `|` fields are skipped, as `av_strtok` does. The lists must have the same non-zero length.

Explicit failures. Each is an `AudioFilterError` raised while compiling, so nothing is opened:

- **Native rejects these too:** lists of different lengths (`Number of aecho delays 2 differs from number of decays 1`) and empty lists (`aecho requires at least one delay and decay`). Also zero or out-of-range delays and decays (`aecho delay[0] is out of allowed range (0, 90000]`), gains outside [0, 1] (`aecho in_gain is out of range [0, 1]`), an extra positional value, a positional value after a named one (`Invalid aecho option`), unknown options (`Unsupported aecho option: foo`) and `inf`/`nan` delays.
- **Native accepts these, but they are unimplemented:**
  - gain expressions and other non-decimal gains (`1/2`, `.5e0`, `PI`: `Only decimal aecho in_gain values are implemented`);
  - list values with signs, exponents, hexadecimal or trailing text (`+10`, `1e1`, `0x10`, `10ms`, `abc`: `Unsupported aecho delays value: <token>`);
  - escaped separators;
  - decimals that fall exactly on a float32 rounding midpoint in double precision (`0.50000002980232238769531250`). Native rounds these directly to float32, which this implementation does not reproduce.

  Native skips a list token it cannot scan, such as `abc`. This implementation refuses it instead.
- **Rate-dependent:** if every delay truncates to zero samples at the stream rate (`delays=0.05` at 8000 Hz), native fails while configuring the output pad. The chain's `constraint()` refuses it before output with `aecho has nothing to echo: missing delay samples`. A tap count above `INT_MAX` (undefined behaviour in C) fails with `aecho delay exceeds int samples`.
- **Automatic sample-rate conversion** around aecho (`-ar` that differs from the input) fails with `aecho with sample rate conversion is not implemented`. Native resamples in this case.
- aecho has no runtime commands. Timeline `enable` is not part of the chain syntax.

## Negotiation

`formats()` returns the native list `['s16p','s32p','fltp','dblp']`. The registry's native negotiation model picks the working format (`-v debug` on the pinned build):

| Input | u8 | s16 | s32 | flt | dbl |
|---|---|---|---|---|---|
| aecho works in | s16p | s16p | s32p | fltp | dblp |

Neighbouring lists merge as they do natively: for example, `aecho,volume=0.5` runs aecho in `fltp`. The chain refuses negotiations it cannot reproduce before output (see [audio filter registry](audio-filter-registry.md#sample-format-negotiation)).

## Arithmetic

- **Tap lengths.** `samples[i] = (int)(fround(delay * fround(rate)) / 1000.0)`, truncated toward zero, and `max_samples` is the largest of them. For example, 7.3 ms at 44100 Hz is 321 samples. A tap can be zero samples long (0.1 ms at 8000 Hz) while `max_samples` is positive. Native then reads the ring slot that is about to be overwritten, the input from `max_samples` ago, and so does this implementation.
- **Per sample and channel:** `out = in * in_gain` in double. Then, for each tap, `out += dbuf[ix] * decay[j]`. That product is a float32 product for s16, s32 (the int is converted to float32 first) and flt, and a double product for dbl. Finally `out *= out_gain`, `av_clipd` to [-1, 1] (float) or the integer range, then C conversion: float32 rounding, or truncation toward zero for integers. The ring stores the input sample in its own type. Every channel starts at the shared `delay_index`.
- The JavaScript evaluates each step in the same order without fused multiply-add. The comparisons below ran on the pinned linux/x64 build. The wave selection notes macOS arm64 matching only 8931 of 10320 samples (FMA contraction), so the byte-exact differential tests are gated to linux/x64.

## Frames, tail and timestamps

Each input frame produces one owned output frame of the same size in the working format. Inputs are never mutated. After end of input, `max_samples` samples of tail are generated by feeding silence through the rings, in frames of `min(remaining, 2048)` samples. Their timestamps continue from the last input frame (`next_pts`). A configured empty input produces only the tail, starting at the configured timestamp. Output frame timestamps are emitted in `1/sample_rate` and must be sample-aligned.

`count()` adds `max_samples` with a `{samples: max_samples, span: 2048}` trailing packet run and a `min(max_samples, 2048)` buffer. `generatesOutput` and `reframes` are true. Output `-ss`/`-t`/`-to`/`-frames:a` therefore select from the filtered output, including the tail, as native does.

## Memory

`reserve()` declares one output frame plus `max_samples × channels × width` bytes of ring state, where the width belongs to the working format (2 for s16p, including u8 input; 4 for s32p and fltp; 8 for dblp). The PCM planner refuses a ring above `maxBufferBytes` with `resource-budget` before output is opened. For example, the default 1000 ms delay at 44100 Hz stereo needs 176400 bytes. The stream also refuses a ring above `maxFrameBytes` (`aecho delay buffer exceeds allocation limit`), checks its frame allocations, and observes `options.signal`.

## Evidence

`tests/differential/aecho.test.ts` runs `.build/reference/ffmpeg` at test time and compares the CLI output byte for byte (framecrc, WAV, raw PCM). The byte comparisons run on linux/x64 only. 1040 native comparisons:

- 612 framecrc cases: u8/s16/s32/f32/f64 sources, mono and stereo, 8000 and 44100 Hz, nine option sets, and the source codec plus s16/f32/f64 outputs. The option sets cover 1–3 taps; delays shorter than a frame, longer than a frame and longer than 2048 samples; a zero-sample tap; saturation; named, reordered and duplicated options; and the default 1000 ms delay.
- 36 framecrc cases on 24000-sample stereo inputs. They also check that native's packet total is the input plus `max_samples`, so no tail frame is emitted early.
- 336 framecrc cases with composed chains (asetnsamples before and after, apad before and after, volume, anull) under output `-t`/`-ss`/`-to`/`-frames:a` and input `-ss`/`-t`.
- 36 framecrc cases with configured empty input (u8/s16/f32), alone and with asetnsamples, under output `-t`/`-ss`/`-frames:a`.
- 20 WAV and raw files from raw and WAV inputs in all five formats.

It also checks 25 refusals against native's exit status and asserts that no output file is created: 14 forms native also rejects, 9 forms native accepts that remain unimplemented, the zero-sample `max_samples` case and rate conversion. A ring above the buffer budget fails with `resource-budget`.

`tests/unit/aecho.test.ts` covers the parser and its exact messages, tap index math and the rate constraint, negotiation for every input format, `planSamples`, `packetSections` and `outputSamples` with the tail, `plannedReservations` and `reservations`, and output against a direct transcription of the C loop. The transcription comparison runs in all four working formats with packed and planar input and four frame splits, and also checks ownership and timestamps. The unit tests also cover u8 widening, the configured empty-input tail, and the allocation, stable-format, timestamp and cancellation limits.

## Scoped test contracts

| File | Test | Scope |
|---|---|---|
| `tests/differential/aecho.test.ts` | `matches native framecrc across sources, channel counts, rates, tap lists and s16/f32/f64 outputs` | linux/x64 framecrc bytes |
| `tests/differential/aecho.test.ts` | `matches native on long multi-frame inputs, where the tail only follows the last input frame` | linux/x64 framecrc bytes, tail placement |
| `tests/differential/aecho.test.ts` | `matches native composed chains, output -t/-ss/-to/-frames:a and input time selection over the tail` | linux/x64 framecrc bytes, time selection |
| `tests/differential/aecho.test.ts` | `matches native output for configured empty input, where only the silent tail remains` | linux/x64 framecrc bytes |
| `tests/differential/aecho.test.ts` | `writes native-identical WAV and raw PCM files from WAV and raw inputs` | linux/x64 file bytes |
| `tests/differential/aecho.test.ts` | `fails explicitly before output where native fails, and for accepted forms that remain unimplemented` | refusals with native status |
| `tests/differential/aecho.test.ts` | `refuses a delay ring above the buffer budget before opening output` | resource budget |
| `tests/unit/aecho.test.ts` | all six tests | parser, planning, negotiation, transcription, limits |

## Unsupported

- Option expressions, exponents, signs, hexadecimal, trailing text, escaping and float32 midpoint decimals (refused).
- FLAC input (refused before decoding), automatic sample-rate conversion (refused) and runtime commands (none exist natively).
- AIFF and AU output share the PCM path but have no native comparison here. There is no evidence for non-linux/x64 arithmetic.
