# removegrain video filter

`removegrain` follows `removegrain_options`, `pix_fmts`, the mode kernels `mode01` to `mode24`, `config_input`, `filter_slice` and `filter_frame` of the pinned `libavfilter/vf_removegrain.c` (FFmpeg 9.0.2, commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`). Each plane takes one of 24 spatial 3x3 kernels, or mode 0, which copies it. The kernels live in `packages/avfilter/src/video-removegrain.ts` and the descriptor in `packages/avfilter/src/video-ops/removegrain.ts`. Provenance is in `packages/avfilter/NOTICE-REMOVEGRAIN`.

## Syntax

`removegrain[=m0[:m1[:m2[:m3]]]]`, or the same names as `key=value` pairs (names are case-sensitive, as natively).

| Option | Range | Default | Meaning |
|---|---|---|---|
| `m0`..`m3` | 0..24 | 0 | Mode of data plane 0..3. For gbrp the planes are in data order G, B, R. Modes of planes the format does not have are ignored. |

Values are parsed as `AV_OPT_TYPE_INT`: expressions, hex included, with the constants `default`, `min`, `max`, `none` and `all`, range checked, ties rounded to even (`filterIntegerOption`, linux-x64 profile).

These are refused before any output is opened:

- out-of-range or invalid values;
- `enable=` (`Removegrain timeline expressions are not implemented`). Native accepts it (`AVFILTER_FLAG_SUPPORT_TIMELINE_GENERIC`);
- every other option, including `threads`, and more than four positional values.

Runtime commands are refused, because the descriptor sets neither `timeline` nor `geometryCommands`: `m0`..`m3` and `w` return ENOSYS, and `enable` returns `AVERROR_PATCHWELCOME`. Native has no `process_command` either.

## Kernel semantics

- **Modes.** Every mode is ported from its C function, with these details kept exactly:
  - the axis pairs (a1,a8), (a2,a7), (a3,a6) and (a4,a5) of `REMOVE_GRAIN_SORT_AXIS`;
  - the tie order of each `mindiff` chain: axis 4, then 2, 3, 1 for modes 5 to 9 and 18; a7, a8, a6, a2, a3, a1, a5, a4 for mode 10; d2, d3, d1 for modes 13 to 16;
  - the `av_clip_uint16` costs of modes 6 and 8;
  - the `(sum+4)/9` truncating division of mode 20;
  - the rounding shifts of modes 11/12, 19, 21 and 22.

  Modes 2 to 4 rank the eight neighbours with an insertion sort; any correct sort gives the same ranks as `AV_QSORT`. 11 and 12 are one kernel, and so are 13/14 and 15/16.
- **Skipped rows.** `config_input` sets `skip_odd` for mode 13 or 15 and `skip_even` for mode 14 or 16 on any of the format's planes. It sets these filter-wide flags only for planes the format has. In every plane whose mode is not 0, the flags then copy the odd or even interior rows, whatever that plane's own mode. So `removegrain=1:13` also leaves luma's odd rows unfiltered, and `removegrain=13:14` copies every row of every filtered plane.
- **Borders.** In a plane with a mode other than 0, rows 0 and `height-1` and columns 0 and `width-1` are copied, as `filter_frame` and `filter_slice` copy them. Planes that are one or two samples wide or tall are therefore copies. Natively, a one-sample-wide interior row writes `dst[1] = src[1]` past the row, into the output padding. That byte is never visible and is not mirrored: no visible output depends on it, so the case is supported rather than refused.
- **Mode 0.** The plane is copied, as `av_image_copy_plane` copies it.
- **Store.** The result is stored as its low eight bits, as the `uint8_t` store does. Modes 23 and 24 stay within 0..255 for eight-bit input.

## Formats

`formats()` returns the native `pix_fmts` in declared order: gray, yuv420p, yuv422p, yuv444p, yuva420p, yuva422p, yuva444p, yuv440p, yuv411p, yuv410p, yuvj411p, yuvj420p, yuvj422p, yuvj440p, yuvj444p, gbrp and gbrap.

Frames run in the layouts with frame storage: gray, yuv420p, yuv422p, yuv444p, yuva420p and gbrp, plus the legacy yuvj420p/yuvj422p/yuvj444p sources of linear chains. nv12 and nv21 convert to yuv420p, and rgb24 and bgr24 to gbrp, as natively. Packed RGB with alpha (rgba, bgra, argb, abgr) negotiates `gbrap` natively, and `gbrap` has no frame storage here. Those sources are refused at plan time with `Video filter removegrain input negotiates gbrap, which is not implemented`, on every path and before any output is opened.

`frame()` returns owned, tight planes. It:

- checks `maxFrameBytes` for the output and for the resident input storage;
- rejects malformed strides, plane counts, settings and time bases;
- checks `AbortSignal` per row;
- keeps the bigint PTS and the metadata;
- never mutates its input.

## Paths

All five paths are flagged: `linear`, `graph`, `stream`, `actor` and `timed`. `removegrain` is a stateless `frame` operator.

## Determinism

The filter uses only integer comparisons, clamps, sums, shifts and one truncating division, with no floating point. The pinned build is configured without `--enable-gpl` and with `--disable-x86asm`, so native runs these same C kernels. Slices only partition rows, read the input and write the output, so the result does not depend on threads; the threads test checks that default threads and `-filter_threads 1` agree. Conversions in chains run with `-cpuflags 0` natively and scalar arithmetic here. No case is platform gated.

## Evidence

Every comparison runs the sandbox's `.build/reference/ffmpeg` at test time and asserts that `.build/reference/build-metadata.json` names commit 946fcce0 and `--disable-x86asm`.

The sandbox build:

- ffmpeg sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`;
- `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`;
- Node v22.23.5 on linux x86_64.

Inputs are generated per test. Each one cycles through:

- LCG noise;
- impulses: 0 and 255 spikes on a flat field;
- a ramp with sparse near-saturated peaks;
- a saturated checkerboard;
- constant planes;
- a three-level (100/110/120) pattern whose equal distances exercise every tie order.

| Test (tests/differential/video-removegrain.test.ts) | Native comparisons |
|---|---|
| `matches native removegrain bytes for every mode on every plane slot across formats sizes and patterns` | 9240 kernel outputs, 6 frames each, from 264 native split runs. The 6 formats are crossed with 11 sizes (1x1, 2x2, 3x3, 1x3, 3x1, 2x3, 3x2, 5x3, 7x5, 8x6, 17x9) and 140 option sets: the default, each of the 25 modes alone on each of the 4 slots, each mode on all 4 slots, and 14 mixes of the skip modes and the other modes. |
| `matches native removegrain with default filter threads and with -filter_threads 1` | 144 runs: 6 formats x 17x9/64x33 x 6 mode sets x {default threads, `-filter_threads 1`} |
| `matches native linear removegrain chains with negotiated conversion and scalar arithmetic` | 270 `compileVideoFilterChain` runs: 9 sources x 2 sizes x 3 targets x 5 chains |
| `matches native removegrain CLI -vf and -filter_complex rawvideo and framecrc outputs across timing and size scopes` | 288 `-vf` and 48 two-output `-filter_complex` CLI runs, rawvideo and framecrc, with and without `-ss`/`-t` |
| `matches native replayed removegrain branches and joins frame by frame` | 20 `createReplayVideoExecution` runs |
| `matches native removegrain framecrc and rawvideo through the timed executor and activation actors` | 432 timed-backend runs: 144 native runs (6 formats x 1x1/2x3/5x3 x 4 graphs x framecrc/rawvideo) x {`pull`, `activation`, `producer`} |
| `refuses removegrain enable= timelines on every CLI path before opening outputs while native accepts them` | 10 refusals (media `-vf`/`-filter_complex`, timed pull/activation/producer) with no output opened, plus 2 native runs showing that native accepts them |
| `negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path` | `removegrain=m0=1:m1=13:m2=24:m3=4` from 17 sources, 89 checks. 13 sources are byte-exact on the five paths (yuvj on linear only). argb, rgba, abgr and bgra are refused, naming `gbrap`, on the five paths and four CLI backends. |

The kernel matrix was mutation-checked. Each of these mutations made the test fail:

- skip flags read from all four slots;
- dropping `skip_even`;
- swapping the a7/a8 tie order of mode 10;
- swapping the axis order of mode 5, of modes 6 to 8 and of modes 13/14;
- a wrong rounding constant in mode 11/12.

The unit tests are `tests/unit/video-removegrain.test.ts` (5 tests). They cover:

- parsing, ranges and refusals;
- the exact value of every mode above and below every axis;
- the tie orders;
- border, skip-row and cross-plane skip semantics;
- 1-, 2- and 3-sample planes;
- owned output planes and unmutated input;
- budgets, malformed strides, plane counts, settings and time bases;
- AbortSignal;
- planner behaviour, gbrap refusals, and the `enable=` and runtime-command refusals.

`tests/unit/video-operator-registry.test.ts` runs the five descriptor examples on all five paths.

## Proposed test contracts

| id | File | Test title | Scope | Platforms |
|---|---|---|---|---|
| filter.removegrain.kernel | tests/differential/video-removegrain.test.ts | matches native removegrain bytes for every mode on every plane slot across formats sizes and patterns | kernel | all |
| filter.removegrain.threads | tests/differential/video-removegrain.test.ts | matches native removegrain with default filter threads and with -filter_threads 1 | kernel, threads | all |
| filter.removegrain.linear | tests/differential/video-removegrain.test.ts | matches native linear removegrain chains with negotiated conversion and scalar arithmetic | linear | all |
| filter.removegrain.cli | tests/differential/video-removegrain.test.ts | matches native removegrain CLI -vf and -filter_complex rawvideo and framecrc outputs across timing and size scopes | linear, graph | all |
| filter.removegrain.stream | tests/differential/video-removegrain.test.ts | matches native replayed removegrain branches and joins frame by frame | stream | all |
| filter.removegrain.timed | tests/differential/video-removegrain.test.ts | matches native removegrain framecrc and rawvideo through the timed executor and activation actors | actor, timed | all |
| filter.removegrain.refusals | tests/differential/video-removegrain.test.ts | refuses removegrain enable= timelines on every CLI path before opening outputs while native accepts them | refusals | all |
| filter.removegrain.negotiation | tests/differential/video-removegrain.test.ts | negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path | negotiation, every path | all |

## Unsupported

- yuva422p, yuva444p, yuv440p, yuv411p, yuv410p, yuvj411p, yuvj440p and gbrap have no frame storage here, so a negotiation that picks one is refused by name. Packed RGB with alpha sources negotiate `gbrap` and are refused before output.
- `enable=` timelines.
- Native `config_input` never clears `skip_odd`/`skip_even`, so a link reconfigured to another format keeps flags set by its earlier format. This module computes the flags from each frame's format. No test covers mid-stream format changes.
