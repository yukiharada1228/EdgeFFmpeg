# adynamicsmooth

`adynamicsmooth` (FFmpeg `libavfilter/af_adynamicsmooth.c`, pinned commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`) applies two-stage dynamic smoothing whose cutoff rises with the difference between the two stages. It is one descriptor, `packages/avfilter/src/audio/adynamicsmooth.ts`, registered by one line in `packages/avfilter/src/audio/registry.ts`. Provenance is in `packages/avfilter/NOTICE-ADYNAMICSMOOTH`.

## Syntax

| Form | Meaning |
|---|---|
| `adynamicsmooth` | `sensitivity=2`, `basefreq=22050` (native defaults) |
| `adynamicsmooth=<sensitivity>[:<basefreq>]` | positional values, in native option order |
| `adynamicsmooth=sensitivity=<v>:basefreq=<v>` | named values, in any order; a positional value may precede named ones |

Values are plain decimals (`2`, `0.75`, `.5`, `7.`). `sensitivity` lies in `[0, 1000000]` and `basefreq` in `[2, 1000000]`, as in native.

Refused before any output is opened, with `AudioFilterError` (`unsupported-filter` on the CLI):

| Input | Message | Native |
|---|---|---|
| a value that is not a plain decimal (`1e3`, `+1`, `-1`, `0x100`, `1k`, expressions, an empty value) | `Unsupported adynamicsmooth <option>: <text>` | accepts most (av_strtod), rejects negatives |
| an out-of-range decimal | `adynamicsmooth <option> <text> is out of range [<low> - <high>]` | rejects |
| `enable=…` (timeline) | `adynamicsmooth timeline enable is not implemented` | accepts |
| an unknown option, a third positional value, a positional value after a named one | `Unsupported adynamicsmooth option: <option>` | rejects |

Runtime commands (`process_command`, `sendcmd`/`asendcmd`) are not available in the audio chain, so the options stay constant.

## Arithmetic

`stream()` keeps `low1`, `low2` and `inz` per channel, zero-initialised, across frames. Per frame it computes `wc = basefreq / sample_rate`; per sample it evaluates, in the C operation order:

```
bandz = low2z - low1z;  wd = wc + sens*|bandz|
g     = fmin(1, wd*(5.9948827 + wd*(-11.969296 + wd*15.959062)))
low1  = low1z + g*(0.5*(x + inz) - low1z)
low2  = low2z + g*(0.5*(low1 + low1z) - low2z);  inz = x;  out = low2
```

JavaScript evaluates every product and sum in IEEE double without contraction, which matches the Linux x86_64 native build bit for bit. Builds that fuse multiply-adds (macOS arm64) differ in the last bits, so the differential tests run only on linux/x64. `fmin`'s NaN rule is kept (`g = 1` for a NaN polynomial). Non-finite input samples are refused (`Non-finite adynamicsmooth input is not yet supported`) instead of following native NaN/Inf propagation. Each output frame is a new `dblp` frame from `convertAudioFrame`; the input frame is never modified.

## Negotiation, constraints, memory

- `formats()` is `['dblp']` (`FILTER_SINGLE_SAMPLEFMT(AV_SAMPLE_FMT_DBLP)`). Every input format (`u8`, `s16`, `s32`, `flt`, `dbl` and their planar forms) negotiates to `dblp`, for every encoder format.
- No constraint: native performs no implicit conversion for any rate, channel count or layout, so every layout name passes `validateInputFormat`.
- Capabilities: `allocatesFrames`; the chain derives `reframes` (stream step) and `rateConversion: false`, so `-ar` after the filter fails with `adynamicsmooth with sample rate conversion is not implemented`. Counts and packet boundaries are unchanged.
- `reserve()`: one frame plus `24 × channels` state bytes (three doubles per channel).
- FLAC input is refused before decoding (`FLAC input to adynamicsmooth requires additional Native evidence`); `flacInput` is not declared.

## Evidence

`tests/unit/adynamicsmooth.test.ts` (7 tests): syntax and exact refusal messages; `negotiatedSampleFormats` for ten input formats × five encoder formats; capabilities and the stream/rate refusals; no constraint, including masked layout names; `planSamples`, `packetSections`, `plannedReservations` and `reservations`; output against a direct transcription of the C loop for seven option pairs × 1-3 channels × four frame splits, bit for bit; ownership, chain processing from packed s16, configured empty input; allocation, channel-count, finiteness and abort limits.

`tests/differential/adynamicsmooth.test.ts` runs `.build/reference/ffmpeg` (FFmpeg 9.0.2, linux x86_64, `-cpuflags 0`) at test time and compares output bytes exactly:

- 540 framecrc comparisons: sensitivity {0, 2, 1000} × basefreq {2, 1000, 22050, 1000000} × u8/s16/s32/f32/f64 input × 1-3 channels × f64/f32/s16 output, 2500 samples per channel at 44100 Hz (several input frames);
- 683 framecrc comparisons: 14 chains (defaults, positional and named options, `asetnsamples` splits before and after, `volume`, `aformat`, `apad`, `adelay`, two smoothers) × s16/f64 input × 1-2 channels × six output selections (`-ss`, `-t`, `-ss`+`-t`, `-to`, `-frames:a`) × two encoders; 9 input-rate and input `-ss`/`-t` cases; 2 empty inputs;
- 30 file comparisons: WAV, AIFF and raw output from raw and WAV input in all five formats;
- 14 refusals, each with native's exit status asserted: 8 that native rejects too, 5 that native accepts (`1e3`, `1k`, `0x100`, two `enable` forms), and `-ar 16000` resampling; none writes output.

The three byte-comparison tests are skipped with a reason outside linux/x64.

## Unsupported

- Option values other than plain decimals; timeline `enable`; runtime commands.
- Non-finite input samples.
- FLAC input.
- Automatic sample-rate conversion after the filter.
- Bit-exactness against natives that fuse multiply-adds (not claimed).

## Test contracts

| Id | File | Test | Scope |
|---|---|---|---|
| `filter.adynamicsmooth.unit.transcription` | `tests/unit/adynamicsmooth.test.ts` | `matches a direct transcription of the C loop bit for bit and is invariant to frame splits` | arithmetic, state across frames |
| `filter.adynamicsmooth.unit.syntax` | `tests/unit/adynamicsmooth.test.ts` | `parses named and positional plain decimals and refuses every other form with exact messages` | syntax |
| `filter.adynamicsmooth.unit.negotiation` | `tests/unit/adynamicsmooth.test.ts` | `negotiates pinned dblp for every input format, reproduces native neighbours and declares its capabilities` | negotiation, capabilities |
| `filter.adynamicsmooth.differential.grid` | `tests/differential/adynamicsmooth.test.ts` | `matches native framecrc bytes for every sensitivity and base frequency on all sources, 1-3 channels and f64/f32/s16 outputs` | linux/x64 native, byte-exact |
| `filter.adynamicsmooth.differential.chains` | `tests/differential/adynamicsmooth.test.ts` | `matches native across composed chains, asetnsamples splits, defaults, positional options and output time selection` | linux/x64 native, byte-exact |
| `filter.adynamicsmooth.differential.files` | `tests/differential/adynamicsmooth.test.ts` | `writes native-identical WAV, AIFF and raw PCM files from WAV and raw inputs` | linux/x64 native, byte-exact |
| `filter.adynamicsmooth.differential.refusals` | `tests/differential/adynamicsmooth.test.ts` | `fails explicitly before output for native errors, unimplemented option forms, timeline enable and rate conversion` | refusals before output |
