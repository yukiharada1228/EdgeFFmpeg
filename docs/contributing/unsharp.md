# unsharp video filter

`unsharp` follows pinned `libavfilter/vf_unsharp.c` (commit 946fcce0). Each plane is
blurred with a separable binomial kernel of `msize_x` by `msize_y` taps, built as
native builds it: `2*(msize_x/2)` pairwise-sum stages along the row (`sr`) and
`2*(msize_y/2)` along the column (`sc`), with the first and last row and column
replicated past the edges. Each output sample is

```
blur = (sum + halfscale) >> scalebits          scalebits = (msize_x/2 + msize_y/2) * 2
dst  = clip8(p + (((p - blur) * amount) >> 16))   amount = (int)(float_amount * 65536.0)
```

A plane whose amount is `0` is copied unchanged, as `av_image_copy_plane` does. Luma
and alpha use the full size; both chroma planes use the chroma parameters at the
subsampled size (`AV_CEIL_RSHIFT`).

The descriptor is `packages/avfilter/src/video-ops/unsharp.ts`, registered with one
import line and one array line in `video-ops/registry.ts`. `unsharpVideoFrame`
materializes owned tight planes, keeps bigint PTS and metadata, and checks
`maxFrameBytes`, input plane storage, strides, the plane count, the time base and
the `AbortSignal` (per row).

## Syntax

`unsharp[=luma_msize_x[:luma_msize_y[:luma_amount[:chroma_msize_x[:chroma_msize_y[:chroma_amount[:alpha_msize_x[:alpha_msize_y[:alpha_amount]]]]]]]]]`,
or the named keys `luma_msize_x`/`lx`, `luma_msize_y`/`ly`, `luma_amount`/`la`,
`chroma_msize_x`/`cx`, `chroma_msize_y`/`cy`, `chroma_amount`/`ca`,
`alpha_msize_x`/`ax`, `alpha_msize_y`/`ay`, `alpha_amount`/`aa`. Positional values
follow AVOption order and skip the aliases that share an offset. Repeated keys keep
the last value.

- Matrix sizes are `AV_OPT_TYPE_INT` in 3..23, default 5, parsed through the shared
  scoped integer-option helper (integer expressions, `default`/`min`/`max`, `llrint`
  half-to-even rounding).
- Amounts are `AV_OPT_TYPE_FLOAT` in -2..5 (defaults: luma 1, chroma 0, alpha 0).
  Only decimal literals are implemented. The double is range-checked, rounded to
  float (`Math.fround`) and `amount*65536.0` is truncated toward zero once, at parse
  time.

Refused before any output is opened:

- `(msize_x/2 + msize_y/2)*2 > 25` for luma, chroma or alpha, in that order, with
  native's message, for example `luma matrix size (lx/2+ly/2)*2=44 greater than
  maximum value 25` for `lx=23:ly=23` (native exit status 234, `EINVAL`).
- Even luma or chroma sizes, `Invalid even size for luma matrix size 4x5` (native
  fails in `config_input`, also `EINVAL`). Alpha sizes are never checked for
  oddness natively, so even alpha sizes are accepted.
- Out-of-range values (native `out of range`, `ERANGE`), unknown options (native
  `Option not found`) and a tenth positional value (native `No option name`).
- Amount expressions (`la=1+1`), which native evaluates: refused explicitly.
- `enable=`, generic options such as `threads`, and runtime commands (the descriptor
  sets neither `timeline` nor `geometryCommands`).
- Frames whose height is below `4*(luma_msize_y/2)`. `config_input` sets
  `nb_threads = min(threads, h / (4*steps_y))`; at zero, `ff_filter_execute` runs no
  slice job and native returns the fresh, unwritten pool buffer (probed: a constant
  8x6 yuv420p frame with the defaults comes back as zeros). This applies even when
  every amount is 0. The refusal is raised from `geometry` on every path and repeated
  in `frame`.
- A nonzero alpha amount on a format with alpha (yuva420p here). `init_filter_param`
  runs for luma and chroma only, so the alpha `sr`/`sc` storage is never allocated
  and native dereferences a null row table (probed: SIGSEGV, exit 139). The refusal
  is raised from `validate` on every path and repeated in `frame`. On formats without
  alpha the alpha amount only takes part in the size check and is accepted.

## Formats and paths

`formats()` is the native `pix_fmts` list in declared order (38 formats: 8- to
16-bit planar YUV and YUVA, `yuvj` included), so the shared negotiators pick exactly
what native picks. Frames run in the eight-bit layouts with frame storage, `yuv420p`,
`yuv422p`, `yuv444p` and `yuva420p`, and in the legacy `yuvj420p`/`yuvj422p`/`yuvj444p`
sources of linear chains. Other inputs convert by negotiation, as in native (nv12/nv21
to yuv420p, rgb24/bgr24/gbrp to yuv444p). gray picks `yuvj444p` and packed RGB with
alpha picks `yuva444p`, which have no storage here: the negotiators refuse them by name
(`Video filter unsharp input negotiates yuvj444p, which is not implemented`) before any
output. The size is unchanged.

Flagged paths: `linear`, `graph`, `stream`, `actor` and `timed`. The operator is
stateless, so the actor and timed executors call `frame` directly.

## Determinism and arithmetic profile

The only float is the amount option, converted to an integer once at parse time
(`Math.fround` then truncation; multiplying by 65536 is exact). The kernel is integer:
the FSM sums stay below `255 * 2^24 < 2^32`, and `(p - blur) * amount` stays below
`2^27`, so plain JavaScript numbers are exact and the `>> 16` of a signed 64-bit
product is a floor division. Results are the same on every platform; no case is
gated to linux-x64. Native slicing does not change the result: each slice restarts
the column FSM `steps_y` rows early with zeroed state, which covers the whole
`2*steps_y + 1`-row window, and the differential test checks default threads,
`-filter_threads 1` and `-filter_threads 4` against each other and against
EdgeFFmpeg. The stale last `sr` entry that native's `memset` leaves only reaches
column `-steps_x`, which is never output. Native's 16-bit variant is unreachable
because a high-depth pick is refused.

## Evidence

`tests/differential/video-unsharp.test.ts` runs `.build/reference/ffmpeg`
(`-cpuflags 0`) at test time, after checking that `.build/reference/build-metadata.json`
names commit 946fcce0 and `--disable-x86asm`. Inputs are generated per test in a
`mkdtemp` directory, in unsharp's own storage formats (yuv420p, yuv422p, yuv444p,
yuva420p), three frames each: LCG noise, ramps with hard edges, and constant planes.
The 13 option sets cover the defaults, `3:3:-2` (luma and chroma), 23x3 and 3x23
matrices on tiny planes, luma copy with chroma sharpening, amount 0 (copy), the
maximum amount 5 (clipping), fractional amounts (truncation), even alpha sizes,
positional values, a nonzero alpha amount, 13x13 and 3x23 luma matrices.

| Test | Comparisons |
|---|---|
| `runs against a reference built from commit 946fcce0 with --disable-x86asm` | the build metadata check |
| `matches native unsharp through the linear, frame graph and replay APIs across formats, matrices, amounts, sizes and patterns` | 4 formats x 11 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9, 1x8, 2x8, 3x16, 5x24, 3x44) x 13 option sets: 332 native rawvideo outputs matched byte for byte by `compileVideoFilterChain`, `compileVideoFilterGraph` and `createReplayVideoExecution` (996 path comparisons). 240 cases (short frames, alpha amount on yuva420p) were refused on all three. |
| `matches native unsharp rawvideo and framecrc bytes on every flagged CLI path with and without -ss and -t` | 4 formats x 8 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9, 1x8, 2x8) x 13 option sets x 4 output scopes (rawvideo; framecrc; framecrc with input `-ss 0.04` and output `-t 0.05`; rawvideo with output `-ss 0.04 -frames:v 1`) x 5 paths: 3820 native outputs matched through `-vf` (linear), single-input `-filter_complex` (graph), multi-input `-filter_complex` (stream), the timed backend's `producer` scheduler (actor) and its `pull` scheduler (timed). 4500 refused runs opened no output. |
| `agrees with native under default slice threads, -filter_threads 1 and 4 on frames tall enough for several slices` | 4 formats x 3 sizes (9x64, 17x40, 6x33) x 4 option sets: native outputs agree across the three thread settings, and 96 EdgeFFmpeg runs (linear and timed) match them. |
| `fails like native for oversized and even matrices, out-of-range values and unknown options before opening outputs on every path` | 12 option errors x 5 paths = 60 failures on both sides; native's status (`EINVAL`/`ERANGE` from `os.constants.errno`) and diagnostic are checked, and the size errors carry native's message here too. |
| `refuses unwritten short frames and the unallocated yuva420p alpha path before opening outputs on every path` | 25 refusals (5 cases x 5 paths), plus the native probe that a short frame comes back unwritten. |
| `negotiates every accepted source as native does and refuses picks without storage before output on every path` | `unsharp=ly=3:la=1.5:cx=3:cy=3:ca=-1` from 17 sources at 8x6: 12 run byte-exact on the five paths (yuvj on linear chains); gray (`yuvj444p`) and argb, rgba, abgr, bgra (`yuva444p`) are refused by name on the five paths and the four CLI backends. 93 checks. |

`tests/unit/video-unsharp.test.ts` (6 tests) covers parsing (aliases, positional
order, last-wins, integer expressions and rounding, amount truncation), every
refusal, the format list, geometry and validate refusals, an independent direct
binomial-convolution model on all four formats with padded strides, hand-computed
spike cases, `maxFrameBytes`, input storage, malformed strides and plane counts,
forged settings, the time base, `AbortSignal`, the unmutated input and owned output
planes, and plan-time refusals on every path. `tests/unit/video-operator-registry.test.ts`
runs the descriptor examples on all five paths.

All tests ran in a Linux x86_64 sandbox against a reference built there:
`.build/reference/ffmpeg` sha256
`ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, compiler
`cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, Node v24.22.3. The differential file
takes about 40 s on 4 vCPUs.

## Proposed contracts

All in `tests/differential/video-unsharp.test.ts` unless noted; every platform.

| id | Exact test title | Modes | Scope |
|---|---|---|---|
| `filter.unsharp.api` | `matches native unsharp through the linear, frame graph and replay APIs across formats, matrices, amounts, sizes and patterns` | linear, graph, stream | 13 option sets on yuv420p, yuv422p, yuv444p, yuva420p; rawvideo bytes |
| `filter.unsharp.cli` | `matches native unsharp rawvideo and framecrc bytes on every flagged CLI path with and without -ss and -t` | linear, graph, stream, actor, timed | rawvideo and framecrc with -ss/-t scopes |
| `filter.unsharp.threads` | `agrees with native under default slice threads, -filter_threads 1 and 4 on frames tall enough for several slices` | linear, timed | slice-thread independence |
| `filter.unsharp.refusals` | `fails like native for oversized and even matrices, out-of-range values and unknown options before opening outputs on every path` | linear, graph, stream, actor, timed | option, scalebits and even-size errors |
| `filter.unsharp.unwritten` | `refuses unwritten short frames and the unallocated yuva420p alpha path before opening outputs on every path` | linear, graph, stream, actor, timed | refusals where native output is unwritten or crashes |
| `filter.unsharp.negotiation` | `negotiates every accepted source as native does and refuses picks without storage before output on every path` | linear, graph, stream, actor, timed | per-source negotiation |
| `filter.unsharp.unit` | `rejects unsupported layouts, budgets, malformed storage, invalid settings and cancellation explicitly` (`tests/unit/video-unsharp.test.ts`) | unit | frame limits, strides, AbortSignal |

## Unsupported

- The `enable=` timeline, runtime commands, generic filter options and amount
  expressions.
- Heights below `4*(luma_msize_y/2)` (native output unwritten).
- Nonzero alpha amounts on yuva420p (native crashes).
- High-bit-depth formats and the other native formats without frame storage here
  (yuva422p, yuva444p, yuv410p, yuv411p, yuv440p, yuvj440p): a negotiation that picks
  one, such as gray (`yuvj444p`) or packed RGB with alpha (`yuva444p`), is refused by
  name before output.
- H.264/MP4 framecrc input has no dedicated comparison. The size is unchanged, so the
  `mp4-h264.ts` aspect derivation is unaffected.
