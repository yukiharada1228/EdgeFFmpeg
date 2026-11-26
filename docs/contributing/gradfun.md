# gradfun video filter

`gradfun` follows pinned `libavfilter/vf_gradfun.c` (commit 946fcce0). It debands by
fitting each 2x2 block to a box-blurred gradient and adding a bounded, ordered-dither
correction:

```
pix   = src << 7
delta = dc - pix                         // dc: blurred 2x2 half-row sums, scaled to src << 7
m     = max(0, 127 - (|delta| * thresh >> 16))
pix  += (m * m * delta >> 14) + dither[y & 7][x & 7]
dst   = clip_uint8(pix >> 7)
```

`thresh = (int)((1 << 15) / strength)` in float32, the luma radius is
`av_clip((radius + 1) & ~1, 4, 32)`, and the chroma radius is the `config_input` value
`av_clip((((r >> hsub) + (r >> vsub)) / 2 + 1) & ~1, 4, 32)`. A plane is filtered only
when `min(w, h) > 2r`; any other plane is copied, as `filter_frame` does.

The descriptor is `packages/avfilter/src/video-ops/gradfun.ts`, registered with one import
line and one array line in `video-ops/registry.ts`. It ports `ff_gradfun_blur_line_c` (an
`r`-row ring of cumulative `uint16` 2x2 sums, with the window sum taken modulo 2^16),
the sliding horizontal box with `dc_factor = (1 << 21) / (r * r)` and the native
right-edge and `-r/2` left-edge fills, `ff_gradfun_filter_line_c`, the row-pair loop of
`filter()` and the fixed 8x8 dither table. `gradfunVideoFrame` writes owned tight planes,
keeps bigint PTS and metadata, and checks `maxFrameBytes` (output, resident input planes
and the blur buffer), strides, plane counts, the time base and the `AbortSignal` per row.

## Syntax

`gradfun[=strength[:radius]]`, or named `strength` and `radius`. Repeated keys keep the
last value.

- `strength`: `AV_OPT_TYPE_FLOAT`, default 1.2, range 0.51..64. The double is checked
  against the range and then stored as float32, as `write_number` does. Only constant
  decimal numbers are accepted (`1`, `2.5`, `.75`, `1e1`).
- `radius`: `AV_OPT_TYPE_INT`, default 16, range 4..32, parsed through the shared scoped
  integer-option helper (integer expressions, `default`/`min`/`max`, half-to-even
  rounding), then rounded to even by `init`.

Refused before any output is opened:

- Out-of-range values (native `out of range`), unknown options such as `threshold`
  (native `Option not found`) and a third positional value (native `No option name`).
- Strength expressions, constants or SI suffixes (`1+1`, `max`, `1k`): native accepts
  them; they are refused here with `Only constant decimal gradfun strength values are
  implemented`.
- `enable=` (native has generic timeline support; not implemented here) and other
  generic options.
- Runtime commands: native has none, and the descriptor sets neither `timeline` nor
  `geometryCommands`.
- A filtered plane exactly `2r + 1` rows tall (for example gray 9x9 at radius 4, gray
  40x33 at the default radius, or yuv420p 40x34, whose 17-row chroma uses chroma radius
  8). The main loop then never blurs, so native filters those rows with the ring and `dc`
  state left by the previous plane or frame. `tests/differential/video-gradfun.test.ts`
  shows that three identical 9x9 frames give different native outputs. The refusal is in
  `geometry` with the negotiated format, so every path refuses it, and `frame` repeats it.

Native accepts tiny frames (1x1, 2x2, 5x3 and so on) and copies them, because
`min(w, h) <= 2r`. They are accepted here and match native byte for byte; the only
size-dependent refusal is the `2r + 1` case above.

## Formats and paths

`formats()` is the native `pix_fmts` list in declared order: `yuv410p yuv420p gray yuv444p
yuv422p yuv411p yuv440p gbrp`. Frames run in the members with frame storage: `gray`,
`yuv420p`, `yuv422p`, `yuv444p` and `gbrp`. Every one of the 17 negotiation sources picks
one of these natively (rgb24/bgr24 and packed RGBA to gbrp, nv12/nv21/yuva420p/yuvj420p to
yuv420p, yuvj422p to yuv422p and yuvj444p to yuv444p), so no source is refused for its
format. The size is unchanged.

Flagged paths: `linear`, `graph`, `stream`, `actor` and `timed`. Each frame starts with
a fresh blur state, so the operator is stateless and the actor and timed executors call
`frame` directly.

## Determinism

Integer arithmetic only, apart from the threshold. That is one float32 division of
32768 by the float32 strength, computed as `Math.trunc(Math.fround(32768 / strength))`.
That double result rounded to float32 is the correctly rounded float32 quotient, so it
gives the same value on every platform. The `v * dc_factor` product stays below 2^31. No
case is gated on Linux.

## Evidence

`tests/differential/video-gradfun.test.ts` runs `.build/reference/ffmpeg` (`-cpuflags 0`)
at test time and checks that `.build/reference/build-metadata.json` gives commit 946fcce0
and `--disable-x86asm`. Inputs are in gradfun's own storage formats (gray, yuv420p,
yuv422p, yuv444p, gbrp), with 3 frames each. The sizes are 1x1, 2x2, 5x3, 7x5, 8x6, 17x9,
9x9, 16x16, 40x23, 41x34 and 70x66. The patterns are LCG noise, slow banding ramps, hard
edges and constant planes.

| Test | Comparisons |
|---|---|
| `reads the sandbox reference build metadata` | commit and `--disable-x86asm` |
| `matches native gradfun through the linear, frame graph and replay APIs across formats, strengths, radii, sizes and patterns` | 5 formats x 11 sizes x 4 patterns x 8 option sets (defaults, strength 0.51 and 64, radius 4 and 32, `7.3:5`, `0.51:4`, `64:31`). 1656 native rawvideo outputs, each matched byte for byte by `compileVideoFilterChain`, `compileVideoFilterGraph` and `createReplayVideoExecution`. In 224 of them native's output differs from the input. 104 cases with a `2r + 1` plane are refused on all three APIs. |
| `matches native gradfun rawvideo and framecrc bytes on every flagged CLI path` | 3960 native rawvideo and framecrc outputs matched through the CLI frontend: `-vf` (linear), single-input `-filter_complex` (graph), multi-input `-filter_complex` with a nullsink branch (stream), the timed backend's `producer` scheduler (actor) and its `pull` scheduler (timed). The matrix is 5 formats x 11 sizes x noise/ramp x 4 option sets x 2 muxers x 5 paths. 440 `2r + 1` runs are refused without opening an output. |
| `matches native gradfun with -ss and -t on every flagged CLI path` | 240 rawvideo and framecrc outputs with `-ss 0.04`, `-t 0.05` and `-ss 0.04 -t 0.04` on the five paths |
| `shows native filtering 2*radius+1-row planes from stale state and refuses them before opening outputs on every path` | native frame 2 differs from frame 1 for identical 9x9 input frames; 20 refusals (4 geometries x 5 paths) with no output opened |
| `fails like native for out-of-range options, unknown options and extra positional values before opening outputs on every path` | 30 failures on both sides (6 option errors x 5 paths), with the native diagnostic checked and no output opened |
| `negotiates every accepted source as native does and matches every pick on every path, all of them with storage here` | `gradfun=radius=4` at 20x12 from the 17 sources: every pick is byte-exact on the five paths (yuvj sources on linear chains). 73 checks. |

The file ran in 3m04s with `--maxWorkers=1` in the sandbox. `tests/unit/video-gradfun.test.ts`
(5 tests) covers parsing, the float32 thresholds, radius rounding, every refusal,
`maxFrameBytes`, the resident input and blur-buffer limits, malformed strides, plane counts,
the time base, `AbortSignal`, an unmutated input, owned output planes and the planners.
`tests/unit/video-operator-registry.test.ts` runs the descriptor examples on all five paths:
`gradfun`, `gradfun=strength=3:radius=4,hflip` and `scale=24:20,gradfun=64:5`. The last one
filters, because the 8x8 source is only ever copied.

Sandbox reference: `.build/reference/ffmpeg` sha256
`ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built with
`cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`. This is not the pinned linux-x64 binary,
and no test pins its digest.

## Proposed contracts

All in `tests/differential/video-gradfun.test.ts`, modes linear, graph, stream, actor and
timed, on every platform:

| id | Test title | Scope |
|---|---|---|
| `filter.gradfun.api` | `matches native gradfun through the linear, frame graph and replay APIs across formats, strengths, radii, sizes and patterns` | API byte equality and `2r + 1` refusals |
| `filter.gradfun.cli` | `matches native gradfun rawvideo and framecrc bytes on every flagged CLI path` | CLI rawvideo and framecrc on five paths |
| `filter.gradfun.time` | `matches native gradfun with -ss and -t on every flagged CLI path` | `-ss` and `-t` |
| `filter.gradfun.stale` | `shows native filtering 2*radius+1-row planes from stale state and refuses them before opening outputs on every path` | stale-state refusal |
| `filter.gradfun.reject` | `fails like native for out-of-range options, unknown options and extra positional values before opening outputs on every path` | option refusals |
| `filter.gradfun.negotiation` | `negotiates every accepted source as native does and matches every pick on every path, all of them with storage here` | per-source negotiation |

## Unsupported

- `enable=`, runtime commands and generic filter options.
- Strength expressions, constants and suffixes.
- Filtered planes exactly `2r + 1` rows tall (native reads stale state).
- yuv410p, yuv411p and yuv440p (no frame storage here). No negotiation source picks them.
- H.264/MP4 framecrc input has no dedicated comparison. The size is unchanged, so the
  `mp4-h264.ts` aspect derivation is unaffected.
