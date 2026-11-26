# hqx video filter

`hqx` follows pinned `libavfilter/vf_hqx.c` (FFmpeg 9.0.2,
946fcce07b6dcd0331c8cc609192aeff5e1924f8). The descriptor is
`packages/avfilter/src/video-ops/hqx.ts`; the kernel `hqxVideoFrame`, the parser
`parseHqxOptions`, `hqxGeometry` and the per-pixel key `hqxRgbToYuv` live in
`packages/avfilter/src/video-hqx.ts`. Provenance is in `packages/avfilter/NOTICE-HQX`.

## Syntax

| Form | Meaning |
|---|---|
| `hqx` | `n=3` (native default) |
| `hqx=2`, `hqx=n=2`, `hqx=n=3`, `hqx=n=4` | shorthand position one is `n`; repeated keys keep the last value |

`n` is `AV_OPT_TYPE_INT` in `[2,4]`. Only plain decimal integers (optional `+`
and leading zeros) are implemented. Refused explicitly at parse time, before any
output is opened:

- `n` outside 2..4 (native also rejects these: `n=0`, `n=1`, `n=5`, `n=-3`);
- expression or non-decimal values (`n=2+1`, `n=0x2`, `n=4.0`), which native
  evaluates and accepts; they fail with `Only decimal integer hqx scale factors are implemented`;
- `enable=` (native `hqx` has no timeline support, so native rejects it too);
- every other option, including generic filter-context options such as `threads`;
- runtime commands (the descriptor sets neither `timeline` nor `geometryCommands`).

## Formats and geometry

`formats()` is the native list in declared order: the single
`FILTER_SINGLE_PIXFMT(AV_PIX_FMT_RGB32)`, which is `bgra` on the little-endian
hosts this runs on (x86_64, arm64, Workers). Every other source (rgba, argb,
abgr, rgb24, bgr24, gray, YUV, gbrp, yuvj) is converted to bgra by the shared
negotiator, as native negotiation does; `validate` repeats the format check.
The per-source negotiation test pins `bgra` for all 17 accepted sources.

`geometry()` returns `w*n` by `h*n`. Sizes whose output fails the
`av_image_check_size` bound are refused there and again in `frame`. There is no
`timedGeometry`, so timed plans keep the input sample aspect ratio, as native
`config_output` does. The scale is uniform, like epx, so the linear-path
H.264 framecrc aspect derivation is unaffected; no H.264 comparison was made.

## Arithmetic and determinism

Pure integer, identical on every platform. Pixels are read as native-endian
32-bit words (`0xAARRGGBB` for bgra), as native reads RGB32 through `uint32_t`
pointers.

- **YUV key.** Native fills a 2^24-entry `rgbtoyuv` table in `init` (64 MiB).
  `hqxRgbToYuv` evaluates the same integers per pixel instead: C truncating
  division, the `y` quotient taken at `startg` and incremented along `g` (as
  the table walk does), `u` and `v` wrapping as `uint32`, and the packed sum
  taken modulo 2^32. A unit test replays the whole `init` walk and checks all
  16,777,216 entries.
- **Pattern.** Bit *i* is set when the neighbour word differs from the centre
  (alpha included) and `yuv_diff` exceeds the Y/U/V thresholds 48/7/6 (alpha
  ignored).
- **Pattern tables.** `hq2x_interp_1x1`, `hq3x_interp_2x1` and
  `hq4x_interp_2x2` are ported clause by clause, with the `INTERP_BOOTSTRAP`
  mask shuffle tabulated once per call site (12 tables of 256 entries,
  including the rotated hq3x shuffles) and the call sites' permutations and
  output positions taken from `hqx_filter`.
- **Interpolation.** `interp_2px`/`interp_3px` work on the whole word in two
  16-bit lanes, so alpha is blended too, even when the pattern is empty (the
  default clause interpolates with the neighbours).
- **Edges.** Neighbours are replicated at every border exactly as the native
  `prevline`/`nextline`/`prevcol`/`nextcol` offsets do.

Native slice threading splits rows and every row reads the full frame, so
results do not depend on threads; the differential test checks native default
threads against `-filter_threads 1`. The kernel processes the whole frame.
Output is owned tight planes with positive strides; PTS and metadata are
copied. The output byte count is checked against `maxFrameBytes` before
allocation, as is the input plane storage. The signal is checked per row and
every 4096 pixels.

## Paths

Flagged on all five paths: `linear`, `graph`, `stream`, `actor`, `timed`.
Being a stateless `frame` operator, `actor` and `timed` call `frame` directly.

## Evidence

All comparisons run `.build/reference/ffmpeg`, built in the sandbox for Linux
x86_64 from 946fcce0 with `--disable-x86asm` (sha256
`ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`,
`cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`). The differential file asserts the
commit and flag from `.build/reference/build-metadata.json`; it pins no binary
digest and uses no committed goldens.

`tests/differential/video-hqx.test.ts` (about 100 s on 4 vCPUs):

| Test | Comparisons |
|---|---|
| `runs against the sandbox-built native reference at 946fcce0 configured with --disable-x86asm` | build metadata |
| `matches native hq2x, hq3x and hq4x pixels on bgra across sizes, structured patterns and noise with default and single filter threads` | 270 frames: n {2,3,4} x sizes 1x1, 2x2, 5x3, 7x5, 8x6, 17x9 x 15 frames (pixel-art blocks, diagonals, single pixels, checkerboards, staircases, threshold-straddling palettes, alpha-only differences, constant plane, colour and alpha gradients, few-colour noise, byte noise), from 36 native runs; the 18 default-thread outputs equal the `-filter_threads 1` outputs. 180 frames differ from plain replication. |
| `matches native linear and graph hqx plans with scalar conversions from rgba, rgb24 and other packed and gray sources` | 96 cases, each compared on the linear plan and the frame graph: sources rgba, rgb24, bgr24, argb, abgr, gray; 5x3 and 8x6; four chains; native and rgb24 targets; `-cpuflags 0` against `arithmetic:'scalar'` |
| `matches native replayed hqx streams with branches and joins frame by frame` | 12 replay streams (bgra, rgba, rgb24 x 4 graphs, including split/hstack, transpose and nullsink), 3 frames each, with timestamps |
| `matches native hqx CLI rawvideo and framecrc with and without -ss/-t on the linear, graph, actor and timed paths` | 252 CLI runs: bgra, rgba, rgb24 sources x 3 chains x rawvideo and framecrc x {no trim, input `-ss 0.04` with output `-t 0.05`, output `-ss 0.04 -frames:v 1`}, 3 frames, through `createMediaBackend` (`-vf` and `-filter_complex`) and the timed backend's `producer`, `activation` and `pull` schedulers |
| `negotiates every accepted source to bgra as native does, byte-exact on every path` | 73 checks: 17 sources (legacy yuvj on linear only), native pick read from showinfo, rawvideo bytes on all five paths |
| `refuses hqx output above maxFrameBytes and options native rejects or scopes out before any output is opened` | `maxFrameBytes` refusal on the scaled output; 6 option forms native rejects and 3 it accepts but this scope refuses, each refused on media `-vf`, media `-filter_complex`, producer and pull with no output opened |

Mutation check: removing `actor` (or `timed`) from the flags makes the CLI test
fail on the `producer` (or `pull`) scheduler.

`tests/unit/video-hqx.test.ts` covers parsing and refusals, the exhaustive YUV
key check, native-derived hq2x/hq3x/hq4x outputs on a diagonal, alpha blending
with an empty pattern, constant and 1x1 replication, the budget, malformed
strides and storage, padded strides, plane count, time base, `AbortSignal`, an
unmutated input, and geometry, bgra conversion and timed sample aspect ratio on
the linear, graph and timed planners. `tests/unit/video-operator-registry.test.ts`
(unchanged) runs the descriptor examples on all five paths and checks that they agree.

## Scoped test contracts

All are integer cases with no platform gate.

| Contract | File | Test | Scope |
|---|---|---|---|
| `filter.hqx.kernel` | `tests/differential/video-hqx.test.ts` | `matches native hq2x, hq3x and hq4x pixels on bgra across sizes, structured patterns and noise with default and single filter threads` | kernel, n 2..4, six sizes, threads |
| `filter.hqx.linear-graph` | `tests/differential/video-hqx.test.ts` | `matches native linear and graph hqx plans with scalar conversions from rgba, rgb24 and other packed and gray sources` | linear, graph |
| `filter.hqx.stream` | `tests/differential/video-hqx.test.ts` | `matches native replayed hqx streams with branches and joins frame by frame` | stream |
| `filter.hqx.cli` | `tests/differential/video-hqx.test.ts` | `matches native hqx CLI rawvideo and framecrc with and without -ss/-t on the linear, graph, actor and timed paths` | linear, graph, actor, timed; rawvideo and framecrc |
| `filter.hqx.negotiation` | `tests/differential/video-hqx.test.ts` | `negotiates every accepted source to bgra as native does, byte-exact on every path` | all five paths, 17 sources |
| `filter.hqx.refusals` | `tests/differential/video-hqx.test.ts` | `refuses hqx output above maxFrameBytes and options native rejects or scopes out before any output is opened` | refusals |

## Unsupported

- expression-valued or non-decimal `n`;
- `enable=`, generic filter-context options and runtime commands;
- big-endian hosts (RGB32 would be argb there); `hqxGeometry` refuses them, so every path fails at plan time;
- H.264/MP4 framecrc (not compared).
