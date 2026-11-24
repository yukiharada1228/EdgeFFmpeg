# acopy owned pass-through copy

The bounded linear audio chain accepts the bare token `acopy`. It ports `libavfilter/af_acopy.c` (FFmpeg 9.0.2, commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`): every input frame becomes a new frame whose planes are owned copies of the input planes. Sample values, sample counts, pts, channel layout and sample rate are unchanged. The descriptor is `packages/avfilter/src/audio/acopy.ts`; provenance is in `packages/avfilter/NOTICE-ACOPY`.

```sh
npm run ffmpeg -- --root ./media -- -i /input.wav -af acopy /copy.wav
```

## Syntax

| Form | Result |
|---|---|
| `acopy` (surrounding whitespace trimmed by the chain) | accepted |
| `acopy=1`, `acopy=a=b`, `acopy=1:2` | `AudioFilterError: acopy takes no options: <token>`. Native also refuses `acopy=1` (exit status 234, `No option name near '1'`); the differential test asserts it. |
| `acopy=` | refused with the same message. Native accepts an empty argument list; EdgeFFmpeg refuses it explicitly (scratch probe only, no committed native comparison). |

## Descriptor

- `formats()` is `'all'`, as native (no `FILTER_SAMPLEFMTS`, `AVFILTER_FLAG_METADATA_ONLY`): the step negotiates the input format, or the format its neighbours merge to (for example `flt` before `volume=0.5`). `negotiatedSampleFormats` returns the input for u8, s16, s32, flt, dbl and their planar forms.
- `apply()` is stateless. When the target equals the frame's format it copies each plane into a single new allocation (memcpy only); otherwise the chain-level conversion `convertAudioFrame` produces the owned planes. The input frame is never mutated and no output plane aliases an input buffer.
- Capabilities: `allocatesFrames: true`; `generatesOutput`, `reframes`, `formatConstraint`, `rateConversion` and `timeSelection` false; `flacInput` omitted. `rateBoundary()` with a rate change therefore fails explicitly.
- `reserve()` returns `frameReservation` (one frame, no buffers, no state). No `count()`, so planning, packet sections and buffers are unchanged.
- Limits: the copied frame must fit `maxFrameBytes` (`acopy frame exceeds allocation limit`), and `options.signal` is checked before and between planes.

## Evidence

`tests/unit/acopy.test.ts` (6 tests): syntax and exact refusal messages; capabilities and the rate-conversion refusal; negotiation for every input format and two encoder hints, including `acopy,acopy`, `asetnsamples=7,acopy` and `acopy,volume=0.5`; `planSamples`, `packetSections`, `plannedReservations` and `reservations`; output equal to a transcription of `av_frame_copy` for ten formats and one to three channels, with frame-split invariance through `process()`; ownership and no input mutation; `maxFrameBytes` and `AbortSignal`.

`tests/differential/acopy.test.ts` (4 tests, 991 native comparisons) runs `.build/reference/ffmpeg` at test time, with `-cpuflags 0` everywhere:

- framecrc bytes (270): raw u8/s16le/s32le/f32le/f64le, 1-3 channels, 8000 and 44100 Hz, the native codec and pcm_s16le, chains `acopy`, `acopy,acopy`, `asetnsamples=7,acopy`, `apad=pad_len=9,acopy`, `acopy,volume=0.5`;
- output time selection (210): the same chains with output `-ss`, `-t`, `-ss`+`-t`, `-frames:a 1/3`, a sub-sample `-t` and `-ss`+`-frames:a`, for u8, s16le and f64le, mono and stereo;
- file bytes (510): WAV, AIFF, AU and raw s16le/f32le/f64le from raw and WAV input at 44100 Hz, 1-3 channels;
- refusal (1): `acopy=1` fails before output and native exits with status 234.

Rate and channel count are declared on the input only. Memcpy is platform independent, so every case runs on every platform.

## Unsupported

- Options of any kind, including the native-accepted empty `acopy=`.
- FLAC input: refused before decoding (`FLAC input to acopy requires additional Native evidence`), because `flacInput` is not declared and no FLAC integration or workers test exists.
- Automatic sample-rate conversion across acopy (`rateConversion: false`).
- Three-channel AIFF output is excluded from the file comparisons: it differs from native without any filter (pre-existing AIFF muxer gap, not acopy-specific).

## Proposed test contracts

| File | Test title | Scope |
|---|---|---|
| `tests/unit/acopy.test.ts` | accepts only the bare acopy token and refuses every option form with an exact message | syntax |
| `tests/unit/acopy.test.ts` | returns owned planes byte-equal to a transcription of av_frame_copy, without mutating the input, at any frame split | execution, ownership |
| `tests/unit/acopy.test.ts` | enforces maxFrameBytes and observes AbortSignal | limits |
| `tests/differential/acopy.test.ts` | matches native framecrc bytes across raw formats, channel counts, rates and composed chains | native framecrc |
| `tests/differential/acopy.test.ts` | matches native output time selection and frame limits after acopy | native time selection |
| `tests/differential/acopy.test.ts` | writes native-identical WAV, AIFF, AU and raw PCM files from WAV and raw inputs | native files |
| `tests/differential/acopy.test.ts` | fails before output for acopy options, which native also refuses | native refusal |
