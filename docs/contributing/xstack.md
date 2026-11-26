# xstack

`xstack` arranges two or more synchronized video inputs in a grid or in a custom mosaic. It is a scoped adaptation of pinned FFmpeg `libavfilter/vf_stack.c` (commit 946fcce0) and lives in `packages/avfilter/src/video-ops/xstack.ts` (descriptor and options) and `packages/avfilter/src/video-xstack.ts` (geometry and copy kernel). Provenance: `packages/avfilter/NOTICE-XSTACK`.

## Syntax

```
xstack[=inputs=N][:layout=x0_y0|x1_y1|...][:grid=CxR][:shortest=B][:fill=none]
```

Shorthand order is native declaration order: `inputs`, `layout`, `grid`, `shortest`, `fill` (`xstack=3:0_0|0_h0|w0_0`).

| Option | Accepted here | Refused here |
|---|---|---|
| `inputs` | decimal 2..32 (default 2); ignored when `grid` is given, as natively | other counts (native allows up to INT_MAX) |
| `layout` | exactly one `x_y` item per input, each coordinate a `+`-joined list of `w<i>`, `h<i>` or decimal terms (0..INT_MAX) | the forms native rejects with EINVAL (self or out-of-range references, missing items, unknown terms), and the lenient forms native also accepts: extra or empty items, extra `_` parts, whitespace, trailing text after a number |
| `grid` | decimal `CxR` with 2..32 cells; columns first, as AV_OPT_TYPE_IMAGE_SIZE stores width | size abbreviations (`hd720`), other separators, fewer than 2 or more than 32 cells |
| `shortest` | `0 1 true false yes no on off` | anything else |
| `fill` | `none` (the default) | every other value: native fills with ff_draw only when the colour parses, which changes the format list and the output |
| `enable`, `eof_action`, `repeatlast`, `ts_sync_mode`, any other key | – | refused (natively: no timeline support, exit 176; unknown options, exit 8) |

`layout` and `grid` together are refused (native EINVAL). Without either, `inputs=2` means `grid=2x1`, and any other count is refused (native EINVAL). Runtime commands are refused (no `timeline`, no `geometryCommands`).

Native adds the referenced input's **width** for `w<i>` in both coordinates (so `0_w0` offsets y by input 0's width), and its height for `h<i>`. This is kept.

## Geometry

The output is the bounding box of the placed inputs (grid: the row sums; layout: `max(w_i + x_i)` by `max(h_i + y_i)`), and input 0's sample aspect ratio, as in `config_output`. Grids need native's same-size rules: every input of a row has the first input's height (`Input k height … does not match current row's height …`) and every row has the first row's width (`Row r width … does not match previous row width …`).

Per plane, x offsets are `av_image_fill_linesizes` of the luma offset and y offsets are `AV_CEIL_RSHIFT(offset, log2_chroma_h)`, as natively. Only exact tilings are accepted, in `geometry()` (so before any output on every path) and again for every frame:

- **Uncovered bytes** are refused (`leaves plane p bytes uncovered`): native allocates the output from the frame pool and leaves them uninitialised.
- **Overlaps** are refused (`inputs i and j overlap in plane p`): `process_slice` copies inputs on parallel slice jobs, so overlapping bytes are written in a racy order. Measured on the sandbox reference: one yuv420p 17x9 graph with two overlapping xstacks gave 7 different outputs in 12 runs with default threads and one output with `-filter_complex_threads 1`. This deviates from the wave-2 specification text ("later inputs overwrite earlier ones"); input-order overwriting matched native only single-threaded (622 of 622 cases, including the overlap layouts, before overlaps were refused).
- **Chroma outside a plane** is refused (`placement exceeds the output plane`): with odd luma sizes, rounded-up chroma offsets plus rounded-up chroma sizes can pass the plane width or height, and native then writes into line padding or past the plane, which depends on the allocator's alignment. Example: `grid=2x1` of two yuv420p 5x3 inputs.
- Sums above INT_MAX are refused, as natively.

## Formats

`formats()` is native `query_formats` without fill: `ff_formats_pixdesc_filter(0, BITSTREAM|HWACCEL|PAL)`, i.e. every negotiable format in AVPixelFormat order except `monow`, `monob`, `pal8`, `bgr4`, `rgb4`, `xv30be` and `v30xbe`. All pads share one format. Every one of the 14 source formats is in the list, so native and every path keep the source format; the shared negotiators refuse by name any negotiated format without storage here.

## Paths

Role `join`, flagged `graph`, `stream`, `actor` and `timed` (never `linear`). Synchronization is the shared vf_stack join semantics: every input `sync=1`, `before=EXT_STOP`, `after=EXT_INFINITY`, or `EXT_STOP` under `shortest=1`. The output timestamp is the sync event's, with INT64_MIN clamped to INT64_MIN+1 as `av_rescale_q` does; the output carries no metadata (a new buffer).

## Determinism and arithmetic

Byte copies only: no arithmetic, no float, no platform dependence. Every accepted case is independent of native's thread count (232 agreements). No Linux-gated cases.

## Evidence (sandbox, `--maxWorkers=1`, about 9 s)

| Test (tests/differential/video-xstack.test.ts) | Count |
|---|---|
| graph-path rawvideo, 14 formats x 6 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9) x 12 equal-size layouts, distinct inputs (noise, ramps, edges, a constant plane), 3 frames | 662 native matches, 346 refusals by our geometry (overlaps, gaps, out-of-plane chroma) |
| CLI rawvideo and framecrc on the media backend (graph and stream): split-from-one-source grids, mixed sizes that tile exactly (layout and 2x2 grid), unequal lengths, `shortest=1`, input `-ss`, output `-t`, 12 formats | 168 |
| replay stream, unequal lengths 3/3/3, 3/1/2, 1/3/2, shortest 0 and 1 | 36 |
| timed backend, producer (actor) and pull (timed) schedulers, rawvideo and framecrc | 60 |
| native default threads vs `-filter_threads 1 -filter_complex_threads 1` | 232 |
| refusals: 16 graphs x 3 backends, exit non-zero, no output opened; native statuses recorded | 48 |
| per-source negotiation on graph, stream, actor and timed | 56 |

Unit tests (`tests/unit/video-xstack.test.ts`, 5) cover parsing and every refusal, geometry, copies into owned tight planes, `maxFrameBytes`, malformed strides and storage, timestamps, `AbortSignal` and unmutated inputs. The unchanged registry test runs the five descriptor examples on the four flagged paths and the linear rejection.

Native statuses for the refusal graphs (host errno for EINVAL): `fill=red`, `fill=bogus`, gaps, overlaps and out-of-plane chroma exit 0 natively (they are refused here only); layout with grid, no layout for 3 inputs, grid height/width mismatches and a self reference exit `256-EINVAL`; `enable=` exits 176 (AVERROR_PATCHWELCOME); `eof_action`, `repeatlast`, `ts_sync_mode` exit 8 (AVERROR_OPTION_NOT_FOUND).

Reference: sandbox build of 946fcce0 with `--disable-x86asm`, ffmpeg sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0` (unpinned; the tests check only the commit and the flag).

## Proposed contracts

All in `tests/differential/video-xstack.test.ts`, every platform:

| id | Exact test title | Scope |
|---|---|---|
| filter.xstack.kernel | matches native xstack rawvideo across formats, sizes, grids and layouts with distinct inputs on the graph path | 14 formats, 6 sizes, grids and layouts |
| filter.xstack.cli | matches native xstack CLI rawvideo and framecrc on the graph and stream paths, with mixed sizes, -ss, -t, unequal lengths and shortest | CLI graph/stream |
| filter.xstack.stream | matches native xstack on the stream path through replay execution with distinct sources of unequal length and shortest | replay stream sync |
| filter.xstack.timed | matches native xstack through the timed backend on the actor and timed paths in rawvideo and framecrc | actor and timed |
| filter.xstack.threads | agrees with native xstack under default threads and single-threaded filtergraphs for every accepted layout | thread independence |
| filter.xstack.refusals | refuses fill colours, layout with grid, gaps, overlaps, out-of-plane chroma and native EINVAL layouts before opening any output on every path | refusals |
| filter.xstack.negotiation | negotiates every source as native does on the join paths | 14 sources, 4 paths |
