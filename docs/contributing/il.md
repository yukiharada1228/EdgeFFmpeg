# il video filter

`il` follows pinned `libavfilter/vf_il.c` (FFmpeg 9.0.2, commit
946fcce07b6dcd0331c8cc609192aeff5e1924f8). The descriptor is
`packages/avfilter/src/video-ops/il.ts` (role `frame`); provenance is in
`packages/avfilter/NOTICE-IL`. `ilVideoFrame` copies rows into owned tight
positive-stride planes, keeps bigint PTS and metadata, and checks the frame
budget, input storage, strides, plane count, time base and `AbortSignal`.

## Syntax

| Option | Alias | Values | Default |
|---|---|---|---|
| `luma_mode` | `l` | `none`, `interleave`/`i`, `deinterleave`/`d`, or `0`-`2` | `none` |
| `chroma_mode` | `c` | as above | `none` |
| `alpha_mode` | `a` | as above | `none` |
| `luma_swap` | `ls` | `AV_OPT_TYPE_BOOL` | `0` |
| `chroma_swap` | `cs` | `AV_OPT_TYPE_BOOL` | `0` |
| `alpha_swap` | `as` | `AV_OPT_TYPE_BOOL` | `0` |

Shorthand follows the declaration order with aliases skipped, as
`process_options` does: `il=d:i:d:1:0:1` sets the three modes and then the three
swaps. A seventh positional value fails like native (`No option name`). Repeated
keys apply in order. Booleans use the shared LP64 `strtol` and signed32
narrowing (`ls=4294967297` is true, `ls=` false).

Refused explicitly, before any output is opened:

- mode values other than the declared names and plain decimal integers `0`-`2`.
  Native also evaluates expressions (`l=1.5`, `l=i+0`); those are not
  implemented here. Out-of-range values (`l=3`, `l=-1`, `l=i+d`) and empty or
  unknown values fail natively too;
- `ls=2`, `ls=auto` and other invalid booleans;
- `enable=` (native `AVFILTER_FLAG_SUPPORT_TIMELINE_GENERIC`), unknown options and
  runtime commands (`process_command`); the descriptor sets neither `timeline`
  nor `geometryCommands`, so commands are refused automatically.

## Formats and planes

Native `query_formats` rejects only palette and hwaccel formats, so `il` accepts
all 14 negotiation-table formats and has no `formats` hook. Row bytes are the
`av_image_fill_linesizes` values (nv12/nv21 chroma rows are `2*ceil(w/2)` bytes).
Plane 0 uses the luma settings, the chroma planes use the chroma settings at
`ceil(h / 2^log2_chroma_h)` rows, and the last plane of a format with alpha
uses the alpha settings at `h` rows. gbrp planes 1 and 2 are chroma planes.

Packed formats with alpha (`rgba`, `bgra`, `argb`, `abgr`) have one plane that
native processes twice: first as luma, then as alpha. The second pass rewrites
every row, so the alpha settings override the luma settings. This quirk is
kept and is confirmed by the differential tests.

## Odd heights

Native writes `2*(h>>1)` rows per plane, so with an odd processed plane height
the last row comes from the buffer pool and is nondeterministic. `geometry` and
`frame` therefore refuse any plane with an odd height ("Il requires even heights
in every processed plane"). This means odd `h` for every format, and also
`h % 4 == 2` for yuv420p, yuva420p, nv12 and nv21. The refusal happens before any
output on all five paths.

## Paths and determinism

`linear`, `graph`, `stream`, `actor` and `timed` are flagged. `il` is a stateless
`frame` operator with no `actorFrame`. It is pure row copies with no arithmetic,
so the even-height results do not depend on the pixel arithmetic profile or the
platform.

## Evidence

The tests run against `.build/reference/ffmpeg` (Linux x86_64, sha256
`ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`):

| Test | Comparisons |
|---|---|
| linear, 14 formats x 3 sizes (8x8, 6x4, 16x12) x 27 mode triples x 8 swap combinations, two frames each | 9072 rawvideo |
| CLI `-vf` and `-filter_complex`, 14 formats x 6 chains x rawvideo/framecrc x 2 timing scopes, plus 4 converted cases with `-cpuflags 0` and scalar arithmetic | 676 |
| replayed streams, 14 formats x 4 graphs (split, hstack, nullsink) | 56 |
| timed backend `activation` (actor) and `pull` (timed) schedulers, 14 formats x 3 graphs x rawvideo/framecrc x 2 frame counts | 336 |
| option aliases, shorthand and numeric forms on yuva420p, rgba and nv12; native refusals | 30 outputs, 24 refusals |
| odd-height refusals on `-vf`, `-filter_complex`, both timed schedulers and replay streams | 30 (no output opened) |

Unit tests (`tests/unit/video-il.test.ts`) cover parsing, aliases, the packed
alpha quirk, odd heights on every planner, budgets, malformed strides, plane
counts, time bases, cancellation and an unmutated input.

## Scoped test contracts

| File | Test title | Scope |
|---|---|---|
| tests/differential/video-il.test.ts | matches native linear il for all 14 formats, every mode triple and every swap combination at even plane heights | linear |
| tests/differential/video-il.test.ts | matches native il CLI rawvideo and framecrc through -vf and -filter_complex with timing scopes | linear, graph |
| tests/differential/video-il.test.ts | matches native il graphs through replayed streams frame by frame | stream |
| tests/differential/video-il.test.ts | matches native il through the timed backend actor and pull schedulers in rawvideo and framecrc | actor, timed |
| tests/differential/video-il.test.ts | matches native il option aliases, shorthand and numeric forms, and refuses what native refuses | options |
| tests/differential/video-il.test.ts | refuses odd processed plane heights on every flagged path before opening outputs, where native output is pool dependent | refusals |

## Unsupported

- odd processed plane heights (native output is nondeterministic);
- expression-valued modes (`l=1.5`, `l=i+0`);
- `enable=` and runtime commands;
- H.264/MP4 framecrc has not been compared (`il` keeps the size, so the
  aspect-ratio limit in the registry guide does not apply).
