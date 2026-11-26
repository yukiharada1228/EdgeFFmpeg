# cas video filter

`cas` (contrast adaptive sharpen) sharpens each selected plane with a weight derived from the local 3x3 contrast. It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_cas.c` (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`) and the option handling of `libavutil/opt.c`. Provenance is in `packages/avfilter/NOTICE-CAS`; the descriptor is `packages/avfilter/src/video-ops/cas.ts`.

## Syntax

`cas[=strength:planes]`, or the same names as named options in any order. The shorthand order is the AVOption order. Later occurrences of an option win.

| Option | Type | Range | Default |
|---|---|---|---|
| `strength` | `AV_OPT_TYPE_FLOAT` | 0..1 | 0 |
| `planes` | `AV_OPT_TYPE_FLAGS` | declared 0..15 | 7 |

- `strength` is a decimal literal (`0.5`, `.25`, `1`, `3e-1`, `+0.5`). The double is range-checked against [0, 1] as `write_number` does and then stored as the nearest float (`Math.fround`). A value outside the range fails with `Cas strength <value> is outside [0 - 1]`; native fails with `out of range` too.
- `planes` is one or more decimal or `0x` integer terms, each optionally prefixed by `+` (OR into the current value) or `-` (clear from it), as `set_string_number` folds flags without a unit (`planes=-1` is 6, `planes=0x2+8` is 10). `write_number` does not range-check flags, so values above 15 are accepted, as natively (`planes=0xff` filters every plane). Fractional values fail, as natively (`not a valid set of 32bit integer flags`). Bit `p` selects data plane `p` (Y, U, V, A; G, B, R for gbrp); unselected planes are copied.

## Supported and refused forms

- **Supported:** every `strength` in [0, 1] and every integer `planes` value, on every format below and every size, including 1x1 (the clamped neighbourhood never reads outside the plane).
- **Expressions and constants** (`strength=1/2`, `strength=max`, `strength=default`): `Only decimal cas strength values are implemented`. Native evaluates them with av_expr.
- **`enable=`:** `Cas timeline expressions are not implemented`. Native supports the generic timeline.
- **Runtime commands:** native forwards them to `ff_filter_process_command`. The descriptor sets neither `timeline` nor `geometryCommands`, so commands are refused.
- **Any other option** (including the generic `threads`): `Unsupported cas option`.
- Frames in a format other than the six below, malformed planes or strides, budgets over `maxFrameBytes`, invalid settings and invalid time bases fail with `VideoCasError`. `AbortSignal` is checked before work, on every row and every 16384 samples.

Every option refusal happens while parsing, before negotiation, input reads or output opens, on every path.

## Formats

`formats()` returns the native `pixel_fmts` list in declared order with native-endian names (58 formats, gray through gbrap16le). Frames run in the six eight-bit members with frame storage here: `gray`, `yuv420p`, `yuv422p`, `yuv444p`, `yuva420p` and `gbrp`. A negotiation that picks another member is refused by name by the shared negotiators. Native's picks were measured from all 17 negotiation sources: packed RGB without alpha negotiates `gbrp`, nv12/nv21 negotiate `yuv420p`, planar YUV, gray, yuva420p and gbrp stay as they are (yuvj on linear chains only), and the four packed-alpha sources negotiate `gbrap`, which has no storage here and is refused before any output on every path and CLI backend.

## Arithmetic

Per sample, as `cas_slice8` with the single-precision intermediates of the x86-64 build:

1. `mn` and `mx` are integer sums of the cross (d, e, f, b, h) minimum/maximum and the full 3x3 minimum/maximum, with clamped borders (`FFMAX(y-1,0)`, `FFMIN(y+1,h-1)` and likewise for x).
2. `strength = -lerpf(16.f, 4.01f, s)`: `-F(16 + F(F(F(4.01) - 16) * s))`, where `F` is `Math.fround`.
3. `amp = F(sqrt(clip(F(min(mn, 511 - mx) / mx), 0, 1)))`. `av_clipf_c` is `FFMIN(FFMAX(a, 0), 1)`, so the NaN of an all-zero neighbourhood (`mx == 0`) becomes 0; the output there is 0 either way.
4. `weight = F(amp / strength)`; the result is `F(F(F((b + d + f + h) * weight) + e) / F(1 + F(4 * weight)))`.
5. The float is passed to `av_clip_uint8(int)`, so it is converted by C's implicit float-to-int conversion, which truncates toward zero, and then clipped to 0..255. `vf_cas.c` calls no `lrintf` here: the wave specification's half-even rounding note does not apply to this kernel. The unit test pins a case (25.70 → 25) where rounding would differ, and a `Math.round` mutation fails three differential tests.

Every single-precision operation is computed in double and rounded with `Math.fround`, which is exact for `+`, `-`, `*`, `/` and `sqrt` of float operands. Mutations that drop the rounding of `weight`, of the denominator, or of the strength lerp each fail two differential tests.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed`, all from the stateless `frame` function. The registry examples run from the 8x8 gray source, which is in the native list; one example starts with `format=yuv420p` to cover the chroma planes.

## Determinism

`cas_slice8` uses single-precision float per sample with `sqrtf` and no other libm call. The emulation here is unfused, like the x86-64 baseline (no FMA without `-march`); macOS arm64 may contract the multiply-adds. The float cases therefore run only on linux-x64, in three tests with constant titles that are skipped elsewhere with `it.skipIf`. No macOS difference was measured in this sandbox, so the gate is recorded as a precaution. The `planes=0` copy cases (every plane copied, no float) and the refusals run on every platform. Slices are independent row ranges and every output sample depends only on the input, so the output does not depend on the thread count: every kernel case also compares native with default threads against `-filter_threads 1`.

## Evidence

`tests/differential/video-cas.test.ts` runs `.build/reference/ffmpeg` at test time, after checking from `.build/reference/build-metadata.json` that it was built from commit 946fcce0 with `--disable-x86asm`. It ran in the sandbox against a reference built there (sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, Linux x86_64 with 4 vCPUs, Node v24.22.3) in about 18 s with `--maxWorkers=1`. Every native run uses `-cpuflags 0`. Inputs are 3 frames: LCG noise; structured ramps per plane with a 255 left edge and a 0 bottom edge; and a frame whose first half is zero (all-zero neighbourhoods) beside a constant half with spikes.

| Test title | Paths | Cases |
|---|---|---|
| `matches native cas through the kernel, linear, frame graph and replay APIs across formats, sizes, strengths and planes (Linux x64 unfused float)` | kernel, linear, graph, stream (`createReplayVideoExecution`) | 6 formats x 6 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9) x 11 option sets: 396, each matching native rawvideo on four APIs and native default threads matching `-filter_threads 1` |
| `matches native cas=planes=0 copies through the kernel, linear, frame graph and replay APIs on every platform` | kernel, linear, graph, stream | 6 x 6 x 2 (`planes=0`, `1:planes=0x10`): 72 |
| `matches native cas rawvideo and framecrc bytes on every flagged CLI path (Linux x64 unfused float)` | linear, graph, stream, actor (`producer`), timed (`pull`) | 6 formats x 3 sizes (1x1, 7x5, 17x9) x 3 option sets x 2 muxers x {none, `-ss 0.04 -t 0.08`} x 5 paths: 1080 |
| `matches native cas=planes=0 copies on every flagged CLI path on every platform` | all five | 6 x 2 sizes x 2 muxers x 2 timings x 5: 240 |
| `refuses cas timelines, expressions and out-of-range or unknown options before opening outputs on every path` | all five | 6 native-accepted forms x 5 refused with no output opened, 5 native-refused forms x 5 refused here too: 55 |
| `negotiates every accepted cas=planes=0 source as native does and refuses the packed-alpha gbrap picks before output on every path` | all five | 17 sources: 89 checks |
| `negotiates every accepted sharpening cas source as native does and refuses the packed-alpha gbrap picks before output on every path (Linux x64 unfused float)` | all five | 17 sources with `cas=0.7:planes=0xf`: 89 checks |

The option sets are the defaults, `strength` 0, 1, 0.5, 0.25, 0.3 (not representable), 0.75, 0.8, 0.999 and `planes` 0, 1, 6, 15, 0xff, -1, 0x2+8. Total: 2,021 native comparisons, plus the build check. 1,565 of them (the three gated tests) run on linux-x64 only.

`tests/unit/video-cas.test.ts` (6 tests) covers parsing and every refusal, float storage, flag folding, the format list and geometry, the strength lerp, the per-sample kernel (flat, all-zero, clipped and truncated cases), plane selection and copies, ownership, no mutation, `maxFrameBytes`, malformed strides, invalid settings, `AbortSignal`, and the linear, graph, timed and actor planners.

## Proposed test contracts

| id | File | Title | Modes | Platforms |
|---|---|---|---|---|
| `filter.cas.api` | `tests/differential/video-cas.test.ts` | `matches native cas through the kernel, linear, frame graph and replay APIs across formats, sizes, strengths and planes (Linux x64 unfused float)` | linear, graph, stream | linux-x64 |
| `filter.cas.copy-api` | `tests/differential/video-cas.test.ts` | `matches native cas=planes=0 copies through the kernel, linear, frame graph and replay APIs on every platform` | linear, graph, stream | all |
| `filter.cas.cli` | `tests/differential/video-cas.test.ts` | `matches native cas rawvideo and framecrc bytes on every flagged CLI path (Linux x64 unfused float)` | linear, graph, stream, actor, timed | linux-x64 |
| `filter.cas.copy-cli` | `tests/differential/video-cas.test.ts` | `matches native cas=planes=0 copies on every flagged CLI path on every platform` | linear, graph, stream, actor, timed | all |
| `filter.cas.refusals` | `tests/differential/video-cas.test.ts` | `refuses cas timelines, expressions and out-of-range or unknown options before opening outputs on every path` | linear, graph, stream, actor, timed | all |
| `filter.cas.negotiation-copy` | `tests/differential/video-cas.test.ts` | `negotiates every accepted cas=planes=0 source as native does and refuses the packed-alpha gbrap picks before output on every path` | linear, graph, stream, actor, timed | all |
| `filter.cas.negotiation` | `tests/differential/video-cas.test.ts` | `negotiates every accepted sharpening cas source as native does and refuses the packed-alpha gbrap picks before output on every path (Linux x64 unfused float)` | linear, graph, stream, actor, timed | linux-x64 |
| `filter.cas.syntax` | `tests/unit/video-cas.test.ts` | `parses strength and planes in AVOption order with native defaults, float storage and flag arithmetic` | unit | all |

## Unsupported scope

- 9..16-bit formats (`cas_slice16`), `gbrap*`, `yuva422p`/`yuva444p`, `yuv410p`/`yuv411p`/`yuv440p` and the other list members without frame storage here. Of the negotiation sources, only the packed-alpha ones pick one (`gbrap`), and they are refused by name.
- `strength` expressions and constants, `enable=` timelines and runtime commands.
