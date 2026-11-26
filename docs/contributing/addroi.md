# addroi video filter

`addroi` adds a region of interest (`AV_FRAME_DATA_REGIONS_OF_INTEREST` side data) to every frame. It is a scoped adaptation of `libavfilter/vf_addroi.c` at FFmpeg commit `946fcce0`, registered as one descriptor in `packages/avfilter/src/video-ops/addroi.ts` (provenance in `packages/avfilter/NOTICE-ADDROI`).

No encoder in the pinned build reads the ROI side data. Only libx264, libx265, libvpx, qsv, vaapi and d3d12va do, and none of them is enabled. The side data therefore has no observable effect on rawvideo, framecrc or H.264 output. EdgeFFmpeg does not represent it. The operator has role `identity`: pixels, timestamps, size and format pass unchanged, as native `AVFILTER_FLAG_METADATA_ONLY` leaves them. Parsing and refusals follow native exactly, except for the scoped refusals listed below.

## Syntax

`addroi[=x:y:w:h:qoffset:clear]`, shorthand in that order, or by name. A repeated option keeps its last value.

| Option | Type | Default | Accepted here |
|---|---|---|---|
| `x`, `y`, `w`, `h` | expression over `iw` and `ih` | `0` | must pass the shared `compileExpression` (linux-x64 profile, constants `iw` and `ih`, the evaluator's bounds), then the NaN-free subset below |
| `qoffset` | `AV_OPT_TYPE_RATIONAL` in [-1, 1] | `-1/10` | `opt.c` `set_string_number`: first `sscanf("%d%*1[:/]%d%c")==2` with `write_number`'s range check, otherwise the option expression (constants `default`, `max`, `min`, `none`, `all`) with NaN as EINVAL and the range check as ERANGE. Stored as native stores it: `{num,den}` from the ratio, `{d,1}` for integers, `av_d2q(d,1<<24)` otherwise |
| `clear` | `AV_OPT_TYPE_BOOL` | `0` | the shared `filterBoolean` (`true`/`yes`/`on`/…, `0`, `1`); `auto` and other integers are refused, as native refuses them |

`addroiRegion(step,width,height)` reproduces `addroi_config_input`: it evaluates x, y, w and h in order, replaces values below 0 with 0 and values above `iw`, `ih`, `iw-x` or `ih-y` with that maximum, and truncates to int. No path calls it, because the region feeds only the side data. The unit tests use it to pin the native values.

### Region expressions: the NaN-free subset

Native casts the evaluated `double` to `int`. A NaN gets past both clamps, and its conversion is undefined behaviour. The identity role has no size hook (`geometry` is only allowed for `resize`, `frame` and `join`), so EdgeFFmpeg cannot evaluate the expressions per link. Instead, `parse` proves that no link size gives NaN. `addroiExpressionRange` follows eval.c's `parse_subexpr`/`parse_term`/`parse_factor` over decimal numbers, `iw`, `ih`, unary signs, `+ - * /` and parentheses, with whitespace removed. It computes an interval over every `iw, ih` in [1, 2147483647]. It refuses an expression when an endpoint is not finite or a divisor interval contains zero. Round-to-nearest is monotone, so each evaluated value lies inside the endpoints. Without an infinity or a zero divisor, these operations cannot give NaN.

Refused with `VideoFilterParseError` even though native accepts them: every function call (`sin`, `hypot`, `log`, `if`, `ld`, `st`, `random`, …), named constants (`PI`, `E`, …), `^`, `;`, hexadecimal, `inf`/`nan` and SI-suffixed literals, and divisions whose divisor can be zero (`0/0`, `iw/(ih-1)`). Unported JavaScript-Math functions can never reach a decision here.

## Refused forms

| Form | Native | EdgeFFmpeg |
|---|---|---|
| `qoffset=2`, `-3/2`, `1/0` | ERANGE (exit 222 on Linux) | `Invalid addroi qoffset: value outside [-1,1]` |
| `qoffset=0/0`, `nan`, `abc`, empty | EINVAL (234) | `Invalid addroi qoffset: …` |
| ratio terms outside int (`2147483648/1`) | glibc narrowing | refused (scoped) |
| `x=iw/`, `w=` (empty), `h=bogus` | EINVAL | `Invalid addroi <key> expression: …` |
| `clear=auto`, `clear=2` | EINVAL | `Invalid addroi clear: …` |
| `enable=…` | AVERROR_PATCHWELCOME (176) | `Addroi has no timeline support` |
| unknown option (`foo=1`) | AVERROR_OPTION_NOT_FOUND (8) | `Unsupported addroi option` |
| `threads=1` | accepted | refused (scoped: never ignored) |
| `x=0/0`, `w=sin(1)`, `y=iw/(ih-1)`, `x=1/(iw-2)`, `h=hypot(iw\,ih)` | accepted | refused (outside the NaN-free subset) |
| runtime commands | `enable`: AVERROR_PATCHWELCOME; others: ENOSYS | the same codes (no `timeline`, no `geometryCommands`) |

EdgeFFmpeg's CLI exit code is non-zero for every refusal, and no output is opened. It does not reproduce native's errno-derived status. The differential test asserts native's status from the host's `os.constants.errno`.

## Formats

There is no `formats()`: native has no `query_formats`, so every format of the negotiation table passes without a conversion stage. The per-source negotiation test confirms that native keeps each of the 17 sources, including argb/rgba/abgr/bgra and the yuvj sources.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed`, all through the identity branch. Registry examples: `addroi=0:0:iw/2:ih/2:-1/5`, `addroi=x=iw/4:w=iw*2:qoffset=1,hflip`, `addroi=clear=1,addroi=1:2:3:4:qoffset=0` and `format=nv12,addroi,vflip`.

## Determinism and arithmetic profile

No pixel arithmetic. Region and qoffset expressions are compiled with the linux-x64 profile. Their values never reach pixels or geometry, and acceptance uses only IEEE arithmetic (+ − × ÷) and correctly rounded decimal literals, which are identical on every platform. No case is float-sensitive, so there are no linux-gated tests. The tests run everywhere.

## Evidence

Sandbox: linux x64, `.build/reference/ffmpeg` sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built with `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, `--disable-x86asm`, commit `946fcce0` (both asserted from `build-metadata.json` at test time; the binary is not pinned). Node 24.22.3. The differential file ran in 18 s with `--maxWorkers=1`.

Inputs: three frames per case (ramps, LCG noise, then 0/255 edge columns over constant planes) in each of the 14 executable formats.

| Test title | Path | Comparisons |
|---|---|---|
| `matches native -vf addroi chains across all 14 formats, six sizes and timing scopes as rawvideo and framecrc` | linear CLI `-vf` | 14 formats x {1x1, 2x2, 5x3, 7x5, 8x6, 17x9} x 6 chains x 3 `-ss`/`-t` scopes x {rawvideo, framecrc}: 3024 byte matches, plus 420 checks that native's output equals the input |
| `matches native -filter_complex split and addroi branches across all 14 formats as rawvideo and framecrc` | graph CLI `-filter_complex` | 14 formats x {5x3, 17x9} x 3 graphs x 2 muxers x 2 scopes: 336 cases, 672 files |
| `matches native replayed addroi graphs frame by frame across all 14 formats and six sizes` | stream (`createReplayVideoExecution`) | 14 x 6 sizes x 3 graphs: 252, with pts 0,1,2 |
| `matches native addroi through activation actors and the timed backend producer and pull schedulers as rawvideo and framecrc` | actor (`createFrameActors`), timed backend `producer` and `pull` | 126 actor outputs; 1008 timed-backend rawvideo/framecrc outputs (14 x {1x1, 5x3, 17x9} x 3 chains x 2 schedulers x 2 muxers x 2 scopes) |
| `refuses addroi options before opening any output with native statuses, and refuses the natively accepted unproven forms` | linear and graph CLIs; media, timed producer and pull backends | 19 forms x {`-vf`, `-filter_complex`}: 38 native statuses (ERANGE, EINVAL, PATCHWELCOME, OPTION_NOT_FOUND, or 0 for the six scoped refusals), 114 EdgeFFmpeg refusals with no output opened |
| `negotiates every accepted source as native does with addroi on every path` | all five paths | 17 sources, every native pick kept, 73 byte-exact checks |

Two mutations were each caught: dropping the qoffset range check (2 unit tests and the differential refusal test failed) and dropping the zero-divisor check (1 unit test, and the differential refusal test through `x=1/(iw-2)`).

The six chains are the spec cases: `addroi=0:0:iw/2:ih/2:-1/5`, `addroi=x=iw/4:w=iw*2:qoffset=1`, `addroi=clear=1`, the two-filter chain `addroi=0:0:iw/2:ih/2,addroi=1:1:iw-1:ih-1:qoffset=1/2:clear=0`, `addroi=0:0:iw:ih,hflip`, and `addroi=qoffset=0` (native accepts it).

`tests/unit/video-addroi.test.ts` (7 tests) covers the descriptor shape, shorthand, defaults and repeats, the qoffset ratio/expression paths (values checked against native `av_d2q`), the interval bounds with 1800 sampled evaluations inside them, the `config_input` clamps, every refusal on all five parsers, budgets, `AbortSignal`, frame-shape mismatch, padded strides through `addroi,hflip` (owned output planes), an unmutated input, and the native runtime command codes.

## Proposed test contracts

All of them run on every platform.

| Id | File | Test title | Modes | Scope |
|---|---|---|---|---|
| `filter.addroi.unit.parse` | `tests/unit/video-addroi.test.ts` | `parses addroi options in native shorthand order with the declared defaults as a frozen identity step on every path` | linear, graph | descriptor, shorthand, defaults, booleans, no conversion stage for any table format |
| `filter.addroi.unit.qoffset` | `tests/unit/video-addroi.test.ts` | `parses qoffset as opt.c does: the integer ratio first, then the option expression, with write_number range checks` | linear | rational parsing, storage and refusals |
| `filter.addroi.unit.subset` | `tests/unit/video-addroi.test.ts` | `bounds region expressions over every link size and refuses those that could evaluate to NaN or leave the subset` | linear | NaN-free interval subset and sampled soundness |
| `filter.addroi.unit.region` | `tests/unit/video-addroi.test.ts` | `computes config_input regions with zero and maximum clamps and truncation, as native does` | linear | `addroi_config_input` values |
| `filter.addroi.unit.refusal` | `tests/unit/video-addroi.test.ts` | `refuses malformed, out-of-range and unimplemented addroi options with VideoFilterParseError before planning on every path` | linear, graph, stream, actor, timed | refusals before planning |
| `filter.addroi.unit.scoped-forward` | `tests/unit/video-addroi.test.ts` | `forwards the frame unchanged on the linear, graph and replay paths within budgets, strides and signals` | linear, graph, stream | identity forwarding, budgets, signals, strides |
| `filter.addroi.unit.timed-forward` | `tests/unit/video-addroi.test.ts` | `forwards the frame unchanged through activation actors and the timed executor and refuses runtime commands` | actor, timed | identity forwarding, runtime command codes |
| `filter.addroi.differential.linear` | `tests/differential/video-addroi.test.ts` | `matches native -vf addroi chains across all 14 formats, six sizes and timing scopes as rawvideo and framecrc` | linear | 14 formats, six sizes, six chains, three scopes, two muxers |
| `filter.addroi.differential.graph` | `tests/differential/video-addroi.test.ts` | `matches native -filter_complex split and addroi branches across all 14 formats as rawvideo and framecrc` | graph | split graphs with two outputs |
| `filter.addroi.differential.stream` | `tests/differential/video-addroi.test.ts` | `matches native replayed addroi graphs frame by frame across all 14 formats and six sizes` | stream | replay streams |
| `filter.addroi.differential.timed` | `tests/differential/video-addroi.test.ts` | `matches native addroi through activation actors and the timed backend producer and pull schedulers as rawvideo and framecrc` | actor, timed | actors and the timed backend |
| `filter.addroi.differential.refusal` | `tests/differential/video-addroi.test.ts` | `refuses addroi options before opening any output with native statuses, and refuses the natively accepted unproven forms` | linear, graph, actor, timed | native statuses and refusals before output |
| `filter.addroi.differential.negotiation` | `tests/differential/video-addroi.test.ts` | `negotiates every accepted source as native does with addroi on every path` | linear, graph, stream, actor, timed | per-source negotiation |

## Unsupported

- The ROI side data itself: it is neither attached nor read, because no pinned encoder consumes it.
- Region expressions outside the NaN-free subset (functions, named constants, `^`, `;`, non-decimal literals, possibly-zero divisors).
- qoffset expressions outside that subset, and ratio terms outside int.
- `enable=`, the generic `threads` option and runtime commands.
- Errno-derived CLI exit statuses: EdgeFFmpeg refuses with a non-zero status of its own.
- Shared edit that would lift the subset restriction: a size hook (`geometry` or a per-link validation) for the `identity` role in `registry.ts` and the negotiators, so the expressions can be evaluated per link as `config_input` does.
