# pixelize video filter

`pixelize` follows pinned `libavfilter/vf_pixelize.c` (FFmpeg 9.0.2,
`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). It is one registry descriptor,
`packages/avfilter/src/video-ops/pixelize.ts` (role `frame`), registered with one
import line and one array line in `video-ops/registry.ts`. Provenance is in
`packages/avfilter/NOTICE-PIXELIZE`.

## Syntax

`pixelize[=width:height:mode:planes]`, with the native shorthand order
(`width`, `height`, `mode`, `planes`) and aliases `w`, `h`, `m`, `p`.

| Option | Accepted | Default |
|---|---|---|
| `width`/`w`, `height`/`h` | decimal or `0x` integers in [1, 1024]; out-of-range values fail as natively | 16 |
| `mode`/`m` | `avg`, `min`, `max`, or the integers 0, 1, 2 | `avg` |
| `planes`/`p` | `AV_OPT_TYPE_FLAGS` without a unit: decimal or `0x` integer terms, folded left with `+`/`-` from the current value (`8+1`, `-1` from the default gives 14, repeated keys fold). As natively, the declared range 0..15 is not enforced; terms above 4294967295 fail. | 15 |

Refused explicitly, before any output: `enable=` (native supports generic
timeline), runtime commands (refused by the registry because the descriptor sets
neither `timeline` nor `geometryCommands`), expression values that native
`av_expr` would accept (`w=2*3`, `w=max`, `h=4.5`, `mode=1+1`), the flag
constants `all`, `none`, `default`, `min`, `max` and any other named plane term,
unknown options and `threads`.

## Semantics

Per frame, as `filter_frame` does: chroma blocks are
`max(1, bw >> log2_chroma_w)` by `max(1, bh >> log2_chroma_h)`, and luma and alpha
blocks are the chroma size shifted back up. So `pixelize=1:1` on yuv420p gives 2x2
luma blocks and 1x1 chroma blocks, and `pixelize=3:2` on yuv422p gives 2x2 luma
blocks. Blocks at the right and bottom edges are partial. `avg` is the truncating
unsigned integer mean of the (partial) block, `min`/`max` the extreme sample.
Planes whose bit is clear in `planes` are copied. The output is owned, tight,
positive-stride planes; PTS and metadata are copied; the input is never mutated.
Frame, input storage, stride, plane count, time base and `AbortSignal` (per block
row) are checked like the other frame operators.

## Formats

`formats()` is the native `pix_fmts` list in declared order (58 formats: gray,
planar YUV, YUVA and GBR(A)P at every depth, `yuvj` included), so the shared
negotiators pick exactly what native picks. Frames run here in the eight-bit
layouts with frame storage, `yuv420p`, `yuv422p`, `yuv444p`, `gray`, `yuva420p`
and `gbrp`, and in the legacy `yuvj420p`/`yuvj422p`/`yuvj444p` sources of linear
chains. Other inputs receive native's automatic conversion (nv12/nv21 to yuv420p,
rgb24/bgr24 to gbrp).

Packed RGB with alpha (rgba, bgra, argb, abgr) converts to `gbrap` natively. `gbrap`
has no frame storage here, so the negotiators refuse it at plan time with
`Video filter pixelize input negotiates gbrap, which is not implemented`, on every
path and before any output is opened. Before the shared negotiation fix these
inputs silently negotiated another format and diverged; this document did not
list them.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed`. The operator is stateless and
uses `frame` on every path; no `actorFrame` is needed.

## Determinism

Integer only, no arithmetic profile dependence. Native slice threading splits by
block rows and cannot change results.

## Evidence

Against `.build/reference/ffmpeg` built on Linux x86_64
(sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`):

- `tests/differential/video-pixelize.test.ts`
  - *matches native pixelize across formats, modes, block sizes, plane masks and odd sizes on the linear and graph planners*:
    1080 native runs (6 formats x 2 sizes {9x7, 33x17} x 3 modes x 6 block sizes {1x1, 2x2, 3x2, 4x3, default 16, 40x40} x 5 plane masks {15, 1, 0x6, 8+1, -1}), each with a noise frame and a structured block-pattern frame, padded strides, compared byte for byte on both `compileVideoFilterChain` and `compileVideoFilterGraph`.
  - *matches native pixelize rawvideo and framecrc CLI outputs on the linear, graph, stream, actor and timed paths*:
    120 CLI comparisons (6 formats x 2 sizes x 5 paths x rawvideo/framecrc): `-vf` through `createMediaBackend` (linear), single-input `-filter_complex` (graph), two-input `-filter_complex` with `hstack` (stream), and `createTimedVideoBackend` with the `producer` (actor) and `pull` (timed) schedulers. Removing each path flag in turn makes exactly that path's case fail with its registry rejection, which shows each case reaches the intended executor.
  - *matches native replayed pixelize branches frame by frame through createReplayVideoExecution*: 12 replay comparisons including split/vstack branches.
  - *matches native option acceptance and outputs for integer, hex, folded and out-of-range values, refusing expressions explicitly*: 28 option strings: 15 accepted with identical output, 7 rejected by both, 6 accepted natively but refused here as out of scope.
  - *negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path*: `pixelize=3:2` from 17 sources (the 14 executable formats and yuvj420p/422p/444p), native's pick read from showinfo. 13 run byte-exact (`-cpuflags 0`, scalar) on the five paths (yuvj on linear chains); argb, rgba, abgr and bgra are refused naming `gbrap` on the five paths and through the media `-vf`/`-filter_complex` and timed producer/pull CLIs with no output opened: 89 checks.

After the shared negotiation fix the tests above ran on macOS arm64 against
the pinned reference (sha256 `1b86106f…ab92`). The Linux x86_64 runs predate the
re-land, which changed this operator's module and tests. The re-landed code,
including the per-source negotiation test, has run only on macOS arm64.
- `tests/unit/video-pixelize.test.ts`: parsing, refusals, kernel values (truncating average, partial edges, chroma block rounding, plane copies), formats, budgets, malformed strides, settings validation, `AbortSignal` and unmutated input.
- `tests/unit/video-operator-registry.test.ts` runs the three descriptor examples on all five paths and checks they agree.

## Unsupported

- `enable=` timeline and runtime commands.
- Expression and named-constant option values.
- Packed RGB with alpha, which negotiates `gbrap` natively: refused before output.
- High bit depth and other native formats without frame storage here (gray9..16, yuv410p/411p/440p, yuvj440p/411p, 9..16-bit YUV/GBR, yuva422p/444p, gbrap*): any negotiation that picks one is refused by name.
- No H.264/MP4 framecrc comparison was made; the operator keeps the frame size, so the MP4 aspect derivation is unaffected.
