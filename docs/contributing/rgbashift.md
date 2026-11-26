# rgbashift

`rgbashift` shifts the R, G and B planes of planar RGB video by whole samples, each horizontally and vertically. It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_chromashift.c` (`rgbasmear_slice8`, `rgbawrap_slice8`, `filter_frame`, `config_input`, `rgbashift_options`, `rgb_pix_fmts`) at `946fcce07b6dcd0331c8cc609192aeff5e1924f8`. It is a separate module (`packages/avfilter/src/video-ops/rgbashift.ts`); the `chromashift` module is unchanged. Provenance: `packages/avfilter/NOTICE-RGBASHIFT`.

## Syntax

```
rgbashift[=rh:rv:gh:gv:bh:bv:ah:av:edge]
rgbashift=rh=<int>:rv=<int>:gh=<int>:gv=<int>:bh=<int>:bv=<int>:ah=<int>:av=<int>:edge=smear|wrap|0|1
```

- `rh`, `rv`, `gh`, `gv`, `bh`, `bv`, `ah` and `av` default to 0. Each takes a decimal integer from -255 to 255, with an optional sign and leading zeros. The shorthand order is the native AVOption order.
- `edge` defaults to `smear` (0). It also accepts `wrap` (1), `0` and `1`.
- If a key is repeated, the last value wins.
- `ah` and `av` are accepted and have no effect on gbrp, the only executable format: native skips the alpha loop when the format has fewer than four planes.

Explicit refusals, raised before any output is written:

- values outside -255..255, such as `rh=256`. Native also fails these, with a non-zero status;
- native expression forms that the scoped parser does not evaluate: `1+1`, `1.5`, `0x1`, an empty value, or `edge=smear+wrap` (native accepts `gh=1+1`; refused here);
- `edge` values other than the four above;
- `enable=` (timeline; native accepts it), `threads=`, the chromashift options and every other option;
- runtime commands. They are refused automatically, because the descriptor sets neither `timeline` nor `geometryCommands`.

## Formats

`formats()` returns native `rgb_pix_fmts` in declared order with native-endian names: `gbrp gbrap gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap10le gbrap12le gbrap16le`. Only `gbrp` has frame storage here. `validate()` refuses every other format with `Rgbashift pixel format is not supported`, and `frame()` repeats that check and checks the plane count, strides, storage and allocation budget.

Native converts every executable source to `gbrp` except packed RGB with alpha (argb, rgba, abgr, bgra) and `yuva420p`, which it converts to `gbrap`. `gbrap` has no frame storage here, so the shared negotiators refuse those sources at plan time with `Video filter rgbashift input negotiates gbrap, which is not implemented`, on every path and before any output is opened. The other implicit conversions (rgb24, bgr24, gray, yuv420p, yuv422p, yuv444p, nv12, nv21 and the legacy yuvj sources of linear chains) match native byte for byte with `-cpuflags 0` and scalar arithmetic.

The registry examples run from an 8x8 gray source. Native picks `gbrp` there, so the first example is bare `rgbashift`; the others start with `format=gbrp`.

## Arithmetic and determinism

This is an integer index copy with no arithmetic on sample values. Planes are G (0), B (1) and R (2), shifted by (`gh`,`gv`), (`bh`,`bv`) and (`rh`,`rv`). `smear` clamps the source index to `[0, size-1]`. `wrap` takes the C remainder `(i - shift) % size` and adds `size` when the result is negative. Every plane uses the plane-1 width and height, which equal the frame size for gbrp. Output planes are owned and tight. The timestamp is copied, and so is the metadata. The result depends on no thread count or platform, so no case is gated.

Native's wrap kernel computes the alpha row as `(x - av) % h` rather than `(y - av) % h`. That only affects four-plane formats (gbrap), which are refused here, so it is not reproduced.

## Paths

The descriptor flags `linear`, `graph`, `stream`, `actor` and `timed`. Each is covered by a differential test.

## Evidence

All comparisons are byte-exact against `.build/reference/ffmpeg`, built from the pinned commit with `--disable-x86asm` in the sandbox (Linux x86_64, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`), run at test time. The binary is not pinned by the tests; they read `.build/reference/build-metadata.json` and assert the commit and `--disable-x86asm`.

| Test (tests/differential/video-rgbashift.test.ts) | Cases |
|---|---|
| runs against the pinned-commit native reference built without x86 assembly | 1 |
| matches native linear rgbashift gbrp rawvideo across channel shifts, edges, sizes and noise, ramp and edge patterns | 624 (1x1, 2x2, 5x3, 7x5, 8x6, 17x9 x 52 shift sets: zero, each of rh rv gh gv bh bv ah av at ±1, ±(beyond the frame) and ±255, and three combined sets larger than the frame x smear and wrap; 3 frames of noise, ramps, and edges with a constant plane) |
| matches native rgbashift -vf and -filter_complex CLI rawvideo and framecrc with timing and rgb24 and gray conversions | 900 (gbrp, rgb24, gray, bgr24 to rgb24, gbrp to gray x 1x1, 5x3, 17x9 x 5 descriptions x -vf/-filter_complex x rawvideo/framecrc x no timing, input -ss with output -t, output -ss with -frames:v; `-cpuflags 0`, scalar) |
| matches native rgbashift frame graphs and replayed streams with split and stack branches | 24 (12 graph, 12 stream) |
| matches native rgbashift through activation actors and the timed backend in rawvideo and framecrc | 60 (12 actor, 48 timed CLI) |
| refuses rgbashift gbrap picks, out-of-range options, timelines and unknown options before output where native accepts or fails them | 32 |
| negotiates every accepted source as native does and refuses the packed-alpha and yuva gbrap picks before output on every path | `rgbashift=rh=1:gv=-2:bh=3:edge=wrap` from 17 sources, native's pick read from showinfo: 12 run byte-exact on the five paths (yuvj on linear chains); argb, rgba, abgr, bgra and yuva420p are refused naming `gbrap` on the five paths and through the media `-vf`/`-filter_complex` and timed producer/pull CLIs with no output opened: 93 checks |

The differential file runs in about 15 seconds on the sandbox. The unit tests are in `tests/unit/video-rgbashift.test.ts` (4 tests). They cover parsing, refusals, `maxFrameBytes`, malformed strides, AbortSignal, an unmutated input, owned output planes, the inert alpha shifts, and the gbrap refusal in the linear, graph and timed planners. The registry test (`tests/unit/video-operator-registry.test.ts`) runs the four examples on the five paths.

A mutation that swaps the R and G shift planes fails five of the seven differential tests.

## Proposed contracts

All in `tests/differential/video-rgbashift.test.ts`, modes `differential`, every platform (no gating):

| Id | Exact test title | Scope |
|---|---|---|
| `filter.rgbashift.linear` | matches native linear rgbashift gbrp rawvideo across channel shifts, edges, sizes and noise, ramp and edge patterns | gbrp linear chains, every option and both edges |
| `filter.rgbashift.cli` | matches native rgbashift -vf and -filter_complex CLI rawvideo and framecrc with timing and rgb24 and gray conversions | media backend CLI, conversions, timing |
| `filter.rgbashift.graph-stream` | matches native rgbashift frame graphs and replayed streams with split and stack branches | graph and stream paths |
| `filter.rgbashift.actor-timed` | matches native rgbashift through activation actors and the timed backend in rawvideo and framecrc | actor and timed paths |
| `filter.rgbashift.refusals` | refuses rgbashift gbrap picks, out-of-range options, timelines and unknown options before output where native accepts or fails them | refusals before output |
| `filter.rgbashift.negotiation` | negotiates every accepted source as native does and refuses the packed-alpha and yuva gbrap picks before output on every path | per-source negotiation |

## Unsupported

- gbrap and the high-bit-depth gbrp/gbrap formats: no frame storage here; a negotiation that picks one (gbrap from packed RGB with alpha or yuva420p) is refused by name before output.
- `enable=` and runtime commands.
- Expression-valued options.
