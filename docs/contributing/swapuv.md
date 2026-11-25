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
- Formats: `formats()` is native `is_planar_yuv()` over every pixel format of the
  pinned build, in AVPixelFormat order (70 formats: planar YUV and YUVA at every
  depth, the `yuvj` formats included). `gbrp` fails the native plane==component
  check. Negotiation therefore picks exactly what native picks. Frames are stored
  here only in `yuv420p`, `yuv422p`, `yuv444p` and `yuva420p`, and in the legacy
  `yuvj420p`/`yuvj422p`/`yuvj444p` sources of linear chains (planar storage, full
  range kept). Other inputs receive the automatic conversion native inserts:
  nv12/nv21 to yuv420p, rgb24/bgr24/gbrp to yuv444p.
- **Refused:** native converts `gray` to `yuvj444p` and `rgba`/`bgra`/`argb`/`abgr`
  to `yuva444p`. Neither has frame storage here, so the shared negotiators refuse
  them at plan time with `Video filter swapuv input negotiates <format>, which is
  not implemented`, on every path and before any output is opened. Before the shared
  negotiation fix these sources silently picked another format and diverged.
  The registry examples use an explicit `format=` first.
- Paths: `linear`, `graph`, `stream`, `actor`, `timed`.

## Determinism

Pure plane copy, no arithmetic. Native was stable at `-filter_threads 1/3/default`
and on repeat runs, and macOS and Linux hashes matched. Implicit conversions are
tested only with `-cpuflags 0` natively and the `scalar` pixel arithmetic here.

## Evidence

All comparisons run `.build/reference/ffmpeg` (Linux x86_64) at test time, on
three-frame structured-plus-noise inputs in yuv420p, yuv422p, yuv444p, yuva420p,
nv12, rgb24 and gbrp (the last three auto-convert under `-cpuflags 0`), at 5x3, 7x5 and 8x6.

After the shared negotiation fix every test below ran on macOS arm64 against
the pinned reference (sha256 `1b86106f…ab92`). The Linux x86_64 runs predate the
re-land, which changed this operator's module and tests. The re-landed code,
including the per-source negotiation test, has run only on macOS arm64.

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
- `negotiates every accepted source as native does and refuses the gray and packed-alpha picks without storage before output`:
  17 sources (the 14 executable formats and yuvj420p/422p/444p). Native's pick is
  read from showinfo after swapuv. 12 run byte-exact against native rawvideo
  (`-cpuflags 0`, scalar) on the linear, graph, stream, actor and timed paths (the
  yuvj sources on linear chains). 5 (gray, argb, rgba, abgr, bgra) are refused naming
  native's format on the five paths and through the media `-vf`/`-filter_complex`
  and timed producer/pull CLIs with no output opened: 93 checks.

`tests/unit/video-swapuv.test.ts` covers parsing and refusals, the plane swap with
padded strides and an unmutated input, linear planning, `maxFrameBytes`, resident
storage, malformed strides and plane counts, invalid time bases and `AbortSignal`.

## Unsupported

- gray (native `yuvj444p`) and packed RGB with alpha (native `yuva444p`): refused
  before output, as are all other inputs whose native pick has no frame storage here.
- `enable=` timeline expressions and every other option.
- Runtime commands (`sendcmd`/`zmq`).
- Native formats without frame storage here (yuv410p, yuv411p, 9-16 bit planar
  YUV, yuva422p/444p, ...): such inputs are not decodable here.

## Scoped test contracts

| id | file | test title | scope |
|---|---|---|---|
| filter.swapuv.cli | tests/differential/video-swapuv.test.ts | matches native -vf swapuv rawvideo and framecrc across formats sizes and time scopes | linear |
| filter.swapuv.graph | tests/differential/video-swapuv.test.ts | matches native -filter_complex swapuv split branches through the media and timed backends | graph, timed |
| filter.swapuv.stream | tests/differential/video-swapuv.test.ts | matches native swapuv frame by frame through replay streams and activation actors | stream, actor |
| filter.swapuv.negotiation | tests/differential/video-swapuv.test.ts | negotiates every accepted source as native does and refuses the gray and packed-alpha picks without storage before output | linear, graph, stream, actor, timed, negotiation |
| filter.swapuv.refusals | tests/differential/video-swapuv.test.ts | refuses swapuv options and timeline before opening outputs on every backend | refusals |
