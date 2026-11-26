# noformat video filter

`noformat` follows the noformat filter of pinned `libavfilter/vf_format.c` (FFmpeg
9.0.2, commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8). It only takes part in
format negotiation (`AVFILTER_FLAG_METADATA_ONLY`): frames pass through unchanged.
The descriptor is `noformatOperator` in `packages/avfilter/src/video-ops/noformat.ts`,
role `identity`, with no `frame` function.

## Syntax and scope

- `noformat=<f>[|<f>...]` or `noformat=pix_fmts=<f>[|<f>...]`. Names and numeric ids
  are read by `parseFilterPixelFormat`, as `format` reads them: the 14 storage formats,
  their aliases (`gray8`, `y8`, `rgb32`, `bgr32`) and the other layouts it declares
  (`pal8`, `monob`, `rgb0`, ...). `pix_fmts=` with an empty value is `strtol("")`, so
  it excludes `yuv420p`, as native does.
- `formats(step)` is native `invert_formats` over `ff_all_formats`: every negotiable
  format (`negotiableFormats`, AVPixelFormat order, hwaccel formats are outside the
  table) minus the listed ones. The yuvj siblings stay in the list, so `jpegSiblings`
  is not set. It is the whole native list, not its intersection with the storage
  formats. The shared negotiators pick exactly what native picks and refuse a pick
  without storage here by name.
- A bare `noformat` or `noformat=` sets no list. Native `invert_formats` leaves a NULL
  list unrestricted, so `formats()` is every negotiable format.
- If a list excluded every negotiable format, `parse` would throw. No accepted list can
  do that today.
- Paths: `linear`, `graph`, `stream`, `actor`, `timed`.
- **Native picks without storage are refused.** With the source's own format excluded,
  native picks `yuvj420p` for yuv420p, `yuyv422` for yuv422p, `yuvj444p` for yuv444p,
  `pal8` for gray and `yuva422p` for yuva420p. None of them has frame storage here, or
  they need a conversion into a legacy yuvj format, which `requireExecutableFormat`
  refuses. All five paths and the media `-vf`/`-filter_complex` and timed
  producer/pull CLIs fail with `Video filter <consumer> negotiates <format>, which is
  not implemented` before any output is opened. Picks that convert here run byte-exact:
  rgb24 to bgr24, bgr24 to rgb24, nv12/nv21 to yuv420p, argb to rgba, rgba/abgr/bgra
  to argb, gbrp to rgb24.
- **Refused before output, though native accepts them:**
  - duplicated formats (`gray|gray`; native `ff_add_format` appends), refused as `format` refuses them;
  - `color_spaces`, `color_ranges` and `alpha_modes` (`Color options are not implemented`);
  - names that `parseFilterPixelFormat` does not declare (for example `yuvj420p` and `yuv420p10le`).
- **Refused, as native refuses them:** `enable=` (vf_format has no timeline flag) and
  unknown names. Runtime commands are refused by the registry: `enable` answers
  AVERROR_PATCHWELCOME and every other command ENOSYS.

Registry examples, run from 8x8 gray: `noformat=yuv420p`,
`noformat=pix_fmts=yuv420p|rgb24,hflip`, `format=yuv444p,noformat=gray|yuv420p,vflip`.
gray is not excluded in the first two, so it passes through.

## Determinism and arithmetic

noformat itself does no arithmetic. The conversions it causes are integer swscale
conversions, tested only with `-cpuflags 0` natively and the `scalar` pixel arithmetic
here. They run on every platform, and no case is gated on linux-x64. Native's pick
depends on the graph: input `-ss` adds a trim filter, which changes the pick for
`nv12`/`nv21` with `noformat=yuv420p,negate` from the source format to `yuvj420p`.
The tests therefore read native's pick from showinfo in the same command that
produces the compared bytes.

## Evidence

Every comparison runs `.build/reference/ffmpeg` at test time. The first test asserts
the build metadata: commit 946fcce0, `--disable-x86asm`. The sandbox reference was
built with `npm run bootstrap -- --only npm,submodule,reference --allow-unpinned-reference`
(ffmpeg sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`,
`cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, Linux x86_64, Node 24.22.3).
Inputs are three frames per case: ramps with edges, LCG noise and constant planes.

`tests/differential/video-noformat.test.ts` (about 26 s with `--maxWorkers=1` on 4 vCPUs):

- `runs against the reference build of commit 946fcce0 configured with --disable-x86asm`.
- `matches native -vf noformat rawvideo and framecrc, or refuses native's storage-less pick by name, across formats sizes and time scopes`:
  14 storage sources at 1x1, 2x2, 5x3, 7x5, 8x6 and 17x9. Descriptions:
  - `noformat=<source>` and `noformat=pix_fmts=<source>|<other>`;
  - `noformat=yuv420p,negate`, `format=rgb24,noformat=rgb24` and `noformat=gray|yuv420p,hflip`.

  Each runs as rawvideo and framecrc, with and without `-ss 0.04`/`-t 0.05`. That is
  1680 media `-vf` runs: 1296 byte-exact and 384 named refusals. Native's picks are
  pinned for the 14 `noformat=<source>` cases, and so are the two picks that `-ss` changes.
- `matches native -filter_complex noformat branches through the media graph and the timed producer and pull schedulers`:
  the same descriptions in `[0:v]<d>,split` and `split;[a]<d>` graphs, at 1x1, 5x3 and
  17x9, as rawvideo and framecrc, with and without `-ss`/`-frames:v`. Both outputs are
  compared through the media, timed producer (actor) and timed pull (timed executor)
  backends. That is 5040 runs: 3336 byte-exact and 1704 refusals. The refusals are
  named picks, and on the actor and timed schedulers `Actor operators not implemented`
  for the negate chain, because negate is not an actor or timed operator.
- `matches native noformat frame by frame through replay streams and activation actors, or refuses the pick by name`:
  420 runs through `createReplayVideoExecution` and `createFrameActors`: 291 byte-exact and 129 refusals.
- `negotiates every accepted source as native does for noformat lists and refuses picks without storage by name on every path`:
  `tests/helpers/video-negotiation-cases.ts` over the 17 negotiation sources for
  `noformat=yuv420p`, `noformat=rgb24`, `noformat=gray|yuv420p` and
  `noformat=yuv420p|yuv422p|yuv444p|nv12|nv21`, plus `noformat=<source>` for each of
  the 14 storage sources. All outcomes are pinned exactly: 414 checks.
- `refuses noformat forms outside the scope before opening outputs on every backend, where native accepts or rejects them`:
  8 forms. Native's acceptance is asserted for each (6 accepted, 2 rejected). Each form
  is refused here through the media, producer and pull backends, as `-vf` and
  `-filter_complex`, with no output opened: 48 checks.

`tests/unit/video-noformat.test.ts` (5 tests) covers:

- parsing and the inverted lists, and every refusal on every path;
- the negotiation picks and refusals on the linear, graph and timed planners;
- identity forwarding on all five paths, with `maxFrameBytes`, malformed strides, `AbortSignal`, an unmutated input and owned output planes after a materializing operator;
- runtime-command refusals.

## Proposed contracts

| id | file | test title | modes | scope |
|---|---|---|---|---|
| `filter.noformat.cli` | `tests/differential/video-noformat.test.ts` | `matches native -vf noformat rawvideo and framecrc, or refuses native's storage-less pick by name, across formats sizes and time scopes` | semantic, bit-exact | 14 sources, 6 sizes, 5 descriptions, rawvideo/framecrc, -ss/-t, -cpuflags 0 |
| `filter.noformat.graph` | `tests/differential/video-noformat.test.ts` | `matches native -filter_complex noformat branches through the media graph and the timed producer and pull schedulers` | semantic, bit-exact | split graphs, media/producer/pull, 3 sizes |
| `filter.noformat.stream` | `tests/differential/video-noformat.test.ts` | `matches native noformat frame by frame through replay streams and activation actors, or refuses the pick by name` | semantic, bit-exact | replay streams and actors, 3 sizes |
| `filter.noformat.negotiation` | `tests/differential/video-noformat.test.ts` | `negotiates every accepted source as native does for noformat lists and refuses picks without storage by name on every path` | semantic | 17 sources, five paths and four CLIs |
| `filter.noformat.refusals` | `tests/differential/video-noformat.test.ts` | `refuses noformat forms outside the scope before opening outputs on every backend, where native accepts or rejects them` | semantic | out-of-scope options, three backends |

None is platform-gated.

## Unsupported

- `color_spaces`, `color_ranges` and `alpha_modes`.
- Duplicated formats.
- Formats that `parseFilterPixelFormat` does not declare, the yuvj formats included.
- `enable=` and runtime commands.
- Native picks without frame storage, and conversions into a legacy yuvj format: refused by name before output.
