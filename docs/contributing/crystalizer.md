# crystalizer

`crystalizer` ([libavfilter/af_crystalizer.c](../../upstream/ffmpeg/libavfilter/af_crystalizer.c), FFmpeg 9.0.2) is a simple audio noise sharpening filter. It applies a per-channel sample-difference recurrence. It is registered as one descriptor, `packages/avfilter/src/audio/crystalizer.ts`, plus one line in `packages/avfilter/src/audio/registry.ts`. Provenance is in `packages/avfilter/NOTICE-CRYSTALIZER`.

## Syntax

| Form | Meaning |
|---|---|
| `crystalizer` | `i=2`, `c=1` |
| `crystalizer=<i>[:<c>]` | positional intensity, then clipping |
| `crystalizer=i=<i>:c=<c>` | named, in any order; a repeated option keeps the last value |

- `i` is a plain decimal literal (sign, fraction and exponent allowed) in `[-10, 10]`. The range is checked on the double, and the value is then stored as float32, as `set_string_number`/`write_number` do.
- `c` accepts `true,y,yes,enable,enabled,on` / `false,n,no,disable,disabled,off` (any case), or a whole decimal `0`/`1` with an optional sign, as `set_string_bool` does.

Refused before any output is opened (`unsupported-filter`), with the messages pinned in `tests/unit/crystalizer.test.ts`:

| Input | Message | Native |
|---|---|---|
| `i` out of range (`11`, `-10.0001`) | `crystalizer intensity <v> out of range [-10 - 10]` | fails |
| `i` expressions, SI suffixes, `nan`, empty (`1+1`, `1k`) | `Only constant numeric crystalizer intensity is implemented` | `1+1` runs; `1k` fails (out of range) |
| `c` other values (`2`, `auto`) | `Unsupported crystalizer clipping value: <v>` | fails |
| a third positional value | `Too many crystalizer options` | fails |
| a positional value after a named one | `crystalizer positional option after a named option: <v>` | fails |
| `enable=` (timeline) | `crystalizer timeline enable is not implemented` | runs |
| any other option name | `Unsupported crystalizer option: <name>` | fails |
| quotes or backslashes | `Quoted or escaped crystalizer options are not implemented` | n/a |

Runtime commands (`process_command`) are not reachable from the bounded chain. FLAC input is refused before decoding (`FLAC input to crystalizer requires additional Native evidence`), because the descriptor does not declare `flacInput`. Automatic sample-rate conversion after the chain is refused (`crystalizer with sample rate conversion is not implemented`), as for every native-list step.

## Arithmetic

With `mult` the float32 intensity, promoted to double on the double paths:

- `mult >= 0` (including `-0`), the forward filter: `dst = cur + (cur - prev) * mult; prev = cur`.
- `mult < 0`, the inverse filter: `dst = (cur - prev * mult) * scale; prev = dst`, where `scale = 1 / (-mult + 1)`. `prev` takes the value before clipping.
- With `c=1`, `dst = FFMIN(FFMAX(dst, -1), 1)`, so NaN becomes `-1`.

`prev` starts at zero for every channel (`ff_get_audio_buffer` silences it) and carries across frames. The float paths round once per C operation with `Math.fround`, and the double paths use plain IEEE double arithmetic. Channels are independent, so the result does not depend on the thread count, the frame split, or whether the layout is packed or planar.

The step is a `stream` hook. It converts each frame to its negotiated format into an owned copy and filters that copy in place. It reserves one output frame plus `8 × channels` state bytes for the `Float64Array` that holds `prev`. It checks `options.signal` on every frame and every 4096 samples, and it refuses a channel count change between frames.

## Negotiation

`formats()` returns the native list `['flt','fltp','dbl','dblp']`. The shared chain picks the format (see [audio-filter-registry.md](audio-filter-registry.md#sample-format-negotiation)):

| Input | s16/s32/u8 output | flt output | dbl output |
|---|---|---|---|
| u8, s16, s32 | flt | flt | dbl |
| flt | flt | flt | flt |
| dbl | dbl | dbl | dbl |
| u8p, s16p, s32p | fltp | – | – |
| fltp / dblp | fltp / dblp | – | – |

Planar input therefore stays planar, for example after `aformat=f=fltp` or `aformat=f=dblp`. Some neighbour combinations are refused by the shared guard (`crystalizer with <fmt> input requires unimplemented format negotiation`), because the chain cannot reproduce native's merge for them: `crystalizer,volume=0.25:precision=double` on f32 input, `crystalizer,volume=0.25` on f64 input, and the input-trim cases described in the registry guide.

## Evidence

The reference is `.build/reference/ffmpeg`, built from the pinned commit for Linux x86-64 (sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`). The byte comparisons are gated to `linux`/`x64`, where the float evidence was taken. macOS arm64 contracts the inverse recurrence into FMA, and its results differ.

`tests/differential/crystalizer.test.ts` makes 606 native comparisons, all exact:

- 450 framecrc comparisons: every `i ∈ {-10,-3,0,2,10}` × `c ∈ {0,1}`, packed and through `aformat=f=fltp` / `aformat=f=dblp`, on u8/s16/s32/f32/f64 stereo sources of 2600 samples (several frames), into pcm_f32le, pcm_f64le and pcm_s16le, with `-cpuflags 0`.
- 132 framecrc comparisons: mono and three-channel s16/f32/f64 input of 3001 samples with 11 chains, into the source codec and pcm_s16le. The chains include `asetnsamples` splits before and after the filter (1, 7 and 13 samples, padded and unpadded), `i=2.5`, two crystalizers in series, `volume` before it, `aformat=f=dbl … aformat=f=s16` and `apad`.
- 13 comparisons: output `-ss`, `-t`, `-to` and `-frames:a`, compared as framecrc, plus WAV input to WAV f32, WAV s16 and raw f64 files compared byte for byte.
- 11 refusal checks: for 10 rejected options and the guard case, native's exit status is asserted (as in the table above), and the edge run fails with no output file created.

`tests/unit/crystalizer.test.ts` holds 6 tests:

- syntax and exact messages;
- negotiation for all ten input formats and three encoder hints, plus `requiresScalarRounding`;
- `planSamples`, `packetSections` and `plannedReservations`;
- 336 comparisons against a `Float32Array`/`Float64Array` transcription of the C macro, covering 4 formats × 7 option sets × 1–3 channels × 4 frame splits;
- ownership, the allocation limit, cancellation and an empty configured input.

## Scoped test contracts

| File | Test | Scope |
|---|---|---|
| tests/differential/crystalizer.test.ts | matches native framecrc for i {-10,-3,0,2,10} x c {0,1}, packed and planar, on every source into f32, f64 and s16 | linux x64 native, byte-exact |
| tests/differential/crystalizer.test.ts | matches native across channel counts, multi-frame input, asetnsamples splits and composed chains | linux x64 native, byte-exact |
| tests/differential/crystalizer.test.ts | matches native output time selection, frame limits and WAV/raw files | linux x64 native, byte-exact |
| tests/differential/crystalizer.test.ts | fails every unimplemented form before opening output, and records native status for each | all platforms |
| tests/unit/crystalizer.test.ts | matches a direct C transcription for forward and inverse recurrences, packed and planar, with state carried across arbitrary frame splits | unit |

## Unsupported

- Option expressions, SI suffixes, quoted values, timeline `enable` and runtime commands.
- FLAC input, which has no integration or workers evidence.
- Automatic sample-rate conversion after the filter, and the neighbour negotiations that the shared guard refuses.
- Platforms other than Linux x86-64 have no byte-exact claim.
