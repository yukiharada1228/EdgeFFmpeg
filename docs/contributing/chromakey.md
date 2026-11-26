# chromakey and chromahold

`chromakey` turns a key colour into transparency: it writes the alpha plane of `yuva420p` video from the chroma distance to the key. `chromahold` turns everything except the key colour range gray: it moves the chroma of distant samples toward 128. Both are adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_chromakey.c` (`do_chromakey_pixel`, `get_pixel_uv`, `do_chromakey_slice`, `do_chromahold_slice`, `filter_frame`, `config_output`, `config_input`) at `946fcce07b6dcd0331c8cc609192aeff5e1924f8`. The two descriptors (`packages/avfilter/src/video-ops/chromakey.ts`, `chromahold.ts`) share one kernel module, `packages/avfilter/src/video-chromakey.ts`. Provenance: `packages/avfilter/NOTICE-CHROMAKEY`.

## Syntax

```
chromakey[=color:similarity:blend:yuv][:threads=1]
chromahold[=color:similarity:blend:yuv][:threads=1]
chromakey=color=<color>:similarity=<float>:blend=<float>:yuv=<bool>:threads=1
```

- `color` defaults to `black`. It is an `AV_OPT_TYPE_COLOR` parsed by the shared `parseColor` (PREP-COLOR): colour names, `#`/`0x` `RRGGBB[AA]` and `@` alphas, exactly as native. The alpha is parsed and ignored, as natively.
- `similarity` defaults to 0.01, range [0.00001, 1]. `blend` defaults to 0, range [0, 1]. Both are `AV_OPT_TYPE_FLOAT`: the decimal value is range-checked as a double, then stored with `Math.fround`.
- `yuv` defaults to false. It is an `AV_OPT_TYPE_BOOL` (`true`/`yes`/`on`/`enable(d)`, their negatives, or a decimal 0 or 1). When true, the colour's green and blue bytes are the key U and V.
- `threads=1` is the generic filter option. It is accepted on both filters and is required by `chromakey` frames taller than one row (see [Threads](#threads)).
- Without `yuv`, the key is converted with native's integer macros: `U = ((-173 R - 339 G + 512 B + 511) >> 10) + 128` and `V = ((512 R - 429 G - 83 B + 511) >> 10) + 128`, whose coefficients are `lrint(c * 1024)` of 0.16874, 0.33126, 0.5, 0.41869 and 0.08131.
- If a key is repeated, the last value wins.

Explicit refusals, raised before any output is written:

- invalid colours (`nosuchcolor`, `#ff00`, `red@1.5`, an empty colour), with native's `av_parse_color` message. Native fails these with status `256 - EINVAL`;
- `random`, `bikeshed` and NaN or platform-dependent alphas, which native accepts with random or undefined values;
- out-of-range floats (`similarity=0`, `similarity=1.5`, `blend=2`). Native fails these with `256 - ERANGE`. Booleans other than 0 and 1 (`yuv=2`, `yuv=maybe`) fail natively with `256 - EINVAL`;
- expression-valued floats (`1/2`, `0x1`, `PI/4`, `1k`), which native evaluates;
- `threads` values other than 1, `enable=` (timeline) and every other option. Unknown keys fail natively with `AVERROR_OPTION_NOT_FOUND` (status 8);
- runtime commands. They are refused automatically: the descriptors set neither `timeline` nor `geometryCommands`. Native `process_command` would re-run `config_output`.
- `chromakey` frames taller than one row without `threads=1`, in `geometry()` on every path and again in `frame()`: `Chromakey frames taller than one row need threads=1: native alpha depends on the filter thread count`.

Every scoped refusal through the CLI currently exits with status 1, because the avformat backends map every filter parse error to 1. Native's 234 (Linux EINVAL) or 222 (ERANGE) would need a shared change that lets a filter parse error carry its exit status; it is listed in the report.

## Formats

`formats()` returns native `query_formats` lists in declared order, unintersected: `chromakey_fmts` (14 YUVA formats) and `hold_pixel_fmts` (32 planar YUV and YUVA formats). The shared negotiators pick exactly what native picks and refuse picks without frame storage by name, before output.

- `chromakey` runs in `yuva420p`. Native picks `yuva420p` from yuv420p, nv12, nv21, yuva420p and yuvj420p sources, and those run on every path. It picks `yuva444p` or `yuva422p` from every other source, and those are refused with `Video filter chromakey input negotiates <format>, which is not implemented`.
- `chromahold` runs in `yuv420p`, `yuv422p`, `yuv444p` and `yuva420p`. Native converts RGB, gbrp and gray sources to `yuv444p` and the yuvj sources to their yuv siblings, which run; packed RGB with alpha becomes `yuva444p`, which is refused.

The registry examples start with an explicit `format=` because they run from an 8x8 gray source.

## Arithmetic and determinism

`chromakey` copies Y, U and V and rewrites A. For every luma position it gathers the 3x3 neighbourhood in luma coordinates and samples chroma at `(x >> 1, y >> 1)`. As natively, the nine-slot U/V windows start as the key and persist from pixel to pixel, so a neighbour outside the frame keeps the value its slot last held: the key along the top row and at the first pixel, the previous pixel's value elsewhere. The distance is the sum of nine `sqrt((du*du + dv*dv) / 130050)` doubles divided by 9. With `blend > 0.0001` (the stored float compared as a double) the alpha is `clip((diff - similarity) / blend, 0, 1) * 255` truncated; otherwise 255 when `diff > similarity`, else 0. Every operation is a correctly rounded double operation with no multiply-add, so it is expected to match on every platform; the chromakey cases run on Linux and macOS.

`chromahold` copies Y (and A) and processes `(w >> hsub) x (h >> vsub)` chroma samples: a trailing chroma column or row of an odd-sized subsampled frame is kept unchanged, as natively. A sample further than `similarity` becomes 128; with `blend > 0.0001`, `U = trunc(128 + (u - 128) * f)` with `f = 1 - clip((diff - similarity) / blend, 0, 1)`. That expression is a multiply-add that clang may fuse on macOS arm64, so the blend-ramp cases run only on linux-x64, in their own test with a constant title. The gate is a precaution: no macOS difference has been measured.

Output planes are owned and tight; the timestamp and metadata are copied and the input is not mutated.

## Threads

Native runs `min(height, threads)` slices. `do_chromakey_slice` resets the windows to the key at the start of each slice, so the first pixel of each later slice (and, when the last slice is one row, that whole row) sees the key where a single slice sees stale neighbours. With the default filter thread count (the host CPU count), native `chromakey` alpha therefore depends on the host for any frame taller than one row. Measured here (4 vCPUs): the default thread count and `-filter_threads 1` disagree on taller frames. With the filter's own `threads=1`, native always runs one slice and the two agree. This module implements the one-slice result: it accepts frames of one row, and taller frames with `threads=1`, and refuses the rest.

`chromahold` processes each chroma sample independently, so its output agrees at every thread count; `threads=1` is accepted there and has no effect.

## Paths

Both descriptors flag `linear`, `graph`, `stream`, `actor` and `timed`. Each path is covered by a differential test.

## Evidence

All comparisons are byte-exact against `.build/reference/ffmpeg`, run at test time with `-cpuflags 0` and scalar arithmetic. The sandbox build reads commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8` and `--disable-x86asm` from `.build/reference/build-metadata.json`; its ffmpeg sha256 is `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built with `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0` on Linux x86_64. Everything below ran on that Linux x86_64 build only; no macOS run has been made.

Inputs are three frames: LCG noise; tiles of the green (86,74) and blue (255,107) keys, near-key ramps, checkerboard edges and saturated values; and constant planes with a key-coloured quarter. Sizes are 1x1, 2x2, 5x3, 7x5, 8x6 and 17x9 unless stated.

| Test (tests/differential/video-chromakey.test.ts) | Cases |
|---|---|
| matches native chromakey alpha across keys, similarity, blend, yuv colours, sizes and noise and structured frames | 113 native runs, each compared on the linear and frame-graph planners with padded strides: 13 option sets (green, blue, red, lime, yuv keys; similarity 0.00001 to 1; blend 0, 0.0001 (a hard threshold after float storage), 0.00011, 0.05, 0.2, 0.5, 1) with `threads=1` x 6 sizes, and 7 option sets without `threads` at 1x1, 2x1, 7x1, 17x1 and 64x1 |
| matches native integer chromahold across formats, keys, similarity, yuv colours, odd chroma edges and noise and structured frames | 192 (4 formats x 6 sizes x 8 option sets, blend 0 or 0.0001) |
| matches native chromahold blend ramps on linux-x64 | 120 (4 formats x 6 sizes x 5 blend ramps); linux-x64 only |
| matches native chromakey and chromahold rawvideo and framecrc CLI outputs with and without -ss/-t on the linear, graph, stream, actor and timed paths | 200 (chromakey yuva420p and chromahold in 4 formats, 7x5 and 17x9, 5 paths, rawvideo and framecrc, with and without `-ss 0.04 -t 0.08`) |
| matches native replayed chromakey and chromahold branches frame by frame through createReplayVideoExecution | 10 (5 formats x single and split/stack graphs) |
| agrees with native at the default filter thread count and -filter_threads 1 wherever it runs, and refuses tall default-thread chromakey | 546 native pairs agree (every chromahold case, chromakey with `threads=1`, one-row chromakey without it, at the 6 sizes plus 64x1 and 17x33); 78 tall default-thread chromakey cases are refused here, and native disagrees on some of them when the host has more than one CPU |
| matches native option acceptance and refuses invalid colors, out-of-range floats, expressions and other threads before output | 74 (37 option strings x 2 filters): 34 accepted and byte-exact, 24 refused by both (native statuses asserted with host errno; the EdgeFFmpeg CLI refuses before any output with status 1), 16 scoped refusals |
| refuses tall default-thread chromakey and the yuva444p pick of packed alpha sources on every CLI backend before output | 8 (media `-vf` and `-filter_complex`, timed producer and pull) |
| negotiates every accepted source as native does and refuses picks without storage before output on every path | chromakey from 17 sources: 5 run byte-exact on the five paths (yuvj420p on linear chains), 12 refused naming `yuva444p` or `yuva422p`, 113 checks; chromahold: 13 run, 4 refused naming `yuva444p`, 89 checks |

The unit tests are in `tests/unit/video-chromakey.test.ts` (7 tests). They cover parsing and every refusal, the key conversion, the stale-window alpha and the odd chroma edge of the hold, the declared format lists and plan-time refusals on the linear, graph and timed planners, budgets, malformed strides, AbortSignal, an unmutated input and owned output planes.

## Proposed contracts

| id | file | test title | scope | platforms |
|---|---|---|---|---|
| filter.chromakey.parse | tests/unit/video-chromakey.test.ts | parses defaults, shorthand order, colors, float ranges, booleans and threads=1 into frozen steps | option syntax | all |
| filter.chromakey.refusals | tests/unit/video-chromakey.test.ts | refuses invalid and unsupported colors, out-of-range and expression floats, timeline, threads and unknown options explicitly | parser refusals | all |
| filter.chromakey.limits | tests/unit/video-chromakey.test.ts | rejects unsupported layouts, budgets, malformed storage, bad settings and cancellation explicitly | maxFrameBytes, strides, AbortSignal | all |
| filter.chromakey.alpha | tests/differential/video-chromakey.test.ts | matches native chromakey alpha across keys, similarity, blend, yuv colours, sizes and noise and structured frames | yuva420p, linear and graph | all |
| filter.chromakey.hold | tests/differential/video-chromakey.test.ts | matches native integer chromahold across formats, keys, similarity, yuv colours, odd chroma edges and noise and structured frames | yuv420p/422p/444p/yuva420p, blend 0 | all |
| filter.chromakey.hold-blend | tests/differential/video-chromakey.test.ts | matches native chromahold blend ramps on linux-x64 | blend ramp | linux-x64 |
| filter.chromakey.cli | tests/differential/video-chromakey.test.ts | matches native chromakey and chromahold rawvideo and framecrc CLI outputs with and without -ss/-t on the linear, graph, stream, actor and timed paths | five paths, rawvideo and framecrc | all |
| filter.chromakey.stream | tests/differential/video-chromakey.test.ts | matches native replayed chromakey and chromahold branches frame by frame through createReplayVideoExecution | replay streams | all |
| filter.chromakey.threads | tests/differential/video-chromakey.test.ts | agrees with native at the default filter thread count and -filter_threads 1 wherever it runs, and refuses tall default-thread chromakey | thread-count independence | all |
| filter.chromakey.options | tests/differential/video-chromakey.test.ts | matches native option acceptance and refuses invalid colors, out-of-range floats, expressions and other threads before output | option acceptance | all |
| filter.chromakey.cli-refusals | tests/differential/video-chromakey.test.ts | refuses tall default-thread chromakey and the yuva444p pick of packed alpha sources on every CLI backend before output | CLI refusals before output | all |
| filter.chromakey.negotiation | tests/differential/video-chromakey.test.ts | negotiates every accepted source as native does and refuses picks without storage before output on every path | per-source negotiation | all |

## Unsupported

- `chromakey` frames taller than one row without `threads=1` (native output depends on the host CPU count).
- High-bit-depth formats and yuva422p/yuva444p, which have no frame storage here; picks of them are refused by name.
- Expression-valued options, `threads` other than 1, `enable=` and runtime commands.
- `random`/`bikeshed` colours and NaN or platform-dependent colour alphas.
- Native exit statuses for parse refusals on the CLI (currently 1).
