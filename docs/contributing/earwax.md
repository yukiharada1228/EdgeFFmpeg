# earwax headphone FIR

The bounded linear audio chain accepts `earwax`, the stereo widening filter of FFmpeg `libavfilter/af_earwax.c`. It is complete for its scoped form on the WAV, raw PCM and framecrc CLI paths and the `process()` stream API. AU, AIFF and W64 output share the same path but have no native comparison. FLAC input is refused.

```sh
npm run ffmpeg -- --root ./media -- -i /input.wav -af earwax /wide.wav
```

## Syntax

Only the bare token `earwax` is accepted. Native earwax has no options, timeline support or commands, and native rejects every `earwax=…` form too. EdgeFFmpeg refuses them while compiling, with `Unsupported earwax option` (for example `earwax=1`, `earwax=enable=1`). Other names that start with `earwax` fail with `Unsupported audio filter: <token>`.

## Constraints

Native `query_formats` pins s16p, the stereo layout and 44100 Hz, and silently inserts `aresample` and a remix for anything else. EdgeFFmpeg refuses those inputs explicitly before any output is opened, with `earwax requires stereo 44100 Hz input`:

- any channel count other than 2;
- a two-channel layout other than `stereo`, including a WAV/W64 `WAVEFORMATEXTENSIBLE` mask that is not FL+FR (`2 channels (FL+FC)`, `downmix`, …);
- any rate other than 44100 Hz at earwax's position (a preceding `asetrate` applies).

## Negotiation

`formats()` is the native list `['s16p']`. Every input format negotiates to `s16p`:

| Input | u8 | s16 | s32 | flt | dbl |
|---|---|---|---|---|---|
| earwax works in | s16p | s16p | s16p | s16p | s16p |

Float input converts to s16 through scalar rounding (`requiresScalarRounding` is true), so native comparisons with float sources use `-cpuflags 0`. Integer input converts to s16 with the shared converter; the differential test matches native for u8 and s32 sources. Output is `s16p`; later steps and the encoder convert from it.

## Arithmetic

Integer only, frame-size independent:

- The 64-entry int8 table is split into filter 0 (even entries, 30°) and filter 1 (odd entries, 330°).
- Each input channel keeps 32 samples of history in the native `taps[2*NUMTAPS]` layout. Frames shorter than 32 samples follow the native `memmove` path.
- `scalarproduct`: output `i` is the int32 sum over `j < 32` of `x[i - 32 + j] * filter[j]`, shifted right by 7 and clipped to int16. History starts at zero.
- The four convolutions are (input 0, filter 0), (input 0, filter 1), (input 1, filter 0), (input 1, filter 1). `mix()` then gives `out0 = clip16(in0·f1 + in1·f0)` and `out1 = clip16(in0·f0 + in1·f1)`.

Output frames keep the input sample count and timestamps. There is no tail. The output overwrites the owned converted frame in place, from the last sample backwards.

## Capabilities and memory

`generatesOutput: false`, `reframes: true` (cross-frame state; a stream step reframes anyway), `allocatesFrames: true`, `formatConstraint`, `rateConversion` and `timeSelection` false, and no `flacInput`. `reserve()` declares one frame plus 256 state bytes: one 64-sample s16 history for each of the two input channels. It does not declare the per-frame copies. Each frame's two converted planes are also copied into `Int16Array`s (2 bytes per sample per channel), and those copies stay resident across the `yield`. This gap was found in the wave 1 integration review and is not fixed.

## Evidence

`tests/differential/earwax.test.ts` runs the pinned native build (`.build/reference/ffmpeg`) at test time and compares bytes exactly:

- 160 comparisons: stereo 44100 Hz u8, s16, s32 and f32 raw sources (all with `-cpuflags 0`), loud enough to clip, crossed with 8 chains (`earwax`, `asetnsamples=5,earwax`, `asetnsamples=31:p=0,earwax`, `asetnsamples=33,earwax,asetnsamples=7`, `earwax,apad=pad_len=9`, `volume=0.5,earwax`, `earwax,earwax`, `anull,earwax,volume=2`) and 5 outputs (s16 WAV, s32 WAV, raw s16le, s16 and s32 framecrc);
- 12 framecrc comparisons with input `-ss`/`-t` and output `-ss`/`-t`/`-to`/`-frames:a`;
- refusals: mono, three-channel, 48000 Hz and 8000 Hz mono input, where native exits 0 through auto-resampling and EdgeFFmpeg fails before creating output; `earwax=1` and `earwax=enable=1`, which native rejects too.

`tests/unit/earwax.test.ts` covers syntax refusals, negotiation for u8/s16/s32/flt/dbl, capabilities, `planSamples`, `packetSections`, `plannedReservations` and `reservations`, constraint refusals (including masked layouts and `asetrate`), output against a naive whole-signal FIR over 24 random frame splits (packed and planar, with and without saturation), input ownership, allocation limits, cancellation and configured empty input.

## Test contracts

| File | Test title | Scope |
|---|---|---|
| tests/differential/earwax.test.ts | matches native WAV, raw and framecrc bytes for stereo 44100 Hz u8, s16, s32 and f32 sources and composed chains | native byte equality, linux x64 reference |
| tests/differential/earwax.test.ts | matches native output time selection and frame limits after the cross-frame history | native framecrc equality |
| tests/differential/earwax.test.ts | refuses mono, three-channel and 48000 Hz input before output where native converts implicitly, and refuses options native rejects | explicit refusals with native status |
| tests/unit/earwax.test.ts | matches a naive whole-signal FIR across random frame splits, packed and planar input, and saturates like native | arithmetic and frame-split invariance |

## Unsupported

- Inputs native converts implicitly (non-stereo, non-default two-channel masks, rates other than 44100 Hz): refused, not converted.
- Any option, `enable` or runtime command: refused (native has none).
- FLAC input: refused before decoding with `FLAC input to earwax requires additional Native evidence`.
- Automatic sample-rate conversion around earwax (`rateBoundary`): refused.
