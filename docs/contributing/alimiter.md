# alimiter lookahead limiter

The bounded linear audio chain accepts `alimiter` and `alimiter=<options>`, adapted from `libavfilter/af_alimiter.c` at the pinned commit `946fcce0` (provenance in `packages/avfilter/NOTICE-ALIMITER`). It runs on the PCM CLI paths (WAV, AIFF, AU, W64, raw PCM, framecrc) and through `AudioFilterChain.process`. FLAC input is refused before decoding with `FLAC input to alimiter requires additional Native evidence`. Only the plain lookahead limiter is implemented: no auto-release (`asc=1`) and no latency compensation (`latency=1`).

```sh
npm run ffmpeg -- --root ./media -- -i /input.wav -af 'alimiter=limit=0.5:attack=2:release=20' -c:a pcm_f64le /limited.wav
```

## Options

| Option | Type | Default | Range | Status |
|---|---|---|---|---|
| `level_in`, `level_out` | double | 1 | 0.015625–64 | supported |
| `limit` | double | 1 | 0.0625–1 | supported |
| `attack` | double, ms | 5 | 0.1–80 | supported |
| `release` | double, ms | 50 | 1–8000 | supported |
| `asc` | bool | 0 | | `0` only |
| `asc_level` | double | 0.5 | 0–1 | accepted, no effect (it only feeds the auto-release path) |
| `level` | bool | 1 | | supported: output scaled by `1/limit` |
| `latency` | bool | 0 | | `0` only |

Options are `:`-separated `key=value` pairs. Values without a key fill the options positionally in declaration order (`level_in`, `level_out`, `limit`, `attack`, `release`, `asc`, `asc_level`, `level`, `latency`) until the first named option. A repeated option takes its last value.

Refused before any output is opened (`unsupported-filter`):

- `asc=1`: `alimiter asc requires unimplemented libm arithmetic` (`asc_coeff = pow(0.5, asc_level - 0.5)` and the auto-release path are out of scope). Native runs it.
- `latency=1`: `alimiter latency compensation drops leading samples, which the audio chain cannot express` (native trims `buffer_size/channels - 1` leading samples and appends 1024-sample padded frames). Native runs it.
- `enable=`: `alimiter timeline enable is not implemented` (native has generic timeline support). Runtime commands: the chain takes none.
- Native refuses these too: out-of-range values (`Value <v> for alimiter option <name> out of range [<min> - <max>]`, native exit `256 - ERANGE`), booleans outside 0/1 or `auto` (`256 - EINVAL`), an unknown option (exit 8), a positional value after a named one and a tenth positional value (`256 - EINVAL`).
- Native accepts these, but they are unimplemented: expressions and SI suffixes (`1/2`, `5ms`), quoting and escaping, boolean spellings other than the native names and whole integers.
- `constraint()`: `buffer_size = (int)(sample_rate * attack/1000 * channels)`, rounded down to a multiple of channels, must be positive, or `alimiter attack is too small` (native fails in `config_input` with `Attack is too small`, exit `256 - EINVAL`). For example `attack=0.1` at 8000 Hz for 1, 2 or 3 channels. Rates where `sample_rate * channels * 100` overflows native's `int` are refused.

## Execution

`formats()` is native's `['dbl']`: every input format negotiates packed `dbl` (`negotiatedSampleFormats` gives `['dbl']` for u8, s16, s32, flt, dbl and their planar forms), and integer outputs need scalar rounding afterwards. alimiter is a stream step: it reframes, allocates one output frame per input frame and keeps its lookahead across frames. Output sample counts, frame sizes and timestamps equal the input's: the output is the input delayed by `buffer_size/channels` samples, starting with that many zeros, and the delayed tail is dropped as native does without `latency`. No `count()` is declared.

The loop is a direct transcription of `filter_frame` with `auto_release = 0`: `buffer`, `nextdelta` (doubles) and `nextpos` (int32, initialised to -1), each `obuffer_size = (int)(sample_rate*channels*100/1000. + channels)` entries; `att = 1`, `delta = 0`; the peak test, the `delta`/`nextpos` chain search with its integer division `((buffer_size - nextpos[j] + pos) % buffer_size) / channels`, the chain advance at `nextpos[nextiter]`, and the clamps (`att > 1`, `att <= 0` to `1e-13`, `1 - att < 1e-13`, `|delta| < 1e-14`). `FFMAX`, `FFMIN` and `av_clipd` are reproduced as their C comparisons, and the output is `clip(x, -limit, limit) * level * level_out` in that order.

`reserve()` declares one frame (`frameReservation`) plus all three arrays as `stateBytes` (`obuffer_size * 20`). `process` refuses state larger than `maxFrameBytes` with `alimiter lookahead buffer exceeds allocation limit`, refuses a rate or channel change between frames (`alimiter requires a stable input format`), and observes `options.signal`.

## Determinism and arithmetic profile

With `asc=0` the path calls no libm function other than `fabs` and has no `a*b+c` expression that a compiler could contract into a fused multiply-add. Every operation is an IEEE double add, subtract, multiply, divide or compare in source order, so the output is expected to match on every platform. No case is gated: all comparisons run on every platform. They were measured on linux/x64 only (this sandbox). No macOS run was available, so the macOS claim still needs the macOS compat report. Native output does not depend on frame grouping: the differential test checks that native md5s for `asetnsamples=n=1/7/29/50:p=0` before alimiter equal the ungrouped output.

## Evidence

- `tests/unit/alimiter.test.ts` (5 tests): exact parse results and refusal messages; `config_input` sizes and the attack refusal; negotiation for every input format, `requiresScalarRounding`; `planSamples`, `packetSections`, `plannedReservations`, `reservations`; output equal, by `Object.is` for each sample, to a direct transcription of the C loop for 12 option sets, 1–3 channels, 8000/44100 Hz and whole/1/7/29/50-sample splits (360 comparisons); s16 input conversion; input ownership; state and frame allocation limits; empty configured input; cancellation.
- `tests/differential/alimiter.test.ts` (3 tests) against `.build/reference/ffmpeg` (it checks `build-metadata.json` for commit `946fcce0` and `--disable-x86asm`):
  - 885 PCM byte comparisons: 15 option sweeps (limit 0.0625/0.3/1, attack 0.1/0.2/0.37/2/13/80, release 1/7/50/300/8000, level 0/1, level_in/level_out extremes, explicit asc=0/latency=0/asc_level, positional form) at 8000/44100/48000 Hz, 1–3 channels, raw u8/s16/s32/f32/f64 input, into f64 output, plus s16 raw and s32 WAV outputs (`-cpuflags 0`) for two sweeps;
  - 276 framecrc, raw and WAV comparisons: raw and WAV input (s16 stereo 44100, f64 mono 48000, f32 3-channel 8000), `asetnsamples=7` and `asetnsamples=n=7:p=0` before, `volume` before, `apad` after, two limiters in series, input `-ss`/`-t`, output `-ss`/`-t`/`-frames:a`, and 1/7/29/50-sample splits;
  - 25 refusals with native's exit status beside ours (non-zero, nothing written, exact message).
- Signals: a quiet sine below every limit, noise above it, isolated bursts in silence, and alternating rising peaks, so `nextpos` chains form, extend and drain.

## Proposed contracts

| id | file | title | scope | platforms |
|---|---|---|---|---|
| `filter.alimiter.parse` | `tests/unit/alimiter.test.ts` | parses named and positional options with native defaults, names and ranges, and refuses everything else with exact messages | syntax and refusals | all |
| `filter.alimiter.config` | `tests/unit/alimiter.test.ts` | sizes the lookahead as config_input does and refuses attacks too small for the rate and channel count | config_input sizes, attack constraint | all |
| `filter.alimiter.planning` | `tests/unit/alimiter.test.ts` | pins dbl for every input format and plans an unchanged count with an exact state reservation | negotiation, counts, reservations | all |
| `filter.alimiter.transcription` | `tests/unit/alimiter.test.ts` | matches a transcription of the C loop for every option family on 1-3 channels, independent of 1/7/29/50-sample splits, without touching its input | C-loop transcription, splits, ownership | all |
| `filter.alimiter.limits` | `tests/unit/alimiter.test.ts` | refuses unstable formats, oversized state and frames, emits nothing for empty input and observes cancellation | limits, empty input, cancellation | all |
| `filter.alimiter.native-pcm` | `tests/differential/alimiter.test.ts` | matches native PCM bytes for the option sweeps on 1-3 channels at 8000/44100/48000 Hz from every raw source format | PCM bytes vs native | all |
| `filter.alimiter.native-framecrc` | `tests/differential/alimiter.test.ts` | matches native framecrc across frame splits, chains, WAV input, output selection and frame limits; native output is independent of frame grouping | chains, selection, splits vs native | all |
| `filter.alimiter.native-refusals` | `tests/differential/alimiter.test.ts` | refuses asc, latency, too small attacks, out-of-range values and enable before output, beside native status | refusals vs native status | all |

## Reference environment

Sandbox reference `.build/reference/ffmpeg` sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built with `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, Node 24.22.3.

## Unsupported

FLAC input; `asc=1`; `latency=1`; `enable`; runtime commands; expressions, SI suffixes and quoting; automatic sample-rate conversion next to alimiter; attacks too short for the rate and channel count (native fails too).
