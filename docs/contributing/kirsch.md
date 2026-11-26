# kirsch video filter

`kirsch` follows pinned `libavfilter/vf_convolution.c` (commit 946fcce0), the
eight-bit `filter_kirsch` with `setup_3x3` from `libavfilter/convolution.h`. For each
selected plane, every output sample takes its eight neighbours `c0..c8` (`c4`, the
centre, is unused), forms the eight compass sums exactly as native writes them (three
taps weighted 5, five weighted -3; equivalently `8*(three taps) - 3*(all eight)`),
keeps the largest and writes

```
dst = av_clip_uint8((int)(float(FFABS(max) * scale) + delta))
```

Neighbour addresses come from `avpriv_mirror`: column or row `-1` reads `1`, `n` reads
`n-2`, and a plane one pixel wide or tall reads index `0`. These are the same addresses
native's `filter_slice` uses for its per-pixel left and right columns and its middle
run, so 1- and 2-pixel planes are in bounds and supported. Planes outside the `planes`
mask are copied unchanged (`av_image_copy_plane`). Chroma planes use the subsampled
size (`AV_CEIL_RSHIFT`).

The descriptor is `packages/avfilter/src/video-ops/kirsch.ts`, registered with one
import line and one array line in `video-ops/registry.ts`. `kirschVideoFrame`
materializes owned tight planes, keeps bigint PTS and metadata, and checks
`maxFrameBytes`, input plane storage, strides, the plane count, the time base, forged
settings and the `AbortSignal` (per row).

## Syntax

`kirsch[=planes[:scale[:delta]]]`, or the named keys `planes`, `scale`, `delta`.
Repeated keys keep the last value.

- `planes` is `AV_OPT_TYPE_INT` in 0..15, default 15, parsed through the shared scoped
  integer-option helper (integer expressions, `default`/`min`/`max`, `llrint`
  half-to-even rounding).
- `scale` (0..65535, default 1) and `delta` (-65535..65535, default 0) are
  `AV_OPT_TYPE_FLOAT`. Only decimal literals are implemented: the double is
  range-checked, then stored as float (`Math.fround`).

Refused before any output is opened:

- Out-of-range values (native `out of range`, exit status `256-ERANGE`), unknown
  options (native `Option not found`) and a fourth positional value (native
  `No option name`).
- Forms native accepts but this port does not implement: `scale`/`delta`
  expressions or constants (`scale=1/2`, `delta=-PI`), `enable=`, generic filter
  options such as `threads`, and runtime commands. The descriptor sets neither
  `timeline` nor `geometryCommands`; option commands answer `ENOSYS` and `enable`
  answers `AVERROR_PATCHWELCOME`. Native's `process_command` would re-run
  `param_init`.

## Formats and paths

`formats()` is the native `pix_fmts` list in declared order (57 formats: 8- to
16-bit planar YUV, YUVA, GBR(A)P and gray, `yuvj` included), so the shared
negotiators pick exactly what native picks. Frames run in the eight-bit layouts with
frame storage, `gray`, `yuv420p`, `yuv422p`, `yuv444p`, `yuva420p` and `gbrp`, and in
the legacy `yuvj420p`/`yuvj422p`/`yuvj444p` sources of linear chains. Other inputs
convert by negotiation as in native (nv12/nv21 to yuv420p, rgb24/bgr24 to gbrp).
Packed RGB with alpha picks `gbrap`, which has no storage here: the negotiators refuse
it by name (`Video filter kirsch input negotiates gbrap, which is not implemented`)
before any output. The size is unchanged.

Flagged paths: `linear`, `graph`, `stream`, `actor` and `timed`. The operator is
stateless, so the actor and timed executors call `frame` directly.

## Determinism and arithmetic profile

The compass sums are integers (|sum| <= 3825) and exact. The output step is float:
`FFABS(max) * scale` is rounded to float, then `+ delta` is rounded to float, then the
conversion to `int` truncates toward zero and `av_clip_uint8` clamps. The port emulates
this with `Math.fround` after each operation (double rounding through a double is
innocuous for one float `*` or `+`). The x86-64 baseline (`--disable-x86asm`, SSE
float, no FMA) is unfused; macOS arm64 contracts the multiply-add into one FMA. A
fused emulation was checked to differ: replacing the two roundings with one
(`Math.fround(|sum|*scale + delta)`) fails the float differential test on
`scale=0.7:delta=-0.1` (for example at |sum| = 3, 13, 183, 193). No macOS run was
measured here, so the gate is a precaution backed by that emulation.

- Integer cases (`scale=1`, `delta=0`, every `planes` mask) are exact on every
  platform and run everywhere.
- Float scale or delta cases run only on linux-x64, in tests with constant titles
  ending `(linux-x64 unfused float)`, skipped elsewhere with `it.skipIf`. No case is
  dropped inside a test per platform.

Native slicing does not change the result: slices split rows, and every slice reads
the whole source plane through `setup_3x3`. The differential test checks default
threads, `-filter_threads 1` (`-vf`) and `-filter_complex_threads 1` against each
other and against EdgeFFmpeg.

## Evidence

`tests/differential/video-kirsch.test.ts` runs `.build/reference/ffmpeg`
(`-cpuflags 0`) at test time, after checking that `.build/reference/build-metadata.json`
names commit 946fcce0 and `--disable-x86asm`. Inputs are generated per test in a
`mkdtemp` directory, in kirsch's own storage formats (yuv444p, yuv422p, yuva420p,
yuv420p, gbrp, gray), three frames each: LCG noise, ramps with hard edges and isolated
spikes, and constant planes. Sizes for the API cases: 1x1, 2x2, 5x3, 7x5, 8x6, 17x9,
1x8, 2x8 and 8x1.

| Test | Comparisons |
|---|---|
| `runs against a reference built from commit 946fcce0 with --disable-x86asm` | the build metadata check |
| `matches native kirsch with scale 1 and delta 0 through the linear, frame graph and replay APIs across formats, plane masks, sizes and patterns` | 6 formats x 9 sizes x 8 option sets (defaults, `planes` 0, 1, 6, 9, 10, 8, positional `15:1:0`): 432 native rawvideo outputs matched by `compileVideoFilterChain`, `compileVideoFilterGraph` and `createReplayVideoExecution` (1296 path comparisons). Every platform. |
| `matches native kirsch float scale and delta through the linear, frame graph and replay APIs (linux-x64 unfused float)` | 6 formats x 9 sizes x 17 option sets (scale 0.5 and 10, negative and positive deltas, fractional values, `scale=0`, the range ends `65535:-65535`, positional `3:0.333:1e1`, and five pairs where fused and unfused float differ): 918 native outputs, 2754 path comparisons. linux-x64 only. |
| `matches native kirsch rawvideo and framecrc bytes with scale 1 and delta 0 on every flagged CLI path with and without -ss and -t` | 6 formats x 4 sizes (1x1, 2x2, 5x3, 17x9) x 3 option sets x 4 output scopes (rawvideo; framecrc; framecrc with input `-ss 0.04` and output `-t 0.05`; rawvideo with output `-ss 0.04 -frames:v 1`) x 5 paths: 1440 native outputs matched through `-vf` (linear), single-input `-filter_complex` (graph), multi-input `-filter_complex` (stream), the timed backend's `producer` scheduler (actor) and its `pull` scheduler (timed). Every platform. |
| `matches native kirsch float rawvideo and framecrc bytes on every flagged CLI path with and without -ss and -t (linux-x64 unfused float)` | the same grid with 4 float option sets: 1920 native outputs. linux-x64 only. |
| `agrees with native under default slice threads and -filter_threads 1 on frames tall enough for several slices` | 6 formats x 3 sizes (9x64, 17x40, 6x33) x 2 option sets: native `-vf` and `-filter_complex` with default and single threads agree (4 runs each), and 72 EdgeFFmpeg runs (linear and timed) match them. |
| `fails like native for out-of-range values, unknown options and extra positional values before opening outputs on every path` | 8 option errors x 5 paths = 40 failures on both sides; native's status (`ERANGE` from `os.constants.errno`) and diagnostic are checked; no output is opened here. |
| `refuses enable=, float expressions and generic options that native accepts before opening outputs on every path` | 4 forms native runs (exit 0) x 5 paths = 20 explicit refusals here, each naming the reason, no output opened. |
| `negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path` | `kirsch=planes=13` from 17 sources at 8x6: 13 run byte-exact on the five paths (yuvj on linear chains); argb, rgba, abgr, bgra (`gbrap`) are refused by name on the five paths and the four CLI backends. 89 checks. |

`tests/unit/video-kirsch.test.ts` (4 tests) covers parsing (shorthand order, named
keys, last-wins, integer plane expressions and rounding, float storage, every
refusal), the 57-format list, an independent direct model written from the
coefficient rows of `filter_kirsch` and the `avpriv_mirror` loop, run on all six
formats, seven sizes (including 1x1, 1x5, 5x1 and 2x7) and seven option sets with
padded strides (833 plane comparisons), hand-computed constant and spike cases,
`maxFrameBytes`, input storage, malformed strides and plane counts, forged settings,
the time base, `AbortSignal`, the unmutated input and owned output planes, plan
budgets, negotiation refusals, and refused runtime commands and `enable=`.
`tests/unit/video-operator-registry.test.ts` runs the descriptor examples on all five
paths.

All tests ran in a Linux x86_64 sandbox against a reference built there:
`.build/reference/ffmpeg` sha256
`ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, compiler
`cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, Node v24.22.3. The differential file
takes about 40 s on 4 vCPUs.

## Proposed contracts

All in `tests/differential/video-kirsch.test.ts` unless noted. Platforms are every
platform unless noted.

| id | Exact test title | Modes | Scope | Platforms |
|---|---|---|---|---|
| `filter.kirsch.api` | `matches native kirsch with scale 1 and delta 0 through the linear, frame graph and replay APIs across formats, plane masks, sizes and patterns` | linear, graph, stream | integer scale/delta, every plane mask, six formats, 1- and 2-pixel planes | all |
| `filter.kirsch.api-float` | `matches native kirsch float scale and delta through the linear, frame graph and replay APIs (linux-x64 unfused float)` | linear, graph, stream | float scale and delta | linux-x64 |
| `filter.kirsch.cli` | `matches native kirsch rawvideo and framecrc bytes with scale 1 and delta 0 on every flagged CLI path with and without -ss and -t` | linear, graph, stream, actor, timed | rawvideo and framecrc with -ss/-t scopes | all |
| `filter.kirsch.cli-float` | `matches native kirsch float rawvideo and framecrc bytes on every flagged CLI path with and without -ss and -t (linux-x64 unfused float)` | linear, graph, stream, actor, timed | float scale and delta on the CLI | linux-x64 |
| `filter.kirsch.threads` | `agrees with native under default slice threads and -filter_threads 1 on frames tall enough for several slices` | linear, timed | slice-thread independence | all |
| `filter.kirsch.refusals` | `fails like native for out-of-range values, unknown options and extra positional values before opening outputs on every path` | linear, graph, stream, actor, timed | option errors | all |
| `filter.kirsch.scope` | `refuses enable=, float expressions and generic options that native accepts before opening outputs on every path` | linear, graph, stream, actor, timed | explicit out-of-scope refusals | all |
| `filter.kirsch.negotiation` | `negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path` | linear, graph, stream, actor, timed | per-source negotiation | all |
| `filter.kirsch.unit` | `refuses unsupported layouts, budgets, malformed storage, settings and cancellation explicitly` (`tests/unit/video-kirsch.test.ts`) | unit | frame limits, strides, AbortSignal | all |

## Unsupported

- The `enable=` timeline, runtime commands, generic filter options, and `scale`/`delta`
  expressions or constants.
- High-bit-depth formats (native `filter16_kirsch`) and the other native formats
  without frame storage here (yuva422p, yuva444p, yuv410p, yuv411p, yuv440p,
  yuvj440p, yuvj411p, gbrap): a negotiation that picks one, such as packed RGB with
  alpha (`gbrap`), is refused by name before output.
- H.264/MP4 framecrc input has no dedicated comparison. The size is unchanged, so the
  `mp4-h264.ts` aspect derivation is unaffected.
