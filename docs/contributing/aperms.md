# aperms

`aperms` (libavfilter/f_perms.c, `CONFIG_APERMS_FILTER`) changes only whether
the output frame is writable. Native never changes samples, counts, layouts or
timestamps, so the descriptor in `packages/avfilter/src/audio/aperms.ts` is the
identity: `apply` returns the validated input frame itself, allocates nothing and
reserves nothing. Provenance is in `packages/avfilter/NOTICE-APERMS`.

## Syntax

| Form | Result |
|---|---|
| `aperms` | mode `none` |
| `aperms=<mode>`, `aperms=mode=<mode>` | `<mode>` is `none`, `ro`, `rw`, `toggle` or `random` |
| `aperms=<mode>:<seed>`, `aperms=mode=<mode>:seed=<seed>` | the AVOption order is mode, then seed; named options may follow positional ones, and a repeated option keeps its last value |
| `seed=<n>` | decimal `-1` or `0`..`4294967295`, no leading zeros |

`mode=random` requires an explicit seed. Native's default `seed=-1` draws one
from `av_get_random_seed`. Because frame data is the same for every seed, this is
refused only because it is nondeterministic. `seed=-1` with any other mode is
accepted; the seed has no effect there.

Refused before any output is written, each with an `AudioFilterError`. On the CLI the code is `unsupported-filter`.

| Input | Message | Native |
|---|---|---|
| `aperms=random`, `aperms=mode=random:seed=-1` | `aperms random mode requires an explicit seed` | succeeds (intentional refusal) |
| `seed=-2`, `seed=4294967296`, `seed=07`, `seed=0x7` | `Invalid aperms seed: <value>` | fails for out-of-range values |
| `mode=bogus`, `mode=1`, `mode=RO`, `mode=ro+rw` | `Unsupported aperms mode: <value>` | fails for `bogus`; numeric and expression modes succeed but are not implemented |
| `enable=…` and any other option name | `Unsupported aperms option: <name>` | `enable` (generic timeline) succeeds; unknown names fail |
| a third positional value, a positional value after a named one, `a=b=c` | `Invalid aperms option` | fails |

Runtime commands (`process_command`) are not implemented: the audio chain has no
command path, so no command reaches the step.

## Planning and negotiation

- All declared capabilities are false: `generatesOutput`, `reframes`,
  `allocatesFrames`, `formatConstraint`, `rateConversion` and `timeSelection`.
  `flacInput` is not declared.
- `formats()` is omitted (`'all'`), so the step works in its input format:
  `negotiatedSampleFormats(f)` is `[f]` for all ten packed and planar formats.
  The chain picks the merged format exactly as it does for `anull`.
- There are no count, packet or buffer effects. `planSamples`, `packetSections`
  and `outputPacketSamples` pass through unchanged, and `reserve()` is omitted, so
  both planners see `{frames:0,buffers:[],stateBytes:0n}`.
- Because `rateConversion` is false, `rateBoundary()` refuses resampling across
  the step with `aperms with sample rate conversion is not implemented`. Native
  accepts `-af aperms -ar 16000`.
- FLAC input is refused before decoding with `FLAC input to aperms requires
  additional Native evidence`. No FLAC support is claimed.

## Evidence

Native reference: FFmpeg 9.0.2 built by `npm run reference:build` on Linux
x86_64 (`.build/reference/ffmpeg`). Every case below runs at test time.

- `tests/differential/aperms.test.ts`
  - `matches native framecrc for every aperms mode and seed on u8 s16 s32 f32 f64 mono and stereo, alone and chained`:
    400 framecrc comparisons. They cover 5 raw formats × 1-2 channels × 8 mode forms (`aperms`, `none`, `ro`, `rw`, `toggle`, and `random` with seeds 0, 7 and 4294967295) × 5 chains: alone, `,volume=0.5`, `asetnsamples=5,` before it, `,apad=pad_len=3`, and a combined `aperms=toggle,…,asetnsamples=5,apad=pad_len=3`. All use `-cpuflags 0`.
  - `writes native-identical WAV and raw PCM files from WAV and raw inputs`:
    480 byte-for-byte file comparisons. They cover 5 formats × 1-2 channels × raw and WAV input × 4 modes × 3 chains × WAV and raw output.
  - `fails explicitly before output for native errors and the unseeded random mode native accepts`:
    10 refusals, each with native's exit status asserted, plus the resampling refusal.
- `tests/unit/aperms.test.ts`: parsing and exact messages, capabilities,
  negotiation for all ten formats, planning and reservations, constraints
  (including masked WAV layouts, which are accepted), identity and ownership
  across frame splits, allocation limits and abort.

The data is the same for every mode, including `random` with any seed. None of
the cases is float-sensitive: `volume=0.5` uses `-cpuflags 0` on both sides.

## Test contracts

| File | Test title | Scope |
|---|---|---|
| tests/differential/aperms.test.ts | matches native framecrc for every aperms mode and seed on u8 s16 s32 f32 f64 mono and stereo, alone and chained | PCM CLI framecrc |
| tests/differential/aperms.test.ts | writes native-identical WAV and raw PCM files from WAV and raw inputs | PCM CLI WAV/raw files |
| tests/differential/aperms.test.ts | fails explicitly before output for native errors and the unseeded random mode native accepts | refusals |
| tests/unit/aperms.test.ts | returns every input frame unchanged with its own planes, for every mode, format, channel count and frame split | chain apply/process |

## Unsupported

These are refused, never approximated: `mode=random` without an explicit seed,
numeric and expression mode values, `enable`, runtime commands, FLAC input,
and automatic sample-rate conversion across the step. Frame writability is
not modelled, because frames here carry no permission flag.
