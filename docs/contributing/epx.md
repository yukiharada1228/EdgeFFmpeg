# epx video filter

`epx` follows pinned `libavfilter/vf_epx.c` (FFmpeg 9.0.2,
946fcce07b6dcd0331c8cc609192aeff5e1924f8). The descriptor is
`packages/avfilter/src/video-ops/epx.ts`; the kernel `epxVideoFrame`, the parser
`parseEpxOptions` and `epxGeometry` live in `packages/avfilter/src/video-epx.ts`.
Provenance is in `packages/avfilter/NOTICE-EPX`.

## Syntax

| Form | Meaning |
|---|---|
| `epx` | `n=3` (native default) |
| `epx=2`, `epx=n=2`, `epx=n=3` | shorthand position one is `n`; repeated keys keep the last value |

`n` is `AV_OPT_TYPE_INT` in `[2,3]`. Only plain decimal integers (optional `+`
and leading zeros) are implemented. Refused explicitly at parse time, before any
output is opened:

- `n` outside 2..3 (native also rejects these);
- expression or non-decimal values (`n=1+1`, `n=0x2`, `n=2.0`), which native
  would evaluate; they fail with `Only decimal integer epx scale factors are implemented`;
- `enable=` (native `epx` has no timeline support, so native rejects it too);
- every other option, including generic filter-context options such as `threads`;
- runtime commands (the descriptor sets neither `timeline` nor `geometryCommands`).

## Formats and geometry

`formats()` is the native `pix_fmts` list intersected with the negotiation table,
in table order: `argb`, `rgba`, `abgr`, `bgra`. Other inputs get an automatic
conversion, as in native negotiation; `validate` repeats the format check.

`geometry()` returns `w*n` by `h*n`. Sizes whose output fails the
`av_image_check_size` bound are refused there and again in `frame`. There is no
`timedGeometry`, so timed plans keep the input sample aspect ratio, as native
`config_output` does (the output link inherits the input SAR).

## Arithmetic and determinism

Pure integer. Each pixel is compared as one 32-bit word, so equality is
independent of byte order and of which byte holds alpha; the four formats share
one kernel. Neighbours are clamped at every edge exactly as the native
`FFMAX(x-1,0)` / `FFMIN(x+1,width-1)` and row-pointer advance do. Native slice
threading does not change results (each slice clamps from the full frame); the
kernel processes the whole frame. Output is owned tight planes with positive
strides; PTS and metadata are copied. The output byte count is checked against
`maxFrameBytes` before allocation, as is the input plane storage. The signal is
checked per row and every 4096 pixels.

## Paths

Flagged on all five paths: `linear`, `graph`, `stream`, `actor`, `timed`.
Being a stateless `frame` operator, `actor` and `timed` call `frame` directly.

H.264/MP4 framecrc is not claimed: `mp4-h264.ts` treats any size change of a
linear stage as a scale. The uniform epx scale should keep the aspect ratio
there, but no H.264 comparison was made.

## Evidence

All comparisons run `.build/reference/ffmpeg`, built in the sandbox for Linux
x86_64 (sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`).

`tests/differential/video-epx.test.ts`:

| Test | Comparisons |
|---|---|
| `matches native epx2 and epx3 pixels across packed RGBA formats, sizes and structured patterns` | 320 frames: 4 formats x n {2,3} x sizes 1x1, 3x3, 5x4, 13x9 x 10 patterns (few-colour blocks, diagonals, 1-pixel features, checkerboards, staircases, few-colour noise, byte noise), raw bytes from 32 native runs. 192 frames differ from plain replication, so the rules are exercised. |
| `matches native linear and graph epx plans with scalar conversions around the packed RGBA stage` | 200 cases, each compared on the linear plan and the frame graph: sources rgba, abgr, rgb24, gray, yuv420p; two sizes; five chains; four targets; `-cpuflags 0` against `arithmetic:'scalar'` |
| `matches native replayed epx streams with branches and joins frame by frame` | 16 replay streams (4 format pairs x 4 graphs, including split/hstack and nullsink), 5 frames each, with timestamps |
| `matches native epx CLI rawvideo and framecrc on the linear, graph, actor and timed paths` | 152 CLI runs: 4 formats x 4 chains x rawvideo and framecrc, through `createMediaBackend` (`-vf` and `-filter_complex`) and the timed backend's `producer`, `activation` and `pull` schedulers |
| `refuses epx output above maxFrameBytes and options native rejects before any output is opened` | `maxFrameBytes` refusal on the scaled output (input fits, output does not); 4 option forms that native rejects, refused on the media, actor and timed backends with no output opened |

Mutation check: removing `timed` (or `actor`) from the flags makes the CLI test
fail on the `pull` (or `producer`) scheduler.

`tests/unit/video-epx.test.ts` covers parsing and refusals, hand-derived epx2 and
epx3 outputs, alpha-only word differences, the budget, malformed strides and
storage, plane count, time base, `AbortSignal`, an unmutated input, and geometry
and timed sample aspect ratio on the linear, graph and timed planners.
`tests/unit/video-operator-registry.test.ts` (unchanged) runs the descriptor
examples on all five paths and checks that they agree.

## Scoped test contracts

| Contract | File | Test | Scope |
|---|---|---|---|
| `filter.epx.kernel` | `tests/differential/video-epx.test.ts` | `matches native epx2 and epx3 pixels across packed RGBA formats, sizes and structured patterns` | kernel, 4 formats, n 2 and 3 |
| `filter.epx.linear-graph` | `tests/differential/video-epx.test.ts` | `matches native linear and graph epx plans with scalar conversions around the packed RGBA stage` | linear, graph |
| `filter.epx.stream` | `tests/differential/video-epx.test.ts` | `matches native replayed epx streams with branches and joins frame by frame` | stream |
| `filter.epx.cli` | `tests/differential/video-epx.test.ts` | `matches native epx CLI rawvideo and framecrc on the linear, graph, actor and timed paths` | linear, graph, actor, timed; rawvideo and framecrc |
| `filter.epx.refusals` | `tests/differential/video-epx.test.ts` | `refuses epx output above maxFrameBytes and options native rejects before any output is opened` | refusals |

## Unsupported

- expression-valued or non-decimal `n`;
- `enable=`, generic filter-context options and runtime commands;
- H.264/MP4 framecrc (not compared);
- timed-backend inputs that need a pixel conversion before epx (only packed RGBA
  sources were compared there).
