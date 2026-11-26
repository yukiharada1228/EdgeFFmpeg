# aphaser triangular-modulated phaser

The bounded linear audio chain accepts `aphaser` from `libavfilter/af_aphaser.c` (FFmpeg 9.0.2, commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`), with its triangular modulation table from `libavfilter/generate_wave_table.c` (`WAVE_TRI`). Each channel feeds a delay ring whose read position is modulated by a triangle wave: `v = x * in_gain + ring[read] * decay`, `out = v * out_gain`. The output has the input's length and timestamps; there is no tail. Provenance is in `packages/avfilter/NOTICE-APHASER`.

```sh
npm run ffmpeg -- --root ./media -- -cpuflags 0 -i /input.wav -af 'aphaser=in_gain=0.5:out_gain=1:delay=2:decay=0.5:speed=0.8' /out.wav
```

## Syntax

`aphaser`, `aphaser=<options>`. Options are `key=value` pairs separated by `:`, or positional values in AVOption order `in_gain:out_gain:delay:decay:speed:type`. As in native, a positional value after a named one is refused, and a later value for the same key wins.

| Option | Type | Range | Default | Accepted spelling |
|---|---|---|---|---|
| `in_gain` | double | 0..1 | 0.4 | `digits[.digits]` or `.digits` |
| `out_gain` | double | 0..1e9 | 0.74 | same |
| `delay` | double (ms) | 0..5 | 3 | same |
| `decay` | double | 0..0.99 | 0.4 | same |
| `speed` | double (Hz) | 0.1..2 | 0.5 | same |
| `type` | int | `triangular`, `t` or `1` | triangular | the constant names or `1` |

Explicit failures, all before any output is opened:

- refused here, native runs them:
  - `type=sinusoidal`, `type=s` or `type=0`: `aphaser type sinusoidal requires unimplemented libm arithmetic` (the table uses libm `sin()`, which is not reproduced bit for bit);
  - gains past native's `out_gain may cause clipping` condition, `in_gain / (1 - decay) > 1 / out_gain` evaluated in double as `init()` does: `aphaser in_gain/(1-decay) above 1/out_gain (out_gain may cause clipping) is not implemented`. Native only warns there, then its integer kernels convert values outside the int16/int32 range by C truncation, which is undefined (see [Clipping bound](#clipping-bound)). The refusal applies to every format, because `parse()` cannot see the negotiated one;
  - expressions, exponents, SI suffixes, signs and escaping (`Only decimal aphaser <key> values are implemented`), and other `type` spellings (`Unsupported aphaser type value: <value>`);
- native fails too: `enable=` (`aphaser timeline enable is not implemented`; native has no timeline support for aphaser and exits with a failure), out-of-range values (`aphaser <key> is out of range [<low> - <high>]`), unknown options (`Unsupported aphaser option: <name>`), malformed or surplus positional values (`Invalid aphaser option`);
- `constraint()`: `delay_buffer_length = (int)(delay * 0.001 * sample_rate + 0.5)` must be positive, or the chain fails with `aphaser delay is too small`, as native does with `EINVAL` (for example `delay=0.05` at 8000 Hz). The sample rate is the rate at the filter's position, so a preceding `asetrate` applies. `modulation_buffer_length = (int)(sample_rate / speed + 0.5)` is at least 1 for every valid rate and speed; it must stay below 2^30 (`aphaser modulation buffer length is out of the implemented range`), which keeps native's `int` length and its uint32 `4 * point` exact. That needs a rate above 107 MHz.

Runtime commands are not reachable: none of aphaser's options carries native's runtime flag, and the chain has no command interface. FLAC input is refused before decoding (`FLAC input to aphaser requires additional Native evidence`); `flacInput` is not declared.

## Negotiation

`formats()` is native's `FILTER_SAMPLEFMTS` list in source order: `['dbl','dblp','flt','fltp','s32','s32p','s16','s16p']`. A listed arriving format is used as is. `u8` merges forwards with the encoder: `s16` for `u8`/`s16` output, `s32`, `flt` or `dbl` for those outputs (`u8p` gives the same packed picks, and `s16p` for `u8` output); native's `-v debug` reports `picking s16 out of 8 ref:u8` for `u8` into `pcm_u8`. `aformat=sample_fmts=<planar>` before the filter selects the planar kernels. `aphaser,volume=0.5` merges volume's `{flt,fltp}` into the list, so native runs aphaser in `flt`; the chain reproduces that for `u8`/`flt` input and refuses `s16`, `s32` and `dbl` input with `aphaser with <format> input requires unimplemented format negotiation` (native runs it). The step is not `transparent`.

Native's packed (`PHASER`) and planar (`PHASER_PLANAR`) kernels compute the same values: both read `MOD(delay_pos + table[modulation_pos], L)` before advancing `delay_pos` and write `v` at the advanced position, per channel from the shared `delay_pos`/`modulation_pos`. EdgeFFmpeg runs one per-channel loop over a strided view for both layouts, with one `L`-sample ring per channel instead of native's interleaved `L * channels` buffer. Output frames are new owned frames from `convertAudioFrame` in the negotiated format.

## Arithmetic profile

- Table: `ff_generate_wave_table(WAVE_TRI, AV_SAMPLE_FMT_S32, table, N, 1., L, M_PI / 2.0)`. `phase_offset = (uint32)(M_PI/2.0 / M_PI / 2 * N + 0.5)`, `point = (i + phase_offset) % N`, `d = point * 2 / N`, then `d + 0.5`, `1.5 - d` or `d - 1.5` by quadrant `4 * point / N`, `d = d * (L - 1) + 1`, `d += 0.5` and truncation to int32. EdgeFFmpeg computes each entry on demand in these double operations (`audioPhaserTriangle`) instead of holding the `N`-entry table; every entry lies in `[1, L]`. The unit test compares it with a direct transcription of the C loop for 12 table sizes up to 1,234,567.
- Kernel: `v = src * in_gain + ring[read] * decay` in double (`src` widened from int16/int32/float), `ring[next] = v`, `dst = v * out_gain` converted as C does: rounded to float for `flt`, kept for `dbl`, truncated toward zero for `s16`/`s32`.
- Platforms: the Linux x86_64 reference build evaluates both `src*in_gain + buf*decay` and the table's `d*(max-min)+min` unfused. macOS toolchains can contract them into FMA, so cases with arbitrary gains (float and integer kernels alike) run only on Linux x64. Integer input at 8192 Hz with `speed` 0.5, 1 or 2 has a power-of-two table length, so every table operation is exact, and gains and decays 0.25, 0.5, 1 and 2 make every kernel product exact; no contraction can change those, and that test runs on every platform. No macOS difference was measured in this sandbox (Linux only), so the gate is a precaution.
- Non-finite float input, and float output that overflows double, is refused (`Non-finite aphaser samples are not yet supported`), since NaN payloads are not pinned. Overflow to float infinity on `flt` output is computed as native does.

## Clipping bound

`parse()` refuses `fl(in_gain / fl(1 - decay)) > fl(1 / out_gain)`, native's condition in double. Inside it, every integer output is representable, so C's conversion is always defined and EdgeFFmpeg's `Math.trunc` reproduces it. Proof, with `G = in_gain`, `D = decay <= 0.99`, `O = out_gain > 0` (for `O = 0` every output is 0) and unit roundoff `u = 2^-53`:

1. Each rounding has relative error at most `u`, so an accepted triple satisfies `G * O / (1 - D) <= (1 + u)^2 / (1 - u) <= 1 + 4u`.
2. Gains and decay are non-negative and rounding is monotone, so each `v = fl(fl(x*G) + fl(b*D))` satisfies `v <= (x⁺G + b⁺D)(1 + u)^2`, where `x⁺`, `b⁺` are the positive parts of the input and of the ring value read. With `P⁺` the largest positive input, induction over samples (the ring starts at 0) gives `v⁺ <= M = P⁺G(1 + u)^2 / (1 - D(1 + u)^2)`, since `M` is the fixed point of that recurrence.
3. With `D <= 0.99`, `1 - D(1 + u)^2 >= (1 - D)(1 - 199u)`, so `M <= P⁺ G / (1 - D) * (1 + 202u)` and `fl(v*O) <= M*O*(1 + u) <= P⁺(1 + 4u)(1 + 202u)(1 + u) <= P⁺(1 + 208u)`.
4. The negative side is symmetric with `P⁻`, the magnitude of the most negative input.

For s32, `P⁺ = 2^31 - 1`: the largest output is below `2^31 - 1 + 2^31 * 208 * 2^-53 < 2^31 - 1 + 2^-14`, which truncates to at most `2^31 - 1`. `P⁻ = 2^31`: the smallest output is above `-2^31 - 2^-14`, which truncates to at least `-2^31`. The s16 kernel has the same relative margin with `P⁺ = 32767`, `P⁻ = 32768` (u8 input runs in s16). So the bound survives double rounding at the s32 extremes and needs no tightening; an FMA-contracted kernel rounds fewer times and stays inside it too. The unit test drives full-scale constant, alternating and burst s32 and s16 input through six accepted triples on or just inside the bound (`0.5/1/0.5`, `0.01/1/0.99`, `1/1/0`, `0.25/4/0`, `0.1/5/0.5`, `0.3/1.9047619047619047/0.37`) and checks every pre-truncation value lies in `(-2^31 - 1, 2^31)` (resp. the int16 range). The platform-independent differential test runs full-scale s32 input on `G/(1-D) = 1/O` exactly.

## State and memory

`reserve()` declares one output frame plus `delay_buffer_length * channels * 8` state bytes: the per-channel rings of doubles, zeroed as `av_calloc` does. The delay and modulation positions are two integers. The table is not held (see above). A ring larger than `maxFrameBytes` fails in the stream with `aphaser delay buffer exceeds allocation limit`; on the PCM CLI path, a ring above the buffer budget fails with `resource-budget` (`Audio filter state exceeds the configured buffer budget`) before output. The largest ring is 5 ms: 960 doubles per channel at 192000 Hz. Input format changes mid-stream are refused (`aphaser requires a stable input format`). An empty input needs a configured format (the PCM path provides one) and produces no frames, as in native. Cancellation is observed per frame and per channel.

## Evidence

Sandbox reference: `.build/reference/ffmpeg` sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built from commit `946fcce0` with `--disable-x86asm` by `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`. The differential file asserts the commit and flag from `build-metadata.json` and pins no binary digest. It batches every output of one input into one native process. It ran in 23 s on 4 vCPUs.

`tests/differential/aphaser.test.ts`:

| Test | Comparisons |
|---|---|
| `runs against a reference built from commit 946fcce0 with --disable-x86asm` | metadata only |
| `matches native framecrc for delay, decay, speed and gain sweeps over every native sample format, 1-3 channels at 8000 and 44100 Hz` (Linux x64) | 868 framecrc: u8/s16/s32/f32/f64 raw input, 8000/44100 Hz, 1-3 channels, 12000 samples, 9 sweep chains (defaults, delay 0.1-5, decay 0-0.99, speed 0.1-2, `type=t`/`triangular`, positional shorthand, gains on and just inside the bound) and 5 composed chains (`aformat=sample_fmts=s16p|s32p|fltp|dblp` before it, `asetnsamples=7` before it), into the input codec, pcm_s16le and (stereo) pcm_f64le. Every format of the native list is negotiated. |
| `writes native-identical WAV, raw and framecrc output from raw and WAV input with output -ss, -t and -frames:a, and composes with volume` (Linux x64) | 196 files: s16/f32 raw and WAV input at 44100 Hz stereo, 3 chains, 5 output selections (none, `-ss`, `-t`, `-frames:a`, `-ss`+`-t`), WAV, raw and framecrc; then `aphaser,volume=0.5` (both precisions) on u8 and f32 input, mono and three channels |
| `does not depend on frame grouping: asetnsamples=n=1/7/29/50:p=0 before aphaser matches native and ungrouped output byte for byte` (Linux x64) | 20 raw outputs on s16/s32/f32/f64 stereo input, plus 16 checks that native's grouped output equals its ungrouped output |
| `matches native on every platform for integer input with binary-fraction gains at power-of-two modulation lengths, full-scale s32 on the clipping bound included` | 74 framecrc: u8, s16, s32 and full-scale s32 input at 8192 Hz, mono and three channels, 6 exact chains on the bound (including `asetnsamples=n=7:p=0` and `aformat=sample_fmts=s16p` before it), into the input codec and pcm_s32le; 2 empty inputs |
| `refuses sinusoidal modulation, gains past the clipping bound, delays that round to zero and enable before output, with native status for each case` | 15 native exit statuses: `type=s`/`sinusoidal`/positional `s` and 4 gains past the bound (native 0), 3 delays that round to zero (native `256 - EINVAL` from `os.constants.errno`), `enable=` twice, `delay=6` and `type=x` (native fails), and `aphaser,volume=0.5` on s16 input (native 0). Each is refused here with no output file. |

In total, 1158 byte comparisons and 15 native statuses. A one-off mutation of the modulation position made four of the comparison tests fail.

`tests/unit/aphaser.test.ts` (7 tests) covers parsing with exact messages and the bound at and around equality, buffer lengths and the triangle table against a transcription of `ff_generate_wave_table`, negotiation for all ten input formats under five encoder hints and in the composed chains, `requiresScalarRounding`, counts, packet sections, planned reservations and the PCM budget refusal, the delay constraint, output against a direct transcription of both C kernels in s16/s32/flt/dbl, packed and planar, 1-3 channels and 1/7/29/50-sample splits (bit-exact, `-0` included), the s32/s16 extremes on the bound, ownership, allocation limits, non-finite input and abort. The registry tests `audio-filter-registry.test.ts`, `audio-filter-registry-extension.test.ts` and `audio-filter-registry-contract.test.ts` pass unchanged.

## Proposed test contracts

| File | Test title | Scope | Platforms |
|---|---|---|---|
| `tests/differential/aphaser.test.ts` | `runs against a reference built from commit 946fcce0 with --disable-x86asm` | differential | all |
| `tests/differential/aphaser.test.ts` | `matches native framecrc for delay, decay, speed and gain sweeps over every native sample format, 1-3 channels at 8000 and 44100 Hz` | differential | linux-x64 |
| `tests/differential/aphaser.test.ts` | `writes native-identical WAV, raw and framecrc output from raw and WAV input with output -ss, -t and -frames:a, and composes with volume` | differential | linux-x64 |
| `tests/differential/aphaser.test.ts` | `does not depend on frame grouping: asetnsamples=n=1/7/29/50:p=0 before aphaser matches native and ungrouped output byte for byte` | differential | linux-x64 |
| `tests/differential/aphaser.test.ts` | `matches native on every platform for integer input with binary-fraction gains at power-of-two modulation lengths, full-scale s32 on the clipping bound included` | differential | all |
| `tests/differential/aphaser.test.ts` | `refuses sinusoidal modulation, gains past the clipping bound, delays that round to zero and enable before output, with native status for each case` | differential | all |
| `tests/unit/aphaser.test.ts` | `matches the C transcription in every kernel format, packed and planar, across 1/7/29/50-sample splits, keeping timestamps and owning output` | unit | all |
| `tests/unit/aphaser.test.ts` | `keeps every integer output at the s32 and s16 extremes in range when the gains sit exactly on the clipping bound` | unit | all |
