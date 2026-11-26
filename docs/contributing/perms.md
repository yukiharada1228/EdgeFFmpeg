# perms video filter

`perms` (libavfilter/f_perms.c, `CONFIG_PERMS_FILTER`) changes only whether the
output frame is writable: `filter_frame` calls `ff_inlink_make_frame_writable`
or `av_frame_clone` and forwards the frame. Native never changes pixels, size,
format or timestamps, and the filter has no `query_formats`. The descriptor in
`packages/avfilter/src/video-ops/perms.ts` is therefore an `identity` operator
with no `formats` and no `frame` function, exactly like `copy` and `null`: every
path forwards the frame unchanged. It mirrors the wave-1 audio `aperms`
(`docs/contributing/aperms.md`). Provenance is in `packages/avfilter/NOTICE-PERMS`.

## Syntax

| Form | Result |
|---|---|
| `perms`, `perms=` | mode `none` |
| `perms=<mode>`, `perms=mode=<mode>` | `<mode>` is `none`, `ro`, `rw`, `toggle` or `random` (one quoting/escape layer is removed, as natively) |
| `perms=<mode>:<seed>`, `perms=mode=<mode>:seed=<seed>` | the AVOption order is mode, then seed; named options may follow positional ones, and a repeated option keeps its last value (`perms=ro:mode=rw` is `rw`) |
| `seed=<n>` | decimal `-1` or `0`..`4294967295`, no sign and no leading zeros |

`mode=random` requires an explicit seed. Native's default `seed=-1` draws one
from `av_get_random_seed`; because the frame bytes are the same for every seed,
the form is refused only because it is nondeterministic. `seed=-1` with any other
mode is accepted and has no effect. A later `seed=-1` cancels an earlier seed.

## Refused forms

Every refusal is a `VideoFilterParseError` (a `VideoFilterSyntaxError` for option
syntax), surfaced as `VideoFilterError` on the linear path, raised while parsing
on every path, before any output is opened. Native exit statuses are asserted
in the differential refusal test (EINVAL and ERANGE come from the host
`os.constants.errno`).

| Form | Message | Native |
|---|---|---|
| `perms=bogus`, `mode=RO`, `mode=` | `Unsupported perms mode: <value>` | EINVAL |
| `mode=1` and other numeric or expression modes | `Unsupported perms mode: <value>` | accepted |
| `seed=-2`, `seed=4294967296` | `Invalid perms seed: <value>` | ERANGE |
| `seed=07`, `seed=0x7`, `seed=+7`, `seed=7.0` | `Invalid perms seed: <value>` | accepted (07, 0x7 probed) |
| `perms=random`, `perms=random:-1` | `perms random mode requires an explicit seed` | accepted (random seed) |
| `enable=` (timeline) | `Unsupported perms option: enable` | accepted (`AVFILTER_FLAG_SUPPORT_TIMELINE_GENERIC`) |
| `threads=` | `Unsupported perms option: threads` | accepted |
| `foo=1` | `Unsupported perms option: foo` | `AVERROR_OPTION_NOT_FOUND` (status 8) |
| `perms=ro:7:1`, `perms=mode=ro:7` | `Missing filter option name` | EINVAL |

Runtime commands are refused. Native answers `mode` through
`ff_filter_process_command` and `enable` through the generic timeline; the
activation actors answer `enable` with `AVERROR_PATCHWELCOME` (-1163346256) and
every other command (`mode`, `seed`, `w`, unknown names) with ENOSYS (-38 on the
linux-x64 profile), because the descriptor sets neither `timeline` nor
`geometryCommands`.

## Formats and paths

No `formats`: the whole 14-entry negotiation table (yuv420p, rgb24, bgr24,
yuv422p, yuv444p, gray, nv12, nv21, argb, rgba, abgr, bgra, yuva420p, gbrp) is
accepted, and `perms` alone never inserts a conversion stage. Native keeps every
source format, so the per-source negotiation test finds no refusals; legacy
yuvj sources run on linear chains.

`linear`, `graph`, `stream`, `actor` and `timed` are all flagged; identity is
allowed on all five and each is compared against native below. Registry
examples: `perms`, `perms=ro,hflip`, `perms=mode=random:seed=7,vflip`,
`format=nv12,perms=toggle:0`.

## Determinism and arithmetic profile

Identity: no pixel arithmetic, no state, integer and copy only, so every case
runs on every platform and nothing is linux-gated. Implicit conversions in front
of `negate` run with `-cpuflags 0` natively and scalar arithmetic here. Probed
identical md5 on macOS for `perms=toggle` (per the specification). Writability
itself is not modelled: frames here carry no permission flag, and the identity
path forwards the same frame object, so stride or storage defects in an input
frame are detected only by the next materializing operator.

## Evidence

Against `.build/reference/ffmpeg` built in the sandbox with
`--allow-unpinned-reference` (FFmpeg n9.0.2 at 946fcce0, `--disable-x86asm`,
Linux x86_64; ffmpeg sha256
`ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`,
`cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`). Native runs at test time; there
are no committed goldens. The first test reads `build-metadata.json` and asserts
the commit and `--disable-x86asm`.

Inputs are rawvideo in each of the 14 formats (no implicit input conversion),
sizes 1x1, 2x2, 5x3, 7x5, 8x6 and 17x9, 3 frames: ramps, a half-black,
half-white edge plane and a constant plane in the first frame, LCG noise in the
others. Forms: `perms`, `perms=ro`, `perms=rw`, `perms=toggle`,
`perms=random:7`, `perms=mode=toggle:seed=0`.

| Test | Path | Native comparisons |
|---|---|---|
| `matches native -vf perms modes alone and chained with hflip and negate across all 14 formats, sizes and timing scopes as rawvideo and framecrc` | linear (`-vf`, media backend) | 7560: 14 formats x 6 sizes x 6 forms x {alone, `,hflip`, `negate,<form>,perms=toggle`} x 5 scope/muxer pairs (no time, input `-ss 0.04` + output `-t 0.05`, output `-ss 0.04 -t 0.05`; rawvideo and framecrc, the scopes rotating over sizes), plus 504 checks that native rawvideo of each form alone equals the input |
| `matches native -filter_complex split and perms branches across all 14 formats as rawvideo and framecrc` | graph | 1512 runs, 3024 outputs: 14 formats x 1x1/5x3/17x9 x 6 forms x 3 split graphs (one with negate) x rawvideo/framecrc, half with `-ss 0.04 -frames:v 1` |
| `matches native perms frame by frame through replay streams and activation actors across all 14 formats and sizes` | stream (`createReplayVideoExecution`) and actor (`createFrameActors`) | 1512 native runs: 3024 stream (alone and with a perms,nullsink branch) and 1512 actor comparisons, rawvideo bytes and pts |
| `matches native perms through the timed backend as rawvideo and framecrc with and without -ss and -frames` | timed (`createTimedVideoBackend`) | 3024 |
| `refuses perms forms outside scope before opening any output and asserts the native exit status of each` | linear, graph, timed backend | 16 native statuses, 32 refusals |
| `negotiates every accepted source unchanged as native does on every path` | all five, CLI | 17 sources, 73 checks (`tests/helpers/video-negotiation-cases.ts`) |
| `runs the unpinned reference built from FFmpeg 946fcce0 with --disable-x86asm` | – | build metadata and `-filters` listing |

Total: 18144 byte comparisons against native (7560 linear + 3024 graph outputs
+ 4536 stream and actor + 3024 timed; the 504 identity checks are within the
linear count) from 13608 native runs, 16 native statuses and 73 negotiation
checks. The file runs in about 100 s on 4 vCPUs with
`--maxWorkers=1`.

Unit tests in `tests/unit/video-perms.test.ts` cover positional, named,
last-wins and quoted parsing, every refusal with its exact message on every path,
negotiation of every table format with no stage, linear budgets
(`maxFrameBytes`), frame-shape mismatch, `AbortSignal`, padded strides passing
through to the next materializing operator (which owns tight planes), the
unmutated input frame, replay, actor and timed identity for every form and the
runtime command codes. `tests/unit/video-operator-registry.test.ts` (unchanged)
runs the descriptor examples on all five paths.

## Proposed test contracts

| Id | File | Test title | Scope | Platforms |
|---|---|---|---|---|
| filter.perms.linear | tests/differential/video-perms.test.ts | matches native -vf perms modes alone and chained with hflip and negate across all 14 formats, sizes and timing scopes as rawvideo and framecrc | rawvideo CLI `-vf`, rawvideo and framecrc | all |
| filter.perms.graph | tests/differential/video-perms.test.ts | matches native -filter_complex split and perms branches across all 14 formats as rawvideo and framecrc | rawvideo CLI `-filter_complex` | all |
| filter.perms.stream-actor | tests/differential/video-perms.test.ts | matches native perms frame by frame through replay streams and activation actors across all 14 formats and sizes | replay stream and activation actors | all |
| filter.perms.timed | tests/differential/video-perms.test.ts | matches native perms through the timed backend as rawvideo and framecrc with and without -ss and -frames | timed backend CLI | all |
| filter.perms.refusals | tests/differential/video-perms.test.ts | refuses perms forms outside scope before opening any output and asserts the native exit status of each | refusals before output | all |
| filter.perms.negotiation | tests/differential/video-perms.test.ts | negotiates every accepted source unchanged as native does on every path | per-source negotiation | all |
| filter.perms.identity | tests/unit/video-perms.test.ts | forwards every frame unchanged for every mode on the linear, graph and replay paths within budgets, strides and signals | identity, budgets, abort | all |

## Unsupported

These are refused, never approximated: `mode=random` without an explicit seed,
numeric and expression mode values, non-canonical seeds, `enable=`, `threads=`,
runtime commands, and hwaccel formats or formats outside the 14-entry table (the
table limit is shared by all operators). Frame writability is not modelled.
