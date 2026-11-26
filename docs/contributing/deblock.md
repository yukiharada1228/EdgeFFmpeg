# deblock video filter

`deblock` follows pinned `libavfilter/vf_deblock.c` (commit 946fcce0): the
`deblockh8`/`deblockv8` weak and strong kernels, `config_output`'s threshold
conversion and plane sizes, and `filter_frame`'s block loop. The descriptor is
`packages/avfilter/src/video-ops/deblock.ts`, registered with one import line and
one array line in `video-ops/registry.ts`. `deblockVideoFrame` copies the input
into owned tight positive-stride planes, then filters the selected planes in
place, in native order. It keeps bigint PTS and metadata and checks
`maxFrameBytes`, input plane storage, strides, the time base and the
`AbortSignal` (per copied row and per block row).

## Syntax

`deblock[=filter[:block[:alpha[:beta[:gamma[:delta[:planes]]]]]]]`, or named keys.

| Option | Type | Range | Default |
|---|---|---|---|
| `filter` | int with constants `weak` (0) and `strong` (1) | 0..1 | `strong` |
| `block` | int | 4..512 | 8 |
| `alpha`, `beta`, `gamma`, `delta` | float | 0..1 | 0.098, 0.05, 0.05, 0.05 |
| `planes` | int bit mask by plane index | 0..15 | 15 |

The int options use the shared scoped integer-option helper (expressions,
`default`/`min`/`max`, `llrint` half-to-even rounding). The float options take a
decimal literal: the double is range-checked and then stored as a float
(`Math.fround`). Repeated keys keep the last value.

The thresholds are converted once, as `config_output` does at depth 8:
`ath = (int)(alpha * 255)` with the product in float, so the default alpha gives
`trunc(fround(fround(0.098) * 255)) = 24` and the other defaults give 12.

Refused before any output is opened:

- Out-of-range values (native `out of range`), unknown `filter` names (native
  `Unable to parse`), unknown keys (native `Option not found`) and an eighth
  positional value (native `No option name`).
- Expression-valued or hexadecimal floats (`alpha=1/2`, `gamma=0x1`), which
  native accepts. Only decimal literals are implemented.
- `enable=` (the native generic timeline is not implemented), every other
  generic option (`threads`, and so on) and runtime commands: the descriptor
  sets neither `timeline` nor `geometryCommands`, so native's
  `process_command` (which re-runs `config_output`) is not reachable.
- Edges whose native kernels read outside the plane. A vertical edge at column
  `x` reads `x+1` (weak) or `x+1..x+2` (strong). The last edge is the largest
  multiple of `block` below the plane width, so a selected plane wider than
  `block` with `width % block == 1` (weak) or `width % block` in 1..2 (strong)
  would read, and write, past the row. The refusal comes from `geometry` with the
  negotiated format, so it uses chroma widths too and applies on every path. It
  is repeated in `frame`. Unselected planes are only copied, so they do not
  count.

## Kernel and block loop

`filter_frame` filters vertical edges at `x = block, 2*block, ...` and
horizontal edges at `y = block, 2*block, ...` while `y < height - block`, then
runs one last band of vertical edges. The frame borders are skipped: there is no
edge at x=0 or y=0, and no horizontal edge at the last block row at or below
`height - block`. The order of calls is kept exactly, because each kernel reads
pixels that earlier calls have already changed.

The kernels use C integer division (truncation toward zero) and clip to 0..255.
They also keep a native quirk. In `deblockv*_weak` and `deblockv*_strong`, the
row pointer advances at the end of the loop body (`dst += dst_linesize`), and
the skip branch's `continue` jumps past it. After the first row of an edge
segment fails a threshold test, every remaining iteration re-tests that same
unchanged row and skips again. In effect, a vertical edge segment stops at its
first skipped row. The horizontal kernels advance in the `for` header and
continue normally. The port stops vertical segments at the first skipped row.
This is checked against native in a dedicated test and is exercised throughout
the matrix. A first port that advanced the row failed the matrix against native.

## Formats and paths

`formats()` is the native `pixel_fmts` list in declared order, all 57 entries
(planar YUV, YUVA, GBR(A)P and gray at every depth, `yuvj` included,
native-endian names), so the shared negotiators pick what native picks. Frames
run in the members with storage here (`gray`, `yuv420p`, `yuv422p`, `yuv444p`,
`yuva420p` and `gbrp`) and in the legacy `yuvj420p`/`yuvj422p`/`yuvj444p`
sources of linear chains. Native converts nv12/nv21 to yuv420p and rgb24/bgr24
to gbrp, and so does the port. Packed RGB with alpha (argb, rgba, abgr, bgra)
converts natively to `gbrap`, which has no storage here, so the shared
negotiators refuse it by name on every path before output. The size is
unchanged.

Flagged paths: `linear`, `graph`, `stream`, `actor` and `timed`. The operator is
stateless, so the actor and timed executors call `frame`.

## Determinism and arithmetic profile

The float thresholds are converted once, at parse time, through IEEE single
precision (`Math.fround`), which gives the same result on every platform.
Everything after that is integer arithmetic. Native's 16-bit kernels are
unreachable, because high-depth picks are refused. There are no Linux-gated
cases, and every test runs on every platform. Native `deblock` has no slice
threading. The threads test confirms that default filter threads and
`-filter_threads 1` produce the same output.

## Evidence

`tests/differential/video-deblock.test.ts` runs `.build/reference/ffmpeg`
(`-cpuflags 0`) at test time. It first checks
`.build/reference/build-metadata.json` for commit 946fcce0 and
`--disable-x86asm`. It never pins a binary digest. Inputs are in deblock's own
formats and have 3 frames each. There are three patterns: per-plane LCG noise;
4x4 blocks with small steps (where the default thresholds bind) plus a hard edge
column; and ramps with constant chroma and alpha planes.

| Test | Comparisons |
|---|---|
| `runs against the sandbox reference build of commit 946fcce0 configured with --disable-x86asm` | metadata check |
| `matches native deblock through the linear, frame graph and replay APIs across formats, sizes, patterns and options` | 6 formats x 8 sizes (1x1, 2x2, 5x3, 7x5, 8x6, 17x9, 16x16, 33x17) x 3 patterns x 14 option sets (defaults; weak; strong at block 4; all four thresholds at 1, and each of beta, gamma and delta alone at 0; all at 0; block 512, larger than the frame; mixed thresholds with planes 5; threshold 3; planes 0). 1446 native rawvideo outputs, each matched byte for byte by `compileVideoFilterChain`, `compileVideoFilterGraph` and `createReplayVideoExecution` (245 of them differ from the input). 570 edge-reach cases are refused on all three. |
| `matches native deblock rawvideo and framecrc bytes on every flagged CLI path with and without -ss/-t` | 6 formats x 5 sizes (7x5, 8x6, 17x9, 16x16, 33x17), blocky input, x 5 option sets x rawvideo/framecrc x untrimmed and input `-ss 0.04` with output `-t 0.05`, on the five paths: `-vf` (linear), single-input `-filter_complex` (graph), two-input `-filter_complex` (stream), the timed backend's `producer` scheduler (actor) and its `pull` scheduler (timed). 1980 outputs matched. 1020 refusals with no output opened and the diagnostic checked. |
| `stops each vertical edge at its first skipped row like native on every CLI path` | 10 comparisons (weak and strong x 5 paths), each also asserting which rows native left unfiltered |
| `agrees with native under default filter threads and -filter_threads 1` | 9 cases: native default threads equals `-filter_threads 1`, and both equal the linear plan |
| `fails like native for out-of-range and unknown deblock options before opening outputs on every path` | 45 failures on both sides (9 option errors x 5 paths), with the native diagnostic checked and no output opened |
| `negotiates every accepted source as native does and refuses picks without storage before output on every path` | `deblock=block=4:alpha=1:beta=1:gamma=1:delta=1` from 17 sources. 13 run byte-exact on the five paths (yuvj on linear chains). argb, rgba, abgr and bgra (`gbrap`) are refused by name on the five paths and through the media and timed CLIs. 89 checks. |

The file takes about 31 s with `--maxWorkers=1` on 4 vCPUs.

`tests/unit/video-deblock.test.ts` (5 tests) covers parsing, threshold
truncation, every refusal, the formats list, the edge-reach geometry table
(including chroma and plane masks), hand-computed weak and strong kernels, the
border skips, the vertical stop, plane selection, budgets, malformed strides,
plane counts, the time base, `AbortSignal`, the unmutated input, owned output
planes and planning on the linear, graph, timed and actor paths.
`tests/unit/video-operator-registry.test.ts` (unedited, 8 tests) runs the
descriptor examples on all five paths.

Sandbox reference: `.build/reference/ffmpeg` sha256
`ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built with
`cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0` on linux x64 (Node v22.23.5).

## Proposed contracts

All entries are in `tests/differential/video-deblock.test.ts`. None is
platform-gated.

| id | Exact test title | Modes | Scope |
|---|---|---|---|
| `filter.deblock.api` | `matches native deblock through the linear, frame graph and replay APIs across formats, sizes, patterns and options` | linear, graph, stream | gray/yuv420p/yuv422p/yuv444p/yuva420p/gbrp, 8 sizes, weak/strong, block 4..512, thresholds 0..1, planes masks, rawvideo |
| `filter.deblock.cli` | `matches native deblock rawvideo and framecrc bytes on every flagged CLI path with and without -ss/-t` | linear, graph, stream, actor, timed | CLI rawvideo and framecrc, with and without input -ss and output -t, edge-reach refusals |
| `filter.deblock.vertical-stop` | `stops each vertical edge at its first skipped row like native on every CLI path` | linear, graph, stream, actor, timed | the native continue-skips-advance quirk of the vertical kernels |
| `filter.deblock.threads` | `agrees with native under default filter threads and -filter_threads 1` | linear | native thread-count independence |
| `filter.deblock.refusals` | `fails like native for out-of-range and unknown deblock options before opening outputs on every path` | linear, graph, stream, actor, timed | option range, name and arity errors with no output |
| `filter.deblock.negotiation` | `negotiates every accepted source as native does and refuses picks without storage before output on every path` | linear, graph, stream, actor, timed | per-source negotiation over the 17 shared sources |

## Unsupported

- The `enable=` timeline, runtime commands and generic filter options.
- Expression-valued and hexadecimal float thresholds.
- Edges within the kernel reach of a selected plane's right border (see above).
- High-bit-depth formats and the other native formats without storage here
  (yuva444p, yuva422p, yuv440p, yuv411p, yuv410p, yuvj440p, yuvj411p, gbrap). A
  negotiation that picks one, such as packed RGB with alpha (`gbrap`), is
  refused by name before output.
- H.264/MP4 framecrc input has no dedicated comparison. The size is unchanged,
  so the `mp4-h264.ts` aspect derivation is unaffected.
