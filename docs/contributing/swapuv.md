# swapuv video filter

`swapuv` follows pinned `libavfilter/vf_swapuv.c` (FFmpeg 9.0.2, commit
946fcce07b6dcd0331c8cc609192aeff5e1924f8). Native swaps the `data[1]`/`data[2]`
pointers; `swapuvVideoFrame` in `packages/avfilter/src/video-ops/swapuv.ts`
materializes the same result into owned tight positive-stride planes: plane 0
(luma) and plane 3 (alpha) are copied, planes 1 and 2 are exchanged. Bigint PTS
and metadata are copied. Frame size, resident storage, plane count, stride,
time base and `AbortSignal` (checked per row) are enforced.

## Syntax and scope

- `swapuv` only. It takes no options: any option, including `enable=` (native
  `AVFILTER_FLAG_SUPPORT_TIMELINE_GENERIC`) and generic context options such as
  `threads=`, fails with `Timeline and reflection options are not implemented`
  before any output is opened. Runtime commands are refused by the registry,
  because the descriptor sets neither `timeline` nor `geometryCommands`.
- Formats: native `is_planar_yuv()` intersected with the negotiation table, in
  table order: `yuv420p`, `yuv422p`, `yuv444p`, `yuva420p`. `gbrp` fails the
  native plane==component check. Other inputs receive an automatic conversion.
  It matches native for nv12/nv21 (to yuv420p) and rgb24/bgr24/gbrp (to yuv444p).
- **Known divergence (needs a shared edit):** native converts `gray` to `yuvj444p`
  and `rgba`/`bgra`/`argb`/`abgr` to `yuva444p`. Neither format is in the shared
  negotiation table (`video-ops/formats.ts`) or the pixel layouts, so EdgeFFmpeg
  picks a different table format and its output differs from native. The
  descriptor only sees the negotiated format, so it cannot refuse these sources
  itself. A bare `swapuv` on gray or alpha-packed RGB input is therefore not
  native-equivalent. The registry examples use an explicit `format=` first.
  `tests/differential/video-swapuv.test.ts` pins both native choices.
- Paths: `linear`, `graph`, `stream`, `actor`, `timed`.

## Determinism

Pure plane copy, no arithmetic. Native was stable at `-filter_threads 1/3/default`
and on repeat runs, and macOS and Linux hashes matched. Implicit conversions are
tested only with `-cpuflags 0` natively and the `scalar` pixel arithmetic here.

## Evidence

All comparisons run `.build/reference/ffmpeg` (Linux x86_64) at test time, on
three-frame structured-plus-noise inputs in yuv420p, yuv422p, yuv444p, yuva420p,
nv12, rgb24 and gbrp (the last three auto-convert under `-cpuflags 0`), at 5x3, 7x5 and 8x6.

`tests/differential/video-swapuv.test.ts`:

- `matches native -vf swapuv rawvideo and framecrc across formats sizes and time scopes`:
  252 media-backend CLI runs (`swapuv`, `swapuv,hflip`, `format=yuv422p,swapuv`;
  rawvideo and framecrc; with and without `-ss`/`-t`), byte-exact.
- `matches native -filter_complex swapuv split branches through the media and timed backends`:
  252 native graphs over three split graphs, rawvideo/framecrc, with and without
  `-ss`/`-frames:v`, each compared on both outputs through the media backend and
  the timed backend (504 comparisons).
- `matches native swapuv frame by frame through replay streams and activation actors`:
  63 cases, each compared through `createReplayVideoExecution` and `createFrameActors`.
- `refuses swapuv options and timeline before opening outputs on every backend`: 6 cases.
- `records the native gray and packed-alpha conversions that fall outside the negotiation table`:
  10 native negotiation checks over the listed sources.

`tests/unit/video-swapuv.test.ts` covers parsing and refusals, the plane swap with
padded strides and an unmutated input, linear planning, `maxFrameBytes`, resident
storage, malformed strides and plane counts, invalid time bases and `AbortSignal`.

## Unsupported

- Native-equivalent auto-conversion of gray (yuvj444p) and packed RGB with alpha
  (yuva444p): not refused, but divergent (see above).

- `enable=` timeline expressions and every other option.
- Runtime commands (`sendcmd`/`zmq`).
- Native formats outside the negotiation table (yuv410p, yuv411p, 9-16 bit planar
  YUV, yuvj*, yuva422p/444p, ...): such inputs are not decodable here.

## Scoped test contracts

| id | file | test title | scope |
|---|---|---|---|
| filter.swapuv.cli | tests/differential/video-swapuv.test.ts | matches native -vf swapuv rawvideo and framecrc across formats sizes and time scopes | linear |
| filter.swapuv.graph | tests/differential/video-swapuv.test.ts | matches native -filter_complex swapuv split branches through the media and timed backends | graph, timed |
| filter.swapuv.stream | tests/differential/video-swapuv.test.ts | matches native swapuv frame by frame through replay streams and activation actors | stream, actor |
| filter.swapuv.negotiation-gap | tests/differential/video-swapuv.test.ts | records the native gray and packed-alpha conversions that fall outside the negotiation table | negotiation |
| filter.swapuv.refusals | tests/differential/video-swapuv.test.ts | refuses swapuv options and timeline before opening outputs on every backend | refusals |
