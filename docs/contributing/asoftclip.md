# Audio soft clipper (asoftclip)

`asoftclip` (`libavfilter/af_asoftclip.c`) is implemented for `type=hard` and `type=alg` without oversampling. The descriptor is `packages/avfilter/src/audio/asoftclip.ts`; provenance is in `packages/avfilter/NOTICE-ASOFTCLIP`.

## Syntax

Options are named (`type`, `threshold`, `output`, `param`, `oversample`) or positional in that order; positional values must come before named ones, and a repeated option keeps its last value.

| Option | Accepted | Default |
|---|---|---|
| `type` | `hard`, `alg` | native default `tanh`, so a bare `asoftclip` is refused |
| `threshold` | plain decimal in 0.000001..1 | 1 |
| `output` | plain decimal in 0.000001..16 | 1 |
| `param` | plain decimal in 0.01..3 (used by `alg` only) | 1 |
| `oversample` | `1` | 1 |

```sh
npm run ffmpeg -- --root ./media -- -cpuflags 0 -i /input.wav -af asoftclip=type=hard:threshold=0.5:output=1.3 /clipped.wav
```

Refused before any output is opened (CLI diagnostic `unsupported-filter`), each with an exact `AudioFilterError` message:

- `tanh`, `atan`, `cubic`, `exp`, `quintic`, `sin`, `erf`: `asoftclip type <type> requires unimplemented libm arithmetic`. They call `tanhf`, `atanf`, `powf`, `expf`, `sinf` and `erff`, whose results depend on the C library.
- `oversample` greater than 1: `asoftclip oversample <n> requires its unimplemented sin/cos lowpass` (`get_lowpass` designs the filter with `sin`/`cos`). At `oversample=1` that lowpass never touches samples.
- integer type values (`-1`, `4`), expressions and other names: `Unsupported asoftclip type: <value>`.
- values with exponents, suffixes or expressions (`1e-3`, `1k`): `Only plain decimal asoftclip <option> values are implemented: <value>`. Out-of-range values: `asoftclip <option> <value> is outside <min>..<max>`. Native also fails on these.
- `enable` (timeline) and runtime commands, and unknown options.
- non-finite input samples (`Non-finite asoftclip input is not yet supported`), and an `alg` input that overflows to infinity once multiplied by `1/threshold`, where native would write a NaN.

## Negotiation

`formats()` is the native list `['fltp','dblp']`. The chain's native negotiation model gives:

| Input | Working format |
|---|---|
| u8, s16, s32, flt (packed or planar) | fltp |
| dbl, dblp | dblp |

The filter allocates one output frame per input frame (`frameReservation`), keeps no state, does not reframe and never accepts automatic rate conversion. It has no channel or rate constraint. FLAC input is refused before decoding (`FLAC input to asoftclip requires additional Native evidence`); `flacInput` is not declared.

## Arithmetic profile

The float path mirrors `filter_flt`'s C types: `threshold` is converted to float, `factor = 1.f/threshold`, `gain = output*threshold` is the double product rounded to float, and `param` is float. Every float operation is rounded with `Math.fround`, with no contraction.

- `hard`: `clipf(x*factor, -1, 1)*gain`, a separate multiply, clip and multiply. It is identical on macOS and Linux.
- `alg`: `s = x*factor; s/sqrtf(param + s*s)*gain`. This follows the Linux x86-64 unfused profile. A fused `param + s*s` (macOS arm64) gives different bits, so the `alg` native comparison runs only when `.build/reference/build-metadata.json` reports `linux/x64`, and is skipped with that reason elsewhere.

The double path computes `filter_dbl` in double. Zero and negative zero pass through unchanged.

## Evidence

`tests/unit/asoftclip.test.ts` (8 tests) covers syntax with exact messages, the float-type mirroring, clip boundaries, zero and negative zero, negotiation for every input format, capabilities, planning (`planSamples`, `packetSections`, `plannedReservations`, `reservations`), output against a direct C transcription over the full option grid in flt/fltp/dbl/dblp (216 cases), frame-split invariance through `process()`, ownership, allocation limits, non-finite refusal and cancellation.

`tests/differential/asoftclip.test.ts` runs `.build/reference/ffmpeg` at test time with `-cpuflags 0` and compares bytes exactly:

- `hard`, and `alg` on linux/x64: threshold {1, 0.5, 0.001} × output {1, 1.3, 16} × param {0.01, 1, 3} on u8, s16le, s32le, f32le and f64le stereo input containing zero, negative zero, clip boundaries and full scale, into raw f32le, f64le and s16le, s16 WAV and f32 framecrc: 675 comparisons per type.
- 180 framecrc comparisons of composed chains (`asetnsamples` splits, `volume`, `adelay`, `apad`, `aformat`, two asoftclip steps), positional options and output `-ss`/`-t`/`-frames:a`.
- 15 refusals: every libm type, the default type, oversample=2 for both types, `enable`, an exponent value (native succeeds) and three out-of-range values (native fails). Each is refused with `unsupported-filter` and no output file.

## Test contracts

| File | Test title | Scope |
|---|---|---|
| tests/differential/asoftclip.test.ts | matches native asoftclip type=hard over the threshold, output and param grid on every source format byte for byte | hard, oversample=1, all source formats, raw/WAV/framecrc |
| tests/differential/asoftclip.test.ts | matches native asoftclip type=alg over the threshold, output and param grid on every source format byte for byte (linux/x64) | alg, linux/x64 only |
| tests/differential/asoftclip.test.ts | matches native asoftclip hard in composed chains with frame splits, positional options and output time selection | hard in chains |
| tests/differential/asoftclip.test.ts | refuses every libm type, oversampling and unscoped options before writing output, where native succeeds or fails | refusals |
| tests/unit/asoftclip.test.ts | matches the C transcription for hard and alg over the option grid in float and double, packed and planar, and is frame-split invariant | kernel |

## Unsupported

The tanh, atan, cubic, exp, quintic, sin and erf types; oversample 2..64; option expressions, exponents and suffixes; timeline `enable`; runtime commands; FLAC input; non-finite input; `alg` parity on platforms other than Linux x86-64.
