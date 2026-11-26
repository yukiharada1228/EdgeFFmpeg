# biquad explicit-coefficient filter

The bounded linear audio chain accepts `biquad`, adapted from `libavfilter/af_biquads.c` (filter type `biquad` only) at the pinned FFmpeg 9.0.2 commit `946fcce0` (provenance in `packages/avfilter/NOTICE-BIQUAD`). The registry descriptor is `packages/avfilter/src/audio/biquad.ts`, a stream step with a per-channel 4-value cache. The six kernels and the coefficient preparation are in `packages/avfilter/src/audio/biquad-kernels.ts`, so the later biquad-family filters (equalizer, lowpass, highpass and so on) can import them unchanged. This is partial biquad compatibility for the raw PCM, WAV and framecrc CLI paths. FLAC input is refused before decoding (`FLAC input to biquad requires additional Native evidence`).

```sh
npm run ffmpeg -- --root ./media -- -i /input.wav -af 'biquad=a1=-1.143:a2=0.4128:b0=0.0675:b1=0.135:b2=0.0675:a=tdii' /lowpass.wav
```

## Syntax

`biquad=key=value:…`, or positional values in the `biquad_options` order `a0:a1:a2:b0:b1:b2:mix:channels:normalize:transform:precision:blocksize`. A named option may follow positional ones, and the last value given wins.

| Option | Accepted values | Default | Native rule |
|---|---|---|---|
| `a0`, `a1`, `a2`, `b0`, `b1`, `b2` | constant decimals (sign and exponent allowed) | `1`, `0`, `0`, `0`, `0`, `0` | double in [-2147483648, 2147483647] |
| `mix`, `m` | constant decimal | `1` | double in [0, 1] |
| `normalize`, `n` | `0`, `1`, `false`, `true` | `0` | bool |
| `transform`, `a` | `dii`, `tdi`, `tdii`, `latt`, `svf`, `zdf` or `1`–`6` | `di` (refused) | int 0–6 |
| `precision`, `r` | `auto`, `s16`, `s32`, `f32`, `f64` or `-1`–`3` | `auto` | int -1–3 |
| `channels`, `c` | `all` | `all` | channel layout string |
| `blocksize`, `b` | `0` | `0` | int 0–32768 |

A transform must be given: the default, direct form I, is refused.

### Refused forms

Every refusal is an `AudioFilterError` raised while compiling, so nothing is opened.

- **Native rejects these too:** coefficients outside the INT32 range (`biquad b0 is out of range [-2147483648, 2147483647]`), `mix` outside [0, 1] (`biquad mix is out of range [0, 1]`), `blocksize` above 32768 (`biquad blocksize is out of range [0, 32768]`), unknown transform or precision names and values (`Unsupported biquad transform: foo`, `Unsupported biquad precision: 4`), unknown options (`Unsupported biquad option: foo`), an extra positional value or a positional value after a named one (`Invalid biquad option`).
- **Native accepts these, but they are not implemented:**
  - `transform=di`, `transform=0`, and any biquad without `transform=`: `biquad transform di depends on native frame boundaries, which are not implemented`. DI sums the odd-length tail of each frame in a different order, so native's output depends on the frame grouping (the differential test shows different md5s for `asetnsamples=n=7:p=0` and `=8`). It is refused for every precision.
  - `blocksize` above 0 (`biquad blocksize is not implemented`), `channels` other than `all` (`biquad channels other than all are not implemented`).
  - `a0=0` (`biquad a0 must not be zero`; native divides by zero).
  - Coefficient sets outside the second-order stability triangle after normalisation, `|a2| < 1` and `|a1| < 1 + a2`, checked in double and after the float copy. For `zdf`, which runs on the raw `a0`/`a1`/`a2`, the state matrix `[[2a0-1, -2a1], [2a1, 1-2a2]]` must also have its trace and determinant inside the same triangle. Message: `biquad coefficients outside the stability triangle are not implemented`. Native lets the state blow up, which reaches platform-dependent NaN conversions.
  - Prepared coefficients beyond the float range (`biquad coefficients exceed the float range`), for example `a0=1e-30:b0=2000000000`.
  - Expressions and other non-decimal values (`Only constant decimal biquad a1 values are implemented`), `normalize` spellings other than the four above (`Unsupported biquad normalize value: yes`), and `precision` expressions.
  - Timeline `enable=` (`biquad timeline enable is not implemented`). Runtime commands are not part of the chain syntax.
- **At run time:** non-finite float input (`Non-finite biquad input is not implemented`) and a non-finite kernel output (`Non-finite biquad output is not implemented`; unreachable for the accepted coefficient ranges with finite input).
- **Automatic sample-rate conversion** around biquad (`-ar` that differs from the input) fails with `biquad with sample rate conversion is not implemented`. Native resamples in this case.

## Negotiation

`formats()` returns the native list. For `precision=auto` it is `['s16p','s32p','fltp','dblp']`; otherwise the one pinned planar format: `s16` → `['s16p']`, `s32` → `['s32p']`, `f32` → `['fltp']`, `f64` → `['dblp']`.

| Input | u8 | s16 | s32 | flt | dbl |
|---|---|---|---|---|---|
| `auto` works in | s16p | s16p | s32p | fltp | dblp |
| pinned precision | its format | its format | its format | its format | its format |

Neighbouring lists merge as they do natively: `biquad=…,volume=0.5` runs biquad in `fltp`. With a pinned precision the input is converted to it (float-to-integer conversion needs `-cpuflags 0` for byte comparisons). `negotiate`, `nativeFormats` and `flacInput` are not declared.

## Arithmetic

Coefficients are prepared in native order: `a1`, `a2`, `b0`, `b1`, `b2` are divided by the original `a0`, then `a0` by itself. With `normalize`, when `|b0 + b1 + b2| > 1e-6`, the `b` values are multiplied by `(a0 + a1 + a2) / (b0 + b1 + b2)`. `latt` then applies `convert_dir2latt` and `svf` `convert_dir2svf`; `zdf` reads the raw option values (`convert_dir2zdf` for the biquad type). Finally the values are copied to float (`a_float`/`b_float`). For the biquad type `w0 = 0` and `A = 10^0 = 1`, and neither reaches the coefficients, so no libm call affects the output.

| Working format | Kernel type | Output |
|---|---|---|
| s16p | float: `Math.fround` after every operation | clip to [-32768, 32767], else truncation |
| s32p | double | clip to [-2147483648, 2147483647], else truncation |
| fltp | float: `Math.fround` after every operation | stored unclipped |
| dblp | double | stored unclipped |

`wet` is `mix` in the kernel type and `dry` is `1. - wet` computed in double and stored in the kernel type; the blend is `out * wet + in * dry` (for `tdi`, `in` is the sample plus the first state). Each kernel transcribes its C loop operation by operation without fused multiply-add. Each channel keeps its own cache (two or four values in the kernel type) across frames, so the output does not depend on the frame grouping: the unit tests run 1/7/29/50-sample splits and the differential test compares `asetnsamples=n=7:p=0` with `=8`.

Native builds for linux/x64 without x86 assembly do not contract these operations. macOS contracts every kernel's multiply-adds into FMA, so all byte comparisons are gated to linux/x64. The gate is a precaution recorded from the wave selection notes; no macOS difference was measured in this sandbox.

## Frames and memory

Each input frame produces one owned output frame of the same size and timestamp in the working format. Inputs are never mutated. Counts and packet boundaries are unchanged; the step is a stream step, so `reframes` is derived true and output `-ss`/`-t`/`-frames:a` select from the filtered output. `reserve()` declares one output frame plus 32 bytes of cache per channel (native's `4 * sizeof(double)`). The stream refuses a cache above `maxFrameBytes` (`biquad state exceeds allocation limit`), a format change between frames (`biquad requires a stable input format`), checks its frame allocations, and observes `options.signal`.

## Evidence

`tests/differential/biquad.test.ts` reads `.build/reference/build-metadata.json` and asserts commit `946fcce0` and `--disable-x86asm`, then runs `.build/reference/ffmpeg` at test time, batching every output of one input into a single native process. 10212 byte comparisons, all on linux/x64:

- 7932 framecrc cases: raw u8/s16le/s32le/f32le/f64le input, 1–3 channels, 8000 and 44100 Hz, every transform × precision × coefficient set (nine direct-form sets: low-pass, high-pass, band-pass, near-unity poles, `a0=2` with normalize, s16/s32-clipping gain, mix 0/0.25/0.5; five zdf sets), plus s16/s32/f64 outputs of the automatic precision.
- 1080 WAV, raw and framecrc files from WAV inputs in all five formats, mono and stereo, under output `-ss`, `-t`, `-ss -t` and `-frames:a 1`/`2`.
- 1200 framecrc chains on 5000-sample inputs: `asetnsamples=n=7:p=0` and `=8` before biquad, `volume` after it, `aformat=sample_fmts=s32` and `aformat=sample_fmts=dbl … volume=2` around it. For each of the 240 filter configurations, native's md5 with `n=7` equals its md5 with `n=8`; for `di` it does not.

It also checks 30 refusals against native's exit status and asserts that no output file is created: 11 forms native also rejects, 18 forms native accepts that remain refused, and rate conversion.

`tests/unit/biquad.test.ts` covers the parser and exact messages, coefficient preparation (a0 division, normalize, lattice, SVF, raw zdf), negotiation for every input format and precision, `requiresScalarRounding`, `planSamples`, `packetSections`, `plannedReservations` and `reservations`, the absence of rate/channel constraints, output against a direct transcription of the C loops for all six transforms in all four working types with packed and planar input and 1/7/29/50-sample splits, input immutability, owned outputs, kernel clipping, and the allocation, state, stable-format, non-finite input and cancellation limits. The registry tests (`audio-filter-registry*.test.ts`) pass unchanged.

Sandbox reference: `.build/reference/ffmpeg` sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`.

## Scoped test contracts

| File | Test | Scope | Platforms |
|---|---|---|---|
| `tests/differential/biquad.test.ts` | `runs against the pinned native commit built without x86 assembly` | reference build metadata | all |
| `tests/differential/biquad.test.ts` | `matches native framecrc for every transform and precision across raw sources, channel counts and rates` | framecrc bytes | linux-x64 |
| `tests/differential/biquad.test.ts` | `writes native-identical WAV, raw and framecrc outputs from WAV inputs under output -ss, -t and -frames:a` | file bytes, output time selection | linux-x64 |
| `tests/differential/biquad.test.ts` | `matches native with asetnsamples=7 and =8 before biquad, volume after it and aformat before it` | framecrc bytes, frame-grouping independence | linux-x64 |
| `tests/differential/biquad.test.ts` | `fails explicitly before output where native fails, and for accepted forms that remain unimplemented` | native exit status, no output | all |
| `tests/unit/biquad.test.ts` | `parses named, aliased and positional options with native defaults and prepares coefficients in native order` | syntax, coefficient preparation | all |
| `tests/unit/biquad.test.ts` | `refuses native errors and unimplemented forms with exact messages` | refusal messages | all |
| `tests/unit/biquad.test.ts` | `negotiates the automatic list and pinned precisions, refuses rate conversion and plans one frame plus the per-channel cache` | negotiation, planning, reservations | all |
| `tests/unit/biquad.test.ts` | `matches a transcription of the C loops for every transform and working type, identically for 1/7/29/50-sample splits, without touching its input` | kernel transcription, frame splits, ownership | all |
| `tests/unit/biquad.test.ts` | `runs the shared kernels in place and counts clipped samples` | shared kernel API | all |
| `tests/unit/biquad.test.ts` | `enforces allocation, state, format and cancellation limits` | limits, AbortSignal | all |
