# pixdesctest video filter

`pixdesctest` follows pinned `libavfilter/vf_pixdesctest.c`. Native allocates a
fresh buffer, zeroes it, and copies every component of every row through
`av_read_image_line2`/`av_write_image_line2` using the pixel descriptor. For the
14 storage formats of the negotiation table every byte is a component, so the
round trip is the identity: the output bytes equal the input. The descriptor in
`packages/avfilter/src/video-ops/pixdesctest.ts` registers it as an `identity`
operator with no `frame` function and no `formats`, exactly as `copy` does.
Provenance is in `packages/avfilter/NOTICE-PIXDESCTEST`.

## Syntax

- Accepted: `pixdesctest` and `pixdesctest=` (an empty option list), alone or in
  any chain or graph, on every path.
- Refused with `VideoFilterParseError` (surfaced as `VideoFilterError` on the
  linear path) before any output is opened: every option, through `bareStep`.
  Native refuses all of them too, except the generic AVFilterContext `threads`
  option, which native accepts and the scoped adaptation refuses rather than
  ignores. Native statuses (pinned in the differential test):
  `pixdesctest=1` exits with EINVAL (234 on Linux, `(256-EINVAL)&255` on the
  host), `pixdesctest=enable=1` with AVERROR_PATCHWELCOME (176, no timeline
  flag), `pixdesctest=a=b` with AVERROR_OPTION_NOT_FOUND (8) and
  `pixdesctest=threads=1` succeeds. EdgeFFmpeg exits with its generic status 1
  for every one of them, with no output opened.
- Runtime commands: activation actors answer `enable` with
  `AVERROR_PATCHWELCOME` (-1163346256) and every other command with ENOSYS (-38
  on the linux-x64 profile), because vf_pixdesctest.c has no `process_command`.

## Formats

Native has no `query_formats`, so every negotiable format is a candidate and the
source keeps its own format. The descriptor omits `formats` and accepts the
whole 14-entry table: yuv420p, rgb24, bgr24, yuv422p, yuv444p, gray, nv12, nv21,
argb, rgba, abgr, bgra, yuva420p and gbrp; legacy yuvj sources pass on linear
chains. Palette and padded layouts (pal8, rgb0, rgb555le, monob, ...) have no
frame storage here and are refused by the shared negotiators by name
(`Unsupported video negotiation format` on linear chains,
`negotiates <format>, which is not implemented` elsewhere), so no padding byte
is ever claimed.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed` are all flagged and each is
compared against native below.

## Determinism

Byte copy only, integer, no arithmetic profile of its own; every case runs on
every platform and no case is Linux-gated. The implicit conversion in
`format=nv12,pixdesctest` runs with `-cpuflags 0` natively and scalar arithmetic
in EdgeFFmpeg.

## Evidence

Against `.build/reference/ffmpeg` built in the sandbox from commit 946fcce0 with
`--disable-x86asm` (sha256
`ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu
13.3.0-6ubuntu2~24.04.1) 13.3.0`; the tests assert the commit and flag, never the
sha). Inputs are rawvideo in each of the 14 formats at 1x1, 2x2, 5x3, 7x5, 8x6
and 17x9, 3 frames: ramps, edges and a constant last plane in the first frame,
edge stripes over LCG noise in the others. All in
`tests/differential/video-pixdesctest.test.ts`:

| Test | Path | Native comparisons |
|---|---|---|
| `matches native -vf pixdesctest chains across all 14 formats, sizes and timing scopes as rawvideo and framecrc` | linear (`-vf`, media backend) | 1512: 14 formats x 6 sizes x `pixdesctest`, `pixdesctest,hflip`, `format=nv12,pixdesctest` x no time / input `-ss 0.04` + output `-t 0.05` / output `-ss 0.04 -t 0.05` x rawvideo/framecrc; plus 84 checks that native rawvideo equals the input |
| `matches native -filter_complex pixdesctest split branches through the media and timed backends as rawvideo and framecrc` | graph (media), actor (timed `producer`) and timed (timed `pull`) | 672 native runs, 2016 backend runs, 4032 outputs: two split graphs x rawvideo/framecrc x with/without `-ss 0.04 -frames:v 1` |
| `matches native pixdesctest frame by frame through replay streams and activation actors across all 14 formats and sizes` | stream (`createReplayVideoExecution`) and actor (`createFrameActors`) | 336 native runs: 336 stream (bytes and pts) + 336 actor |
| `negotiates every source as native does, keeping its own format through pixdesctest on every path` | all five | 17 sources of `tests/helpers/video-negotiation-cases.ts`, 73 checks: every source keeps its own format, none refused |
| `refuses pixdesctest options before opening any output, with native status for pixdesctest=1` | linear, graph, actor and timed backends | 6 native statuses, 18 refusals with no output opened |

Unit tests in `tests/unit/video-pixdesctest.test.ts` cover parsing, refusals on
every path, the refusal of formats without storage, linear budgets
(`maxFrameBytes`), frame-shape mismatch, `AbortSignal`, malformed and padded
strides reaching the next materializing operator, the unmutated input frame and
the runtime command codes. `tests/unit/video-operator-registry.test.ts`
(unedited) runs the descriptor examples (`pixdesctest`, `pixdesctest,hflip`,
`format=nv12,pixdesctest`) on all five paths.

## Proposed test contracts

All scoped to `filter.pixdesctest`, every platform (no gate):

| Id | File | Test title | Modes |
|---|---|---|---|
| `filter.pixdesctest.unit.parse` | `tests/unit/video-pixdesctest.test.ts` | `parses pixdesctest as an option-free identity operator over the whole negotiation table on every path` | linear, graph |
| `filter.pixdesctest.unit.refusal` | `tests/unit/video-pixdesctest.test.ts` | `refuses every pixdesctest option and enable= with VideoFilterParseError before planning on every path` | all five |
| `filter.pixdesctest.unit.scoped-forward` | `tests/unit/video-pixdesctest.test.ts` | `forwards the frame unchanged on the linear, graph and replay paths within budgets and signals` | linear, graph, stream |
| `filter.pixdesctest.unit.timed-forward` | `tests/unit/video-pixdesctest.test.ts` | `forwards the frame unchanged through activation actors and the timed executor and refuses runtime commands` | actor, timed |
| `filter.pixdesctest.differential.linear` | `tests/differential/video-pixdesctest.test.ts` | `matches native -vf pixdesctest chains across all 14 formats, sizes and timing scopes as rawvideo and framecrc` | linear |
| `filter.pixdesctest.differential.graph` | `tests/differential/video-pixdesctest.test.ts` | `matches native -filter_complex pixdesctest split branches through the media and timed backends as rawvideo and framecrc` | graph, actor, timed |
| `filter.pixdesctest.differential.stream` | `tests/differential/video-pixdesctest.test.ts` | `matches native pixdesctest frame by frame through replay streams and activation actors across all 14 formats and sizes` | stream, actor |
| `filter.pixdesctest.differential.negotiation` | `tests/differential/video-pixdesctest.test.ts` | `negotiates every source as native does, keeping its own format through pixdesctest on every path` | all five |
| `filter.pixdesctest.differential.refusal` | `tests/differential/video-pixdesctest.test.ts` | `refuses pixdesctest options before opening any output, with native status for pixdesctest=1` | linear, graph, actor, timed |

## Unsupported

- Every option, including `enable=` and `threads`.
- Runtime commands other than the native refusals above.
- pal8 (native copies its palette), padded and bit-packed layouts, hwaccel
  formats and every format outside the 14-entry table (the table limit is shared
  by all operators).
- The identity path forwards the same frame object instead of allocating a new
  buffer, so stride or storage defects in an input frame are only detected by
  the next operator that materializes planes.
