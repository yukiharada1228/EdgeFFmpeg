# stereotools

The bounded linear audio chain accepts `stereotools` and `stereotools=<options>`, adapted from `libavfilter/af_stereotools.c` at the pinned commit `946fcce0` (provenance in `packages/avfilter/NOTICE-STEREOTOOLS`). It runs on the PCM CLI paths (WAV, AIFF, AU, W64, raw PCM, framecrc) and through `AudioFilterChain.process`. FLAC input is refused before decoding with `FLAC input to stereotools requires additional Native evidence`; `flacInput` is not declared.

```sh
npm run ffmpeg -- --root ./media -- -i /input.wav -af 'stereotools=mode=ms>lr:delay=-3:base=0.2' -c:a pcm_f64le /out.wav
```

## Options

All 20 native options, with native names, defaults and ranges:

| Option | Type | Default | Range |
|---|---|---|---|
| `level_in`, `level_out`, `slev`, `mlev` | double | 1 | 0.015625–64 |
| `balance_in`, `balance_out`, `sbal`, `mpan`, `base` | double | 0 | -1–1 |
| `softclip` | bool | 0 | only 0 implemented |
| `mutel`, `muter`, `phasel`, `phaser` | bool | 0 | |
| `mode` | `lr>lr`, `lr>ms`, `ms>lr`, `lr>ll`, `lr>rr`, `lr>l+r`, `lr>rl`, `ms>ll`, `ms>rr`, `ms>rl`, `lr>l-r` or 0–10 | `lr>lr` | |
| `delay` | double, ms | 0 | -20–20 |
| `sclevel` | double | 1 | 1–100 (accepted; no effect without softclip) |
| `phase` | double, degrees | 0 | 0–360, only 0 implemented |
| `bmode_in`, `bmode_out` | `balance`, `amplitude`, `power` or 0–2 | `balance` | |

Options are `:`-separated `key=value` pairs. As in libavfilter, values without a key fill the options positionally in declaration order (the table order of `af_stereotools.c`, CONST entries skipped: `level_in`, `level_out`, `balance_in`, `balance_out`, `softclip`, `mutel`, `muter`, `phasel`, `phaser`, `mode`, `slev`, `sbal`, `mlev`, `mpan`, `base`, `delay`, `sclevel`, `phase`, `bmode_in`, `bmode_out`) until the first named option. A repeated option takes its last value. Constant names are case-sensitive, as `av_opt_find` is.

Refused before any output is opened (`unsupported-filter`), each with a `stereotools` message:

- Unimplemented libm arithmetic, which native runs: `softclip=1` (`atan`) gives `stereotools softclip requires unimplemented libm arithmetic`; any `phase` other than 0 (`cos`/`sin`) gives `stereotools phase requires unimplemented libm arithmetic`. With `phase=0`, `cos(0)=1` and `sin(0)=0` exactly, so the rotation is transcribed literally as `L*1 - R*0` and `L*0 + R*1` (which normalises some signed zeros, exactly as native does).
- Native refuses these too: an out-of-range value (`Value <v> for stereotools option <name> out of range [<min> - <max>]`, native exit `256-ERANGE`), a boolean outside 0/1 or `auto`, an unknown mode name such as `LR>LR` (exit `256-EINVAL`), an unknown option (exit 8), a positional value after a named one and a 21st positional value (exit `256-EINVAL`).
- Native accepts these, but they are unimplemented: `enable=` (`stereotools timeline enable is not implemented`; native supports timeline internally), expressions and SI suffixes (`1+1`), fractional `mode`/`bmode` values (native rounds them), and quoting and escaping. Runtime commands are not accepted by the chain.
- Inputs native would remix implicitly: mono, three or more channels, and two-channel WAV/W64 input with a non-default mask. The constraint accepts only `channels === 2 && channelLayout === 'stereo'` and fails with `stereotools requires stereo input; <layout> would be remixed implicitly`. Native exits 0 for mono and 3-channel input.
- At run time: non-finite input samples (`Non-finite stereotools input is not yet supported`) and NaN results from finite overflow (`NaN stereotools output is not yet supported`), because the sign of a generated NaN is the host's default NaN. Integer inputs never reach either.

## Execution

`formats()` is native's `['dbl']`: every input format negotiates packed `dbl` (`negotiatedSampleFormats` gives `['dbl']` for u8, s16, s32, flt, dbl and their planar forms) and the encoder converts afterwards; integer outputs need scalar rounding (`-cpuflags 0` in the differential tests). stereotools is a stream step: it reframes, allocates one output frame per input frame and keeps config_input's ring and `pos` across frames. Sample counts, frame sizes and timestamps are unchanged; it declares no `count()`.

The ring is `FFALIGN((sample_rate + 9) / 10, 2)` doubles (800 at 8000 Hz, 4410 at 44100 Hz), zero-initialised and allocated whatever the delay, as native does. `nbuf = (int)(sample_rate * (fabs(delay) / 1000.))`, rounded down to even. The per-sample loop follows `filter_frame` in order: input level, input balance per `bmode_in`, the mode matrix, mute, phase inversion, the ring write, the delayed read (`R` from `pos - nbuf + 1` for a positive delay, `L` from `pos - nbuf` for a negative one), the base `L + sb*L - sb*R` with `sb = base < 0 ? base*0.5 : base`, the identity rotation, `pos += 2`, output balance per `bmode_out`, and output level. No step is fused. `reserve()` declares one frame plus the ring as `stateBytes` (`length * 8`). `process` refuses a ring larger than `maxFrameBytes` (`stereotools delay buffer exceeds allocation limit`) and a sample-rate change between frames, and observes `options.signal`.

## Determinism

Once `phase=0` the filter is pure IEEE double arithmetic with no libm calls. macOS clang contracts the mode 0/2/6/7/8/9 mixes (`m*mlev*… + S*slev*…`) and the base (`L + sb*L - sb*R`) into FMA, so cases with non-default levels, base or balance run only on linux/x64 (gated as a precaution; no macOS difference was measured in this sandbox). Copy-like cases run on every platform: default levels (every mix product is by 1 and every base product by 0, so contraction cannot change a result) in every mode, mute, phase inversion and delay.

## Evidence

- `tests/unit/stereotools.test.ts` (5 tests): exact parse results and 31 refusal messages; ring length and `nbuf` truncation; negotiation for every input format and `requiresScalarRounding`; constraint refusals including a masked layout name; `planSamples`, `packetSections`, `plannedReservations` and `reservations`; output equal to a direct transcription of the C loop for 54 option sets at 100/8000/44100 Hz under whole, 1-, 7-, 29- and 50-sample splits (810 comparisons, `Object.is` per sample), s16 input conversion, an unaligned plane, input ownership, non-finite refusals, allocation limits, configured empty input and cancellation.
- `tests/differential/stereotools.test.ts` (5 tests) against `.build/reference/ffmpeg` (asserts commit `946fcce0` and `--disable-x86asm` from `build-metadata.json`):
  - 364 raw byte comparisons (all platforms): 26 copy-like chains (all 11 modes by name and number, mute, phase inversion, delays -20/-3/0/3/20 ms and more) at 8000/44100 Hz from u8/s16/s32/f32/f64 input into f64, plus s16 and f32 output for s16 input;
  - 532 raw byte comparisons (linux/x64): 38 float-sensitive chains (every mode with non-default slev/sbal/mlev/mpan, bmode_in/out × balance -1/-0.4/0/0.4/1, level/side/middle edges, base ±1, delays with base, the 20-value positional form), same sources and outputs;
  - 302 comparisons (all platforms) and 151 (linux/x64): WAV, raw and framecrc outputs from s16 raw at 8000 Hz, f64 raw at 44100 Hz and WAV input; chains alone, after `asetnsamples=n=7:p=0`, `asetnsamples=7`, `asetnsamples=n=50:p=0` (a 20 ms delay longer than a frame), `volume=0.5` before and after and `apad`; output `-ss`, `-t`, `-ss`+`-t` and `-frames:a`; plus native-only probes that native output at 1/7/29/50-sample grouping equals whole frames;
  - 31 refusals with native's exit status beside ours (non-zero, nothing written, exact message).
- Sandbox reference: `.build/reference/ffmpeg` sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c` (unpinned sandbox build), `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`.

## Proposed contracts

| id | file | test title | scope | platforms |
|---|---|---|---|---|
| `filter.stereotools.native-raw` | `tests/differential/stereotools.test.ts` | matches native PCM bytes for every mode at default levels, mute, phase inversion and delay at 8000/44100 Hz from every source format | raw PCM bytes vs native for copy-like options | all |
| `filter.stereotools.native-raw-float` | `tests/differential/stereotools.test.ts` | matches native PCM bytes for non-default levels, side and middle balance, base, balance modes and delay with base (linux/x64) | raw PCM bytes vs native for float-sensitive options | linux-x64 |
| `filter.stereotools.native-outputs` | `tests/differential/stereotools.test.ts` | matches native WAV, raw and framecrc for copy-like options across frame splits, volume, apad, WAV input and output selection | WAV/raw/framecrc vs native, frame splits, neighbours, output selection | all |
| `filter.stereotools.native-outputs-float` | `tests/differential/stereotools.test.ts` | matches native WAV, raw and framecrc for float-sensitive options across frame splits, volume, apad, WAV input and output selection (linux/x64) | same with float-sensitive options | linux-x64 |
| `filter.stereotools.native-refusals` | `tests/differential/stereotools.test.ts` | refuses softclip, phase, mono, out-of-range, unimplemented and enable= forms before output, beside native status | explicit refusals before output beside native exit status | all |
| `filter.stereotools.unit` | `tests/unit/stereotools.test.ts` | matches a transcription of the C loop for every mode and option family, identical for 1/7/29/50-sample splits, without touching its input | C-loop transcription, frame-split independence, ownership | all |

## Unsupported

`softclip=1`; `phase` other than 0; FLAC input; expressions, SI suffixes and other non-literal values; fractional integer options; quoting/escaping; `enable`; runtime commands; automatic sample-rate conversion next to stereotools; non-stereo input; non-finite input samples and NaN results.
