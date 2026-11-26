# flanger triangular-sweep flanger

The bounded linear audio chain accepts `flanger` with `shape=triangular` (or `shape=t`), adapted from `libavfilter/af_flanger.c` and the `WAVE_TRI` branch of `libavfilter/generate_wave_table.c` at the pinned FFmpeg 9.0.2 commit `946fcce0` (provenance in `packages/avfilter/NOTICE-FLANGER`). It is a registry descriptor, `packages/avfilter/src/audio/flanger.ts`, a stream step without a tail. This is partial flanger compatibility for the raw PCM, WAV and framecrc CLI paths. The native default shape is sinusoidal, so bare `flanger` is refused. FLAC input is refused before decoding (`FLAC input to flanger requires additional Native evidence`).

```sh
npm run ffmpeg -- --root ./media -- -cpuflags 0 -i /input.wav -af 'flanger=delay=5:depth=10:regen=40:speed=10:shape=t:interp=quadratic' /flanged.wav
```

## Syntax

`flanger[=delay:depth:regen:width:speed:shape:phase:interp]`, by position in that order or by name. A named option can follow positional ones, but not the other way round, and the last value given wins.

| Option | Form | Default | Native range |
|---|---|---|---|
| `delay` | constant decimal, ms | 0 | [0, 30] |
| `depth` | constant decimal, ms | 2 | [0, 10] |
| `regen` | constant decimal, % | 0 | [-95, 95] |
| `width` | constant decimal, % | 71 | [0, 100] |
| `speed` | constant decimal, Hz | 0.5 | [0.1, 10] |
| `shape` | `triangular` or `t` (required) | sinusoidal | – |
| `phase` | constant decimal, % | 25 | [0, 100] |
| `interp` | `linear` or `quadratic` | linear | – |

A constant decimal is an optional sign, digits with an optional fraction and an optional exponent (`5`, `.5`, `-40`, `9.5e0`). It is read as a double, as `strtod` does, and range-checked as a double.

Explicit failures. Each is an `AudioFilterError` raised while compiling, so nothing is opened:

- **Native rejects these too:** out-of-range values (`flanger delay 31 is out of range [0 - 30]`), unknown options (`Unsupported flanger option: foo`), unknown constants (`Unsupported flanger interp value: cubic`), too many positional values (`Too many flanger positional options: 9`), a positional value after a named one (`No flanger option name near '5'`), and timeline `enable` (`flanger timeline enable is not implemented`; native has no timeline support for flanger).
- **Native accepts these, but they are unimplemented:**
  - the sinusoidal shape, including the default: `flanger`, `shape=s`, `shape=sinusoidal`, or a later `shape=s` overriding `shape=t` all fail with `flanger shape sinusoidal requires unimplemented libm arithmetic`, because the table uses `sin()`;
  - integer forms of the constants (`shape=1`, `interp=1`: `Unsupported flanger shape value: 1`);
  - expressions, SI suffixes, hexadecimal, `inf`/`nan` and the `min`/`max`/`default` names (`Only constant numeric flanger delay values are implemented: 1/2`).
- **Rate-dependent** (in `constraint()`, before output): `lfo_length = (int)(rate / speed)` below one sample fails with `flanger speed 10 leaves no LFO samples at 9 Hz` (natively a division by zero). An LFO length of 2^30 or more, where `4 * point` in the uint32 table loop could wrap, fails with `flanger LFO length exceeds the implemented range`. A `channels × lfo_length` above `INT_MAX`, where the int phase index could overflow, fails with `flanger channel phase exceeds int range`.
- **Automatic sample-rate conversion** around flanger fails with `flanger with sample rate conversion is not implemented`. Native resamples in this case.
- The options carry no runtime-command flag; there are no runtime commands.

## Negotiation

`formats()` returns the native single format `['dblp']`. Every input (u8, s16, s32, flt, dbl, packed or planar) is converted exactly to `dblp` before the loop. Integer outputs convert from `dblp` at the end of the chain, so `requiresScalarRounding` is true for an integer output hint and the CLI needs `-cpuflags 0`, as it does natively for pinned scalar rounding.

## Arithmetic

- **init():** `feedback_gain = regen/100`, `delay_gain = width/100`, `channel_phase = phase/100`, `delay_min = delay/1000`, `delay_depth = depth/1000`; `in_gain = 1/(1+delay_gain)`, then `delay_gain /= 1+delay_gain` and `delay_gain *= 1-|feedback_gain|`, all in double and in that order.
- **config_input():** `max_samples = (int)((delay_min+delay_depth)*rate + 2.5)`, `lfo_length = (int)(rate/speed)`.
- **LFO table:** `ff_generate_wave_table(WAVE_TRI, FLT, lfo, lfo_length, rint(delay_min*rate), max_samples-2, 3*pi/2)`. `rint` rounds half to even (0.3125 ms at 8000 Hz is 2.5 samples, minimum 2). `phase_offset = (uint32)(phase/pi/2*size + 0.5)`; each point takes `d = point*2/size`, the quadrant `4*point/size` in integer arithmetic, then `d*(max-min)+min` stored as float32.
- **filter_frame():** per sample, `delay_buf_pos = (pos + max_samples - 1) % max_samples` is shared by all channels. Per channel, `channel_phase = (int)(chan*lfo_length*phase + .5)`, the delay is the float table entry widened to double, `int_delay = (int)delay` and the fraction is `modf`'s. The ring takes `in + delay_last*feedback_gain`; linear interpolation is `d0 + (d1-d0)*frac`, quadratic `d0 + (a*frac + b)*frac` with `a = d2*.5 - d1`, `b = d1*2 - d2*.5` after subtracting `d0`. `out = in*in_gain + delayed*delay_gain`. `lfo_pos` advances after all channels.
- The rings start zeroed (`av_samples_alloc` sets silence). There is no libm call on the triangle path.
- **Platforms:** the JavaScript evaluates each step in the same order without fused multiply-add. macOS clang contracts `d*(max-min)+min`, the interpolation polynomial and `in*in_gain + delayed*delay_gain` into FMA, so every byte comparison except `width=0` is gated to linux/x64. This gate is a precaution from the determinism notes; no macOS difference was measured in this sandbox. With `width=0`, `delay_gain` is 0 and `in_gain` 1, so the output is the input whether or not the expression is fused; those cases run on every platform.

## Frames and timestamps

Each input frame produces one owned `dblp` output frame with the same sample count and timestamp. Inputs are never mutated. There is no tail: `count()` is unchanged and a configured empty input produces no frames. `reframes` is true (stream step), so output `-ss`/`-t`/`-frames:a` select from the filtered output. Native output does not depend on frame grouping, and neither does this implementation (`asetnsamples=n=1|7|29|50:p=0` comparisons below, and 1/7/29/50-sample splits in the unit tests).

## Memory

`reserve()` declares one output frame plus `max_samples × channels × 8` bytes of rings, `channels × 8` bytes of `delay_last` and `lfo_length × 4` bytes of LFO table. The stream also refuses that state above `maxFrameBytes` (`flanger state exceeds allocation limit`). The PCM planner refuses it above `maxBufferBytes` with `resource-budget` before output; `speed=0.1` at 44100 Hz needs a 1764000-byte table.

## Evidence

`tests/differential/flanger.test.ts` reads `.build/reference/build-metadata.json`, asserts commit `946fcce0` and `--disable-x86asm`, runs `.build/reference/ffmpeg` at test time and compares CLI output byte for byte. 724 byte comparisons:

- 432 framecrc cases (linux/x64): u8/s16/s32/f32/f64 raw sources, 1–3 channels, 8000 and 44100 Hz, eight option sets sweeping delay 0/5/30 (and a half-sample 0.3125), depth 0/2/10, regen -95/0/40/95, width 0/71/100, speed 0.1/0.5/10, phase 0/25/100 and both interpolations, into the source codec and f64.
- 208 cases (linux/x64): six composed chains (`asetnsamples=7` before, `asetnsamples=n=29:p=0` before, `volume` after, `apad` before and after) under seven output profiles (`-ss`, `-t`, `-ss -t`, `-frames:a`), s16 and f64, mono and stereo; plus 40 frame-grouping comparisons in f64le where `asetnsamples=n=N:p=0` (N = 1, 7, 29, 50) leaves native output unchanged.
- 40 WAV and raw files (linux/x64) from raw and WAV inputs in all five formats, with and without `-ss -t`.
- 44 cases on every platform: `width=0` over all five formats, 1 and 3 channels, with and without `-t`, and 4 configured-empty-input cases.

It also checks 23 refusals against native's exit status and asserts that no output file is created: 8 forms native accepts (bare `flanger`, the sinusoidal shape, integer constants, expressions, `max`), 14 it rejects (ranges, unknown options and constants, `enable=`, too many values), and rate conversion. A state above the buffer budget fails with `resource-budget`.

`tests/unit/flanger.test.ts` covers the parser and its exact messages, the init/config_input values and LFO table (including round half to even), the constraint refusals, negotiation for every input format and `requiresScalarRounding`, `planSamples`, `packetSections`, `plannedReservations` and `reservations`, and output against a direct transcription of the C loop for seven option sets, 1 and 3 channels, and whole, 1-, 7-, 29-, 50-sample and irregular splits of packed and planar input. It also checks integer input conversion, ownership, the state and frame allocation limits, stable formats and AbortSignal.

Sandbox reference: `.build/reference/ffmpeg` sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built with `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`.

## Proposed test contracts

| Id | File | Test | Scope | Platforms |
|---|---|---|---|---|
| `filter.flanger.framecrc` | `tests/differential/flanger.test.ts` | `matches native framecrc across sources, channel counts, rates and option sweeps into source and f64 outputs` | framecrc bytes, option sweeps | linux-x64 |
| `filter.flanger.chains` | `tests/differential/flanger.test.ts` | `matches native composed chains, frame grouping and output -ss/-t/-frames:a` | framecrc and f64le bytes, composition, grouping, time selection | linux-x64 |
| `filter.flanger.files` | `tests/differential/flanger.test.ts` | `writes native-identical WAV and raw files from WAV and raw inputs, with output time selection` | WAV/raw file bytes | linux-x64 |
| `filter.flanger.dry` | `tests/differential/flanger.test.ts` | `matches native exactly where width=0 leaves the input unchanged, on every platform` | framecrc bytes, empty input | all |
| `filter.flanger.refusals` | `tests/differential/flanger.test.ts` | `fails explicitly before output where native fails, and for accepted forms that remain unimplemented` | refusals with native status | all |
| `filter.flanger.budget` | `tests/differential/flanger.test.ts` | `refuses flanger state above the buffer budget before opening output` | resource budget | all |
| `filter.flanger.unit` | `tests/unit/flanger.test.ts` | all six tests | parser, plan, negotiation, transcription, limits | all |

## Unsupported

- The sinusoidal shape, which is the native default (refused).
- Integer forms of `shape`/`interp`, option expressions, SI suffixes, hexadecimal, `inf`/`nan` and named values (refused).
- Timeline `enable` (refused; native refuses it too), FLAC input (refused before decoding), automatic sample-rate conversion (refused).
- AIFF and AU output share the PCM path but have no native comparison here. There is no measured evidence for non-linux/x64 arithmetic beyond the `width=0` cases.
