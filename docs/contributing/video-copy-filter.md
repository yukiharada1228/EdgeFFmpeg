# copy video filter

`copy` follows pinned `libavfilter/vf_copy.c`. Native allocates a new buffer and
copies the frame and its properties, so the output bytes always equal the input.
The descriptor in `packages/avfilter/src/video-ops/copy.ts` registers it as an
`identity` operator with no `frame` function: every path forwards the frame
unchanged, exactly as `null` does. Provenance is in
`packages/avfilter/NOTICE-VIDEO-COPY`.

## Syntax

- Accepted: `copy` and `copy=` (an empty option list), alone or in any chain or
  graph, on every path.
- Refused with `VideoFilterParseError` (surfaced as `VideoFilterError` on the
  linear path) before any output is opened: every option, through `bareStep`.
  This includes `enable=` (native also refuses it: vf_copy.c has no timeline
  flag), unknown options (native refuses them too) and the generic
  AVFilterContext `threads` option, which native accepts and the scoped
  adaptation refuses rather than ignores. `copy=foo` fails as a syntax error.
- Runtime commands: activation actors answer `enable` with
  `AVERROR_PATCHWELCOME` (-1163346256), as native `set_enable_expr` does for a
  filter without timeline support, and every other command with ENOSYS (-38 on
  the linux-x64 profile), because vf_copy.c has no `process_command`.

## Formats

Native `query_formats` rejects only hwaccel formats, so the descriptor omits
`formats` and accepts the whole 14-entry negotiation table: yuv420p, rgb24,
bgr24, yuv422p, yuv444p, gray, nv12, nv21, argb, rgba, abgr, bgra, yuva420p and
gbrp. `copy` alone never inserts a conversion stage.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed` are all flagged; identity is
allowed on all five and each is compared against native below.

## Determinism

Identity, integer only, no arithmetic profile of its own. Implicit conversions
in the tested chains (`format=nv12`, negate's format restriction) run with
`-cpuflags 0` natively and the reference pixel arithmetic in EdgeFFmpeg.

## Evidence

Against `.build/reference/ffmpeg` (FFmpeg 9.0.2, Linux x86_64), in
`tests/differential/video-copy-filter.test.ts`, inputs are rawvideo in each of
the 14 formats (no implicit input conversion), a structured first frame plus
LCG noise, 3 frames:

| Test | Path | Native comparisons |
|---|---|---|
| `matches native -vf copy chains across all 14 formats, sizes and timing scopes as rawvideo and framecrc` | linear (`-vf`, media backend) | 1008: 14 formats x 5x3/7x5/8x6 x `copy`, `copy,negate`, `format=nv12,copy,vflip`, `copy,hflip` x no time / input `-ss 0.04` + output `-t 0.05` / output `-ss 0.04 -t 0.05` x rawvideo/framecrc; plus 42 checks that native `-vf copy` rawvideo equals the input |
| `matches native -filter_complex split and copy branches across all 14 formats as rawvideo and framecrc` | graph | 224 runs, 448 outputs: four split/copy graphs x rawvideo/framecrc x with/without `-ss 0.04 -frames:v 1` |
| `matches native replayed copy graphs frame by frame across all 14 formats and sizes` | stream (`createReplayVideoExecution`) | 168: four graphs including a nullsink branch, rawvideo bytes and pts |
| `matches native copy through activation actors and the timed backend as rawvideo and framecrc` | actor (`createFrameActors`) and timed (`createTimedVideoBackend`) | 168 actor rawvideo + 672 timed rawvideo/framecrc |
| `refuses copy options before opening any output, as native does except for the generic threads option` | linear, graph, timed backend | 6 native runs, 12 refusals |

Unit tests in `tests/unit/video-copy-filter.test.ts` cover parsing, refusals on
every path, linear budgets, frame-shape mismatch, `AbortSignal`, padded strides
passing through to the next materializing operator, the unmutated input frame
and the runtime command codes. `tests/unit/video-operator-registry.test.ts` runs
the descriptor examples (`copy`, `copy,hflip`, `format=nv12,copy,vflip`) on all
five paths.

## Unsupported

- Every option, including `enable=` and `threads`.
- Runtime commands other than the native refusals above.
- Hwaccel formats and formats outside the 14-entry table (the table limit is
  shared by all operators).
- Copy is not a buffer allocation in EdgeFFmpeg: the identity path forwards the
  same frame object, so stride or storage defects in an input frame are only
  detected by the next operator that materializes planes.
