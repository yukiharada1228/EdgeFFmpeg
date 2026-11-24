# afade

`afade` (`packages/avfilter/src/audio/afade.ts`) fades audio in or out with polynomial and square-root curves. It is a stateless `apply` descriptor added through the [audio filter registry](audio-filter-registry.md). The upstream source is `libavfilter/af_afade.c` at the pinned commit (`fade_gain`, `filter_frame`, `config_output`). Provenance is in `packages/avfilter/NOTICE-AFADE`.

## Syntax

`afade` or `afade=<options>`. Options are separated by `:`. Names and aliases follow native:

| Option | Alias | Values | Default |
|---|---|---|---|
| `type` | `t` | `in`, `out`, `0`, `1` | `in` |
| `start_sample` | `ss` | decimal integer, 0 to 2^53 | 0 |
| `nb_samples` | `ns` | decimal integer, 1 to 2^53 | 44100 |
| `start_time` | `st` | duration (`av_parse_time` syntax, for example `0.5`, `10ms`, `250us`), 0 to 2^53 µs | 0 |
| `duration` | `d` | duration, 0 to 2^53 µs | 0 |
| `curve` | `c` | `tri`, `qua`, `cub`, `squ`, `par`, `ipar`, `desi`, `quat`, `nofade` | `tri` |
| `silence` | | decimal in [0, 1] | 0 |
| `unity` | | decimal in [0, 1] | 1 |

Values without a key are assigned in native's shorthand order: `type`, `start_sample`, `nb_samples`, `start_time`, `duration`, `curve`, `silence`, `unity`. After a keyed option, a value without a key is refused, as native refuses it. When an option is given more than once, the last value wins. As in `config_output`, a nonzero `duration` replaces `nb_samples` and a nonzero `start_time` replaces `start_sample`. Both are rescaled at the link rate with `av_rescale` (round half away from zero). Durations are truncated to whole microseconds first, as `av_parse_time` does.

## Arithmetic

- `fade_gain`: `av_clipd(1.0*index/range, 0, 1)`, then the curve, then `silence + (unity - silence) * gain`. The operations are unfused double operations. `squ` and `par` use `Math.sqrt`, which is correctly rounded like `sqrt`. `cub`, `desi` and `quat` keep C's left-to-right products.
- `cur_sample = av_rescale_q(pts, time_base, 1/sample_rate)`, read from each frame's `pts` (round half away from zero). The step therefore declares `reframes: true`, so output `-ss`/`-t` select from the filter's output.
- The per-frame branches follow `filter_frame`: the `unity == 1` pass-through, `av_samples_set_silence` (+0) when `silence == 0` or `scale_samples` by `silence` otherwise, `scale_samples` by `unity`, and `fade_samples` with direction ±1.
- Samples: `d = s * gain` in double. Floats are rounded to float, and integers are truncated toward zero, as the C conversion does. `|gain| <= 1`, so integer results never overflow.

## Formats

`formats()` returns native `sample_fmts`: `s16, s16p, s32, s32p, flt, fltp, dbl, dblp`. The chain's native negotiation picks the working format. Planar and packed forms compute identically.

| Source \ output codec | u8 | s16 | s32 | f32 | f64 |
|---|---|---|---|---|---|
| u8 | s16 | s16 | s32 | flt | dbl |
| s16 | s16 | s16 | s16 | s16 | s16 |
| s32 | s32 | s32 | s32 | s32 | s32 |
| flt | flt | flt | flt | flt | flt |
| dbl | dbl | dbl | dbl | dbl | dbl |

FLAC input is refused before decoding (`FLAC input to afade requires additional Native evidence`). The descriptor does not declare `flacInput`.

## Frame-boundary dependence

Native's `filter_frame` decides each frame's branch from the frame as a whole. A sample outside the fade window therefore gets a different gain depending on whether it shares a frame with the window. Native frames are demuxer packets, which `atrim` (input `-ss`/`-t`) and upstream filters such as `asetnsamples` regroup. The PCM CLI path filters frames grouped by its memory plan instead, so it cannot reproduce native's grouping. Where the grouping changes the output, afade refuses explicitly before any output is opened. In every other configuration the output is the same for any grouping. The unit tests check this with splits of 1, 7, 29 and 50 samples, and the differential tests check it across native's own groupings.

| Case | Why it depends on frames | Refusal |
|---|---|---|
| `silence + (unity - silence) * 1` does not round to `unity` (for example `silence=0.2:unity=0.9`) | Samples past the window in a frame that overlaps it get that sum; later frames get `unity` | at parse: `afade silence and unity whose full gain does not round to unity depend on native frame boundaries, which are not implemented` |
| `nofade` with `silence != unity`, and samples on the silence side (a fade-in that starts after sample 0, or any fade-out) | `fade_samples` keeps `unity` on the silence side; whole frames get `silence` | in `constraint()`, before output: `afade nofade with silence outside the fade depends on native frame boundaries, which are not implemented` |
| `silence=0` on a floating working format, with samples on the silence side | `av_samples_set_silence` writes +0; `fade_samples` writes `s*0`, which is -0 for negative samples | at the first frame, before output: `afade with silence=0 on flt samples outside the fade depends on native frame boundaries, which are not implemented` (or `dbl`) |

So on floating samples, the supported fades with the default `silence=0` are fade-ins that start at sample 0 (`ss=0` or `st=0`, any `ns`/`d`, every curve). Integer working formats (s16, s32, which includes u8 sources into integer outputs) support every fade. With a nonzero `silence`, every fade is supported in every format, subject to the first row.

## Refused forms

All refusals throw `AudioFilterError` before any output is opened:

- libm curves: `afade curve <name> requires unimplemented libm functions` for `qsin`, `esin`, `hsin`, `log`, `cbr`, `exp`, `iqsin`, `ihsin`, `dese`, `losi`, `sinc`, `isinc`, `quatr`, `qsin2`, `hsin2`. Native implements them with `sin`, `cos`, `asin`, `acos`, `exp`, `log10`, `cbrt` and `pow`, whose results are not reproduced.
- Numeric curve values (`Unsupported afade curve: 7`), expressions in `type` (`Unsupported afade type: in+out`), non-decimal sample counts (`ss=1e2`), quoted or escaped values and timeline `enable` (`Quoted or escaped afade options are not implemented`), unknown options, and values out of native's ranges.
- Values above 2^53 samples or microseconds, and a `duration` that rescales to zero samples at the link rate (`afade duration rounds to zero samples at <rate> Hz`). Native divides by zero there.
- Runtime commands (`process_command`): the chain has no command interface.
- Non-finite floating input in a scaled or faded frame (`Non-finite afade input is not implemented`), because NaN payload propagation is not reproduced.
- The frame-boundary cases above.
- `acrossfade`, which needs two inputs.

## Evidence

The Linux x86_64 reference is `.build/reference/ffmpeg`, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`.

`tests/differential/afade.test.ts` makes 1,080 byte-exact comparisons with native CLI output and checks native's exit status for 156 refusals. The inputs are generated stereo 8000 Hz raw PCM. Native runs with `-cpuflags 0 -bitexact`.

| Test | Native comparisons | Refusals |
|---|---|---|
| `matches native fade-in and fade-out bytes for every implemented curve and the ss/ns, st/d and positional spellings` | 300: in/out × 8 curves × 4 spellings on s16/s32/u8 outputs, plus from-zero fade-ins × 9 curves × 4 spellings on f32/f64/s16 | 8 (nofade) |
| `matches native WAV and framecrc output from every source format into u8, s16 and f32 outputs` | 168: u8/s16/s32/f32/f64 sources × u8/s16/f32 outputs × WAV/framecrc | 42 (floating fade-outs) |
| `matches native fades crossing frame boundaries, outside the input, and under input and output time selection` | 252: 18 chains (asetnsamples before and after, fades before and after the input, stacked fades, volume, asetrate) × input `-ss`/`-t`, output `-ss`/`-t`/`-frames:a` × 2 formats, framecrc | 0 |
| `matches native non-default silence and unity gains on linux x64` (linux/x64 only) | 360: 9 curves × in/out × 6 silence/unity pairs × s16/s32/f32/f64 | 72 |
| `refuses libm curves, unimplemented syntax and frame-boundary-dependent fades before output, recording native status` | 0 | 34 |

Native exits 0 for every libm curve, for the frame-boundary cases, and for `c=7`, `t=in+out`, `ss=1e2`, `enable=…`, `d=1us` and `ss=2^53+1`. It fails, as Edge does, for `ns=0`, `t=sideways`, `silence=2`, `st=-1`, unknown options and a value without a key after a keyed one.

`tests/unit/afade.test.ts` (12 tests) covers the exact syntax messages, `fade_gain` per curve, duration rescaling, branch selection, the `pts` mapping in foreign time bases, negotiation for u8/s16/s32/flt/dbl into every output, `planSamples`, `packetSections`, `plannedReservations`, the constraint and first-frame refusals, output against a direct transcription of `filter_frame` for every format, curve and branch, invariance under frame splits, stream processing after `asetnsamples`, ownership, allocation limits, cancellation and the non-finite refusal.

Default `silence=0` and `unity=1` are exact on every platform: each operation is a single correctly rounded IEEE operation. Non-default pairs are pinned only on linux/x64, the unfused profile: the wave specification records that `silence=0.1:unity=0.9` differs on macOS, where `silence + (unity - silence) * gain` is fused.

## Scoped test contracts

| Id | File | Test | Scope |
|---|---|---|---|
| `filter.afade.curves` | `tests/differential/afade.test.ts` | `matches native fade-in and fade-out bytes for every implemented curve and the ss/ns, st/d and positional spellings` | implemented curves, in/out, option spellings |
| `filter.afade.formats` | `tests/differential/afade.test.ts` | `matches native WAV and framecrc output from every source format into u8, s16 and f32 outputs` | source formats, outputs, containers, floating refusals |
| `filter.afade.time` | `tests/differential/afade.test.ts` | `matches native fades crossing frame boundaries, outside the input, and under input and output time selection` | frame boundaries, pts, time selection |
| `filter.afade.gains` | `tests/differential/afade.test.ts` | `matches native non-default silence and unity gains on linux x64` | silence/unity on linux x64 |
| `filter.afade.refusals` | `tests/differential/afade.test.ts` | `refuses libm curves, unimplemented syntax and frame-boundary-dependent fades before output, recording native status` | explicit refusals |
| `filter.afade.unit` | `tests/unit/afade.test.ts` | `matches a direct C transcription for every curve, format and branch, and is invariant under frame splits where native is` | arithmetic, branches, split invariance |
