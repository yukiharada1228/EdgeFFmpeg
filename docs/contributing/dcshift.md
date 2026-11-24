# dcshift

`dcshift` adds a constant DC offset to every sample, with an optional limiter
(`libavfilter/af_dcshift.c`, FFmpeg 9.0.2). Provenance is in
`packages/avfilter/NOTICE-DCSHIFT`.

## Syntax

| Form | Meaning |
|---|---|
| `dcshift` | shift 0, no limiter |
| `dcshift=<shift>` / `dcshift=<shift>:<limitergain>` | positional |
| `dcshift=shift=<v>:limitergain=<v>` | named, any order; a later value overrides an earlier one, as in native |

- `shift` is in [-1, 1] and `limitergain` in [0, 1]. Values are plain decimal
  literals (`0.3`, `-.7`, `1e-1`). Out-of-range values fail with
  `dcshift <option> must be between <low> and <high>`. Native fails too.
- Expressions (`0.1+0.1`, `PI/10`), suffixes (`0.5dB`, `1k`), `nan` and empty
  values fail with `Only constant decimal dcshift <option> values are implemented`.
  Native evaluates these. They are refused, not approximated.
- Timeline `enable`, a third positional value, a positional value after a named one,
  and unknown options fail with `Unsupported dcshift option: <option>`. Runtime
  commands are not supported.

Every refusal is an `AudioFilterError` raised while the chain compiles, so on the CLI
it becomes `unsupported-filter` before any output is opened.

## Arithmetic

The filter works in `s32p` (`FILTER_SINGLE_SAMPLEFMT`), so `formats()` is `['s32p']`. Every input format negotiates to `s32p`
through the registry's native-list model. Each sample `x` is computed in IEEE double:

- `limitergain == 0`: `d = shift*(INT32_MAX+1) + x`.
- `limitergain > 0`: `threshold = INT32_MAX*(1-(|shift|-limitergain))`, then
  - `x > threshold && shift > 0`: `(x-threshold)*limitergain/(INT32_MAX-threshold) + threshold + shift`;
  - `x < -threshold && shift < 0`: `(x+threshold)*limitergain/(INT32_MAX-threshold) - threshold + shift`;
  - otherwise `shift*INT32_MAX + x`.

  As in native, both limiter branches add the raw, unscaled shift, and the else
  branch scales by `INT32_MAX`, not `INT32_MAX+1`.
- `d` is truncated to int64 and clipped to int32 (`av_clipl_int32`). A non-finite or
  out-of-range `d` becomes INT32_MIN, because x86-64 converts it to INT64_MIN. Only
  `shift=-1:limitergain=1` reaches this case: INT32_MIN input divides by zero there.

`apply` is stateless. It converts to an owned `s32p` copy and never mutates its input.
Capabilities: `allocatesFrames` only. `reserve()` is `frameReservation`. Counts and
packets are unchanged.

## Unsupported

- FLAC input is refused before decoding (`FLAC input to dcshift requires additional Native evidence`).
  `flacInput` is not declared.
- Automatic sample-rate conversion around dcshift (`dcshift with sample rate conversion is not implemented`).
- Expressions, suffixes, `enable` and commands (see above).
- Merges that the registry's negotiation guard cannot reproduce. Fixed `volume` before
  dcshift on u8/s16 input fails with `dcshift with <fmt> input requires unimplemented format negotiation`.

## Evidence

`tests/differential/dcshift.test.ts` runs `.build/reference/ffmpeg` (FFmpeg 9.0.2, Linux x86_64) at test time:

- **`matches native dcshift s32 raw, s32 WAV, s16 WAV and framecrc bytes for every shift and limiter gain on integer and float sources`**:
  300 byte comparisons. They cover shift {0, 0.3, -0.7, 1, -1} × limitergain {0, 0.4, 1} on stereo u8, s16 and s32
  sources, with extremes (INT_MIN, INT_MAX) and values near the limiter thresholds, and on f32/f64 sources with
  |x| ≤ 1.1 (`-cpuflags 0`). Outputs are s32le raw, s32 WAV, s16 WAV (s32p-to-s16 truncation) and framecrc.
  Float sources run only on linux x64.
- **`matches native dcshift chains with volume and asetnsamples, named options, mono and three-channel input and output time selection`**:
  840 framecrc comparisons. They cover 7 chains (with `volume=0.5`, fixed volume after dcshift, `asetnsamples=7`, named options and two
  dcshifts) × mono and three-channel input × 5 sources × 4 output selections (`-ss`/`-t`, `-frames:a`, a short `-t`) × s32, s16 and f64 output.
- **`refuses out-of-range options, expressions, enable and unknown options before writing output, where native also fails or accepts unimplemented forms`**:
  11 refusals checked against native's exit status, with no output written.

The 300 and 840 counts hold on linux/x64 only. On any other host the test drops
the f32 and f64 sources from both comparison tests and reports no skip. The tests
then make 180 and 504 comparisons and still pass. That happened in the wave 1
integration run on the macOS arm64 reference. The full counts ran on Linux CI
(run 45402980700).

Mutating either native quirk (the `INT32_MAX` scale of the else branch, or the raw shift in the limiter branches) fails the first test.

`tests/unit/dcshift.test.ts` (6 tests) covers:

- syntax and its exact messages;
- capabilities, planning and reservations;
- negotiation to `s32p` for every input and output format;
- a C transcription across all branches, threshold edges and clips, including the -∞ case, with a bigint model for dyadic shifts;
- frame-split invariance, conversion from u8/s16/flt/dbl, ownership, allocation limits and cancellation.
