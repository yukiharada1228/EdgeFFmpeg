# field video filter

`field` extracts the top or bottom field of each frame, following pinned FFmpeg
`libavfilter/vf_field.c` (`field_options`, `config_props_output`, `filter_frame`)
at `946fcce07b6dcd0331c8cc609192aeff5e1924f8`. The descriptor is
`packages/avfilter/src/video-ops/field.ts`; provenance is in
`packages/avfilter/NOTICE-FIELD`.

## Syntax

| Form | Meaning |
|---|---|
| `field`, `field=top`, `field=0`, `field=type=top` | top field: rows 0, 2, 4, ... |
| `field=bottom`, `field=1`, `field=type=bottom` | bottom field: rows 1, 3, 5, ... |

A repeated `type` keeps the last value, as native does. Everything else is refused
during parsing, before any output is opened: other values (`2`, `Bottom`, `1.0`,
`0x1`, expressions such as `top+1`), unknown options, `enable=` (native field has
no timeline support) and runtime commands. `field=` with an empty option string is
the default, as natively.

## Geometry and formats

- Output height is `(h + top) / 2`; width and sample aspect ratio are unchanged, so
  timed plans keep the input aspect (no `timedGeometry`).
- Every plane is copied every second row, starting at row 1 for `bottom`, into owned
  tight planes. The frame timestamp and metadata are copied.
- Formats: native has no `query_formats`, so the descriptor has no `formats` and
  accepts the whole negotiation table (14 formats). `frame` refuses anything outside
  that table.

## Refusals (native-accepted, deliberately refused)

| Case | Native behaviour | Here |
|---|---|---|
| `bottom` on `h == 1` | zero-height link; exits 0 and still muxes 5-byte packets | `Field bottom of a one-row input gives an empty frame` |
| `bottom`, yuv420p/yuva420p/nv12/nv21, `h % 4 == 2` | reads one chroma row past the plane | `Field bottom reads past the subsampled chroma plane for this height` |

The check is generic (per plane, the last selected row must exist in the input
plane), so it covers exactly those formats. It runs in `geometry` on every path,
including after an upstream `scale`, and is repeated in `frame` for reconfigured
frames.

## Paths

`linear`, `graph`, `stream`, `actor`, `timed`. All are proven against the Linux
native reference below.

## Evidence

`tests/differential/video-field.test.ts` (native run at test time, `-cpuflags 0`,
gradient-plus-LCG-noise inputs, width 5, three frames):

- 14 formats x heights {3,5,8,9,12} x {field, field=bottom, field=type=top, field=1}
  plus height 7 x those four and {field,hflip; field=bottom,hflip; scale=8:10,field;
  scale=8:12,field=bottom}, x {rawvideo, framecrc}: 784 cases on each of linear
  (`-vf`), graph (one-input `-filter_complex`), actor (timed backend `activation`
  scheduler) and timed (`pull` scheduler): 3136 byte-exact comparisons.
  (`scale=8:10,field=bottom` is itself a refused case for subsampled chroma, so the
  bottom chain uses height 12.)
- Replay streams (`createReplayVideoExecution`): 14 formats x heights {5,8} x four
  graphs including split/vstack of both fields and scale chains around field: 98
  rawvideo comparisons, timestamps checked.
- Multi-input CLI (stream path): 5 formats x {rawvideo, framecrc}, two outputs each:
  20 comparisons.
- Refusals: h==1 (gray, yuv444p) and h%4==2 (yuv420p 6, yuva420p 10, nv12 2,
  nv21 14) on linear, graph, actor and timed: 24 checks; no output is opened, and
  native is confirmed to accept each of them.

`tests/unit/video-field.test.ts` covers parsing, geometry for every table format and
heights 2-14, row selection with padded strides, budgets, malformed strides and
plane counts, time bases, `AbortSignal` and an unmutated input.
`tests/unit/video-operator-registry.test.ts` runs the descriptor examples on all
five paths.

Determinism: plain row copy, no arithmetic. macOS and Linux natives matched
(7x5 top, 8x8 bottom) per the selection notes.

## Unsupported

- `type` values other than `top`, `bottom`, `0`, `1`; option expressions; `enable=`;
  runtime commands.
- The refused native cases above.
- The native filter clears `AV_FRAME_FLAG_INTERLACED`; frame events here carry no
  interlaced flag from rawvideo input, so this is not modelled (for example for a
  following `setpts` reading `INTERLACED`).
- Zero-frame H.264/MP4 framecrc output is not claimed: `packages/avformat/src/mp4-h264.ts`
  derives the sample aspect ratio by operator name and treats field's size change as
  a scale.

## Scoped test contracts

| File | Test title | Scope |
|---|---|---|
| tests/differential/video-field.test.ts | matches native field across every table format, both types, heights and the chained scopes on linear graph actor and timed paths | 784 rawvideo/framecrc cases per path |
| tests/differential/video-field.test.ts | matches native replayed field streams with a second branch and geometry propagated into vstack | 98 replay-stream rawvideo cases |
| tests/differential/video-field.test.ts | matches native two-input field streams in rawvideo and framecrc through the multi-input CLI | 10 two-output cases |
| tests/differential/video-field.test.ts | refuses bottom fields of one-row inputs and of subsampled chroma at h % 4 == 2 before opening any output on every path | 24 refusals |
