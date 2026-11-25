# deflate video filter

`deflate` follows pinned `libavfilter/vf_neighbor.c` (the `deflate` kernel and the
`deflate_inflate` option class). Each output sample is

```
dst = max(min(sum8 / 8, p), max(p - threshold, 0))
```

where `sum8` is the integer sum of the eight neighbours of `p`. The neighbourhood
uses the native border tables: the row above or below is replaced by the current
row at the top and bottom edges, and the missing column at the left and right
edges is mirrored onto `x + 1` or `x - 1` (`coordinateslb`, `coordinatesrb`). A
plane whose threshold is `0` is copied unchanged, as `av_image_copy_plane` does.

The descriptor is `packages/avfilter/src/video-ops/deflate.ts`, registered with one
import line and one array line in `video-ops/registry.ts`. `deflateVideoFrame`
materializes owned tight positive-stride planes, keeps bigint PTS and metadata,
and checks `maxFrameBytes`, input plane storage, strides, the time base and the
`AbortSignal` (per row, and every 16384 samples within a row).

## Syntax

`deflate[=threshold0[:threshold1[:threshold2[:threshold3]]]]`, or named
`threshold0`..`threshold3` keys. Each is an `AV_OPT_TYPE_INT` in 0..65535 with
default 65535, parsed through the shared scoped integer-option helper: integer
expressions, the `default`/`min`/`max` constants and `llrint` half-to-even
rounding. Repeated keys keep the last value. Thresholds map to planes by index
(for gbrp: G, B, R; for yuva420p plane 3 is alpha).

Refused before any output is opened:

- `coordinates`: it belongs to the erosion/dilation class only, so native fails
  with `Option not found`. EdgeFFmpeg fails too (`Unsupported deflate option`).
- Out-of-range thresholds (native `out of range`) and a fifth positional value
  (native `No option name`).
- `enable=` (native timeline support is not implemented) and every other
  generic option (`threads`, and so on).
- Runtime commands: the descriptor sets neither `timeline` nor
  `geometryCommands`.
- A plane narrower than two samples whose threshold is nonzero: native
  `filter_slice` then reads one sample past the row (into the line padding).
  The refusal is raised from `geometry`, so it applies on every path with the
  negotiated format (for example yuv420p or yuv422p at width 2, whose chroma
  planes are one sample wide), and it is repeated in `frame`. A width-1 plane
  with threshold `0` is a copy and is accepted.

## Formats and paths

`formats()` is the native `vf_neighbor.c` `pix_fmts` list in declared order (57
formats: planar YUV, YUVA, GBR(A)P and gray at every depth, `yuvj` included), so
the shared negotiators pick exactly what native picks. Frames run in the eight-bit
layouts with frame storage, `yuv420p`, `yuv422p`, `yuv444p`, `gray`, `yuva420p`
and `gbrp`, and in the legacy `yuvj420p`/`yuvj422p`/`yuvj444p` sources of linear
chains. Other inputs are converted by negotiation, as in native (nv12/nv21 to
yuv420p, rgb24/bgr24 to gbrp). The size is unchanged.

Packed RGB with alpha (rgba, bgra, argb, abgr) converts to `gbrap` natively,
which has no frame storage here. The negotiators refuse it at plan time with
`Video filter deflate input negotiates gbrap, which is not implemented`, on every
path and before any output is opened. Before the shared negotiation fix these
inputs silently negotiated another format and diverged; this document did not
list them.

Flagged paths: `linear`, `graph`, `stream`, `actor` and `timed`. The operator is
stateless, so the actor and timed executors call `frame` directly.

## Determinism

Integer arithmetic only, with no platform-dependent rounding. The kernel is
eight-bit; native's 16-bit variant is unreachable because a high-depth pick is
refused (no frame storage here).

## Evidence

`tests/differential/video-deflate.test.ts` runs `.build/reference/ffmpeg`
(`-cpuflags 0`) at test time with inputs already in deflate's own formats. The
matrix is 6 formats x 4 sizes (2x3, 3x3, 9x7, 16x12) x 2 patterns (LCG noise and
hard-edged blocks) x 9 threshold sets (default; all 0, 1, 10 and 255; mixed
per-plane sets; and an expression/rounding set). Each input has two frames.

| Test | Comparisons |
|---|---|
| `matches native deflate through the linear, frame graph and replay APIs across formats, thresholds, sizes and patterns` | 390 native rawvideo outputs, each matched byte for byte by `compileVideoFilterChain`, `compileVideoFilterGraph` and `createReplayVideoExecution`. 42 width-1 cases were refused on all three. |
| `matches native deflate rawvideo and framecrc bytes on every flagged CLI path` | 3900 native rawvideo and framecrc outputs matched through the CLI frontend: `-vf` (linear), single-input `-filter_complex` (graph), multi-input `-filter_complex` (stream), the timed backend's `producer` scheduler (actor) and its `pull` scheduler (timed). 420 width-1 runs were refused without opening an output. |
| `fails like native for the erosion-only coordinates option and out-of-range thresholds before opening outputs on every path` | 25 failures on both sides (5 option errors x 5 paths), with the native diagnostic checked and no output opened. |
| `copies width-1 planes with zero thresholds like native and refuses nonzero ones before opening outputs on every path` | 50 accepted width-1 copies matched, and 40 refusals. |
| `negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path` | `deflate=threshold0=10:threshold2=3` from 17 sources (the 14 executable formats and yuvj420p/422p/444p), native's pick read from showinfo: 13 run byte-exact (`-cpuflags 0`, scalar) on the five paths (yuvj on linear chains); argb, rgba, abgr and bgra are refused naming `gbrap` on the five paths and through the media `-vf`/`-filter_complex` and timed producer/pull CLIs with no output opened. 89 checks. |

After the shared negotiation fix every test was rerun on macOS arm64 against the
pinned reference (sha256 `1b86106f…ab92`).

`tests/unit/video-deflate.test.ts` covers parsing, refusals, budgets, malformed
strides, plane counts, the time base, `AbortSignal`, hand-computed border cases
and an unmutated input. `tests/unit/video-operator-registry.test.ts` runs the
descriptor examples on all five paths.

## Unsupported

- The `enable=` timeline, runtime commands and generic filter options.
- Width-1 planes with a nonzero threshold.
- High-bit-depth formats and the other native formats without frame storage here
  (yuva444p, yuva422p, yuv440p, yuv411p, yuv410p, yuvj440p, yuvj411p, gbrap): a
  negotiation that picks one, such as packed RGB with alpha (`gbrap`), is refused
  by name before output.
- H.264/MP4 framecrc input has no dedicated comparison. The size is unchanged,
  so the `mp4-h264.ts` aspect derivation is unaffected.
