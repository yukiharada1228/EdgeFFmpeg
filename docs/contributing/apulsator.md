# apulsator

`apulsator` is a stereo auto-panner: a low-frequency oscillator per channel
scales the gain of each sample. It adapts `libavfilter/af_apulsator.c` at the
pinned commit (`packages/avfilter/NOTICE-APULSATOR`). It is one descriptor,
`packages/avfilter/src/audio/apulsator.ts`, registered with one line in
`packages/avfilter/src/audio/registry.ts`.

Only the non-sine waveforms are implemented. `mode=sine` is native's default,
and it calls libm `sin()`, so bare `apulsator` is refused.

## Syntax

| Option | Shorthand position | Type | Range | Default |
|---|---|---|---|---|
| `level_in` | 1 | double | [0.015625, 64] | 1 |
| `level_out` | 2 | double | [0.015625, 64] | 1 |
| `mode` | 3 | int: `sine` (0, refused), `triangle` (1), `square` (2), `sawup` (3), `sawdown` (4) | [0, 4] | `sine` |
| `amount` | 4 | double | [0, 1] | 1 |
| `offset_l` | 5 | double | [0, 1] | 0 |
| `offset_r` | 6 | double | [0, 1] | 0.5 |
| `width` | 7 | double | [0, 2] | 1 |
| `timing` | 8 | int: `bpm` (0), `ms` (1), `hz` (2) | [0, 2] | `hz` |
| `bpm` | 9 | double | [30, 300] | 120 |
| `ms` | 10 | int | [10, 2000] | 500 |
| `hz` | 11 | double | [0.01, 100] | 2 |

Accepted forms are `apulsator=<options>` with named `key=value` pairs,
shorthand values in the order above, or shorthand values followed by named
pairs. A repeated option keeps the last value, as native does. Double values
are plain decimal constants (`1`, `.5`, `1.`, `+0.1`, `1.2e2`). `mode` and
`timing` take their named constants or a plain integer; `ms` takes a plain
integer. Every value is range-checked as a double, as `write_number` does.

Refused before any output, with an `AudioFilterError`:

| Input | Message | Native |
|---|---|---|
| bare `apulsator`, `mode=sine`, `mode=0`, or any option list without a non-sine mode | `apulsator mode sine requires unimplemented libm arithmetic` | runs |
| a value outside its range (`bpm=29.9`, `ms=2001`, `hz=0.009`, `width=2.01`, `amount=1.1`, `level_in=0.015`, `mode=5`, `timing=3`, …) | `Value <value> for apulsator option <name> out of range [<min> - <max>]` | exit 256−ERANGE (222) |
| an unknown `mode` or `timing` name | `Only sine, triangle, square, sawup, sawdown or an integer are implemented for apulsator option mode: <value>` (likewise `bpm, ms, hz` for timing) | exit 256−EINVAL (234) for `mode=foo` |
| a fractional `ms` (`ms=10.5`) | `Only integer values are implemented for apulsator option ms: <value>` | runs (llrint) |
| an expression, suffix, `nan` or empty value | `Only constant decimal values are implemented for apulsator option <name>: <value>` | expressions run |
| a shorthand value after a named pair | `No apulsator option name near '<value>'` | exit 234 |
| a twelfth shorthand value | `Too many apulsator positional options: <value>` | exit 234 |
| an unknown option | `Unsupported apulsator option: <key>` | exit 8 (AVERROR_OPTION_NOT_FOUND) |
| timeline `enable` | `apulsator timeline enable is not implemented` | exit 176 (AVERROR_PATCHWELCOME) |
| quotes or backslashes | `Quoted or escaped apulsator options are not implemented` | – |

The sine refusal is checked after every option has parsed, so a range error in
a later option is reported first, as native would. Runtime commands are not
reachable from the linear chain.

## Format, layout and rate

`formats()` returns native's list, `['dbl']` (packed double). Every input
format (u8, s16, s32, flt, dbl and their planar forms) negotiates `dbl`; a
preceding `volume=0.5` keeps its `flt` and apulsator converts to `dbl`, as the
native graph does. The step is not transparent, so the chain's negotiation
guard compares it with the native pick. `requiresScalarRounding` is true for
integer output.

`constraint()` accepts only two channels with the layout name `stereo`. It
refuses mono, three or more channels, and two-channel WAV/W64 files whose
extensible mask is not FL+FR, with `apulsator requires stereo input`. Native
remixes mono and three-channel input implicitly (probed: both run with exit 0).

Automatic sample-rate conversion is refused, as for every native list. FLAC
input is refused before decoding (`FLAC input to apulsator requires additional
Native evidence`), because the descriptor does not declare `flacInput`.

## Arithmetic

`stream()` keeps both SimpleLFO phases across frames, so output does not
depend on frame grouping. With `freq` = `bpm/60`, `1/(ms/1000)` or `hz`, per
stereo sample in native order:

```text
lfo(phase, offset) =
  phs = FFMIN(100, phase / FFMIN(1.99, FFMAX(0.01, width)) + offset)
  if phs > 1: phs = fmod(phs, 1)
  val = triangle: phs > 0.75 ? (phs-0.75)*4-1 : phs > 0.25 ? -4*phs+2 : phs*4
        square:   phs < 0.5 ? -1 : 1
        sawup:    phs*2-1
        sawdown:  1-phs*2
  return val*amount
inL = l*level_in; procL = inL*(lfo(phaseL, offset_l)*0.5 + amount/2)
outL = (procL + inL*(1-amount)) * level_out        (likewise R)
phase = fabs(phase + 1*freq/srate); if phase >= 1: phase = fmod(phase, 1)
```

Only `+`, `-`, `*`, `/`, `fabs` and `fmod` are used; JS `%` is exact `fmod`.
This is the plain double formula that Linux x86-64 evaluates. macOS clang
contracts `lfo*0.5 + amount/2` and `procL + inL*(1-amount)` into fused
multiply-adds. For `amount` 0 and 1 every contracted product is exact
(`inL*0` or `inL*1`, and `lfo*0.5`), so those cases run on every platform.
For `amount` strictly between 0 and 1, `procL` and `inL*(1-amount)` are both
inexact, so those cases run only on linux-x64. The specification also listed
square-mode cases with any amount as platform-independent; with `amount=0.6`
the square gain is 0 or 0.6 and the final sum still adds two inexact
products, so square with `amount` in (0,1) is gated too, as a precaution
without a measured macOS difference.

Output frames keep the input count and timestamps and own new storage; input
frames are never modified. Overflow gives ±infinity, as in C. Non-finite input
is refused (`Non-finite apulsator input is not yet supported`), and so is an
overflow that turns into NaN (`inf*0`, `inf-inf`), whose payload JS does not
pin (`NaN apulsator output is not yet supported`).

## Memory and limits

`reserve()` declares `frameReservation` plus `stateBytes = 16` (two double
phases). The output frame is checked against `maxFrameBytes` by the
conversion. The stream refuses a sample-rate change between frames, an
invalid sample rate and invalid limits, and checks `options.signal` once per
frame and every 4,096 samples. `allocatesFrames` is true and every other
declared flag is false; the chain derives `reframes` for the stream step, so
output `-ss`/`-t` select from the filtered stream.

## Evidence

- `tests/unit/apulsator.test.ts` has 5 tests: syntax with exact refusal
  messages and the timing frequencies; negotiation for u8/s16/s32/flt/dbl and
  planar input, `requiresScalarRounding`, capabilities, `planSamples`,
  `packetSections`, `plannedReservations` and `reservations`; the layout and
  configured-empty-input constraints; output against a direct transcription of
  the C loop for 6 option sets × 3 rates × 5 splits (whole, 1, 7, 29 and 50
  samples), with counts, timestamps, ownership and unmodified input; and
  conversion, allocation, format, finiteness and cancellation limits.
- `tests/differential/apulsator.test.ts` runs `.build/reference/ffmpeg` at test
  time after asserting commit 946fcce0 and `--disable-x86asm` in
  `build-metadata.json`. Inputs are 6,000-sample stereo raw u8 (8000 Hz),
  s16le (44100 Hz), s32le (48000 Hz), f32le (8000 Hz), f64le (44100 Hz) and a
  48000 Hz WAV, all with `-cpuflags 0`; outputs are raw f64le and s16le and
  s16/f64 framecrc.
  - 2,220 byte comparisons on every platform: 4 modes × 6 timings (bpm 30 and
    137.5, ms 10 and 777, hz 0.01 and 100) × 3 offset pairs × 3 widths × 5
    sources for amount 0 and 1, plus power-of-two level edges for each mode and
    source.
  - 1,128 byte comparisons on linux-x64 only: the same sweep with amount 0.6,
    plus 4 chains with amount 0.6 or non-power-of-two levels × 3 sources × 4
    outputs.
  - 230 byte comparisons on every platform: 8 chains (apulsator alone,
    shorthand, `asetnsamples=n=7:p=0` before, after and around it, `volume=0.5`
    and `apad=pad_len=9` on both sides, two apulsators) × 4 sources × 7
    outputs including `-ss`/`-t`, `-ss` alone and `-frames:a 2`, 4 whole WAV
    files (s16 and f64), and the 7- and 8-sample groupings, which native
    itself gives identical bytes for.
  - 28 refusals. For each one the test asserts native's exit status, our
    non-zero exit, an apulsator diagnostic and that no output file exists:
    sine in 4 forms, mono and three-channel input, 15 out-of-range values,
    `enable`, an unknown option, 3 syntax errors, a fractional `ms` and an
    expression.

The sandbox reference was built from source: `.build/reference/ffmpeg` sha256
`ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, with
`cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, Node 24.22.3.

## Unsupported

- `mode=sine`, the default (libm `sin()`);
- timeline `enable`, runtime commands, option expressions, suffixes and
  fractional values for `ms`, `mode` and `timing`;
- mono, multichannel and non-default-mask input, which native converts
  implicitly;
- FLAC input;
- non-finite input samples and NaN output;
- automatic sample-rate conversion inside the chain;
- byte-exact claims off linux-x64 for `amount` strictly between 0 and 1.

## Proposed test contracts

| id | file | test title | scope | platforms |
|---|---|---|---|---|
| `filter.apulsator.syntax` | `tests/unit/apulsator.test.ts` | `parses named, shorthand and constant options with native ranges and refuses everything else with exact messages` | parsing and refusal messages | all |
| `filter.apulsator.unit` | `tests/unit/apulsator.test.ts` | `matches a direct C transcription across modes, timings and options, with identical output for 1/7/29/50-sample splits and untouched inputs` | stream arithmetic, persistent phases, ownership | all |
| `filter.apulsator.native` | `tests/differential/apulsator.test.ts` | `matches native bytes for every non-sine mode, bpm/ms/hz timing, offsets and widths with amount 0 and 1 and level edges` | byte equality with exact products | all |
| `filter.apulsator.native-float` | `tests/differential/apulsator.test.ts` | `matches native bytes for every non-sine mode and timing with amount 0.6 on linux-x64` | byte equality with inexact products | linux-x64 |
| `filter.apulsator.chains` | `tests/differential/apulsator.test.ts` | `matches native bytes in composed chains, WAV output and output time selection, independent of asetnsamples grouping` | composed chains and time selection | all |
| `filter.apulsator.refusals` | `tests/differential/apulsator.test.ts` | `fails explicitly before output for sine, non-stereo input, native option errors and unimplemented forms` | explicit refusals with native statuses | all |
