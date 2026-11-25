# chromashift

`chromashift` shifts the two chroma planes of planar YUV video by whole samples and copies luma unchanged. It is adapted from pinned FFmpeg 9.0.2 `libavfilter/vf_chromashift.c` (`smear_slice8`, `wrap_slice8`, `filter_frame`, `config_input`) at `946fcce07b6dcd0331c8cc609192aeff5e1924f8`. Only `chromashift` is implemented. `rgbashift` is not. Provenance: `packages/avfilter/NOTICE-CHROMASHIFT`.

## Syntax

```
chromashift[=cbh:cbv:crh:crv:edge]
chromashift=cbh=<int>:cbv=<int>:crh=<int>:crv=<int>:edge=smear|wrap|0|1
```

- `cbh`, `cbv`, `crh` and `crv` default to 0. Each takes a decimal integer from -255 to 255, with an optional sign and leading zeros. The shorthand order is the native option order.
- `edge` defaults to `smear` (0). It also accepts `wrap` (1), `0` and `1`.
- If a key is repeated, the last value wins.

Explicit refusals, raised before any output is written:

- values outside -255..255, such as `cbh=256`. Native also fails these, with a non-zero status;
- native expression forms that the scoped parser does not evaluate: `1+1`, `1.5`, `0x1`, an empty value, or `edge=smear+wrap`;
- `edge` values other than the four above;
- `enable=` (timeline), `threads=`, `rh` and every other option;
- runtime commands. They are refused automatically, because the descriptor sets neither `timeline` nor `geometryCommands`.

## Formats

`formats()` returns native `yuv_pix_fmts` in declared order (39 formats: planar YUV and YUVA at every depth, `yuvj` included), so the shared negotiators pick exactly what native picks. Frames run in `yuv420p`, `yuv422p` and `yuv444p`, and in the legacy `yuvj420p`/`yuvj422p`/`yuvj444p` sources of linear chains. `validate()` refuses `yuva420p` with `Chromashift yuva420p is not implemented: native output leaves the alpha plane unwritten`. Native never writes the alpha plane of its output buffer, so the result depends on buffer-pool history. `frame()` repeats the format check and checks the plane count, strides, storage and allocation budget.

Native converts gray to full-range `yuvj444p` and packed RGB with alpha (rgba, bgra, argb, abgr) to `yuva444p`. Neither has frame storage here, so the negotiators refuse them at plan time with `Video filter chromashift input negotiates <format>, which is not implemented`, on every path and before any output is opened. Before the shared negotiation fix, gray silently negotiated `yuv444p` (different bytes) and packed RGBA was refused as `yuva420p`.

The other implicit conversions match native: nv12/nv21 to yuv420p, and rgb24, bgr24 and gbrp to yuv444p, with `-cpuflags 0` (scalar arithmetic). The registry examples start with an explicit `format=`, because they run from a gray source.

## Arithmetic and determinism

This is an integer index copy with no arithmetic on sample values. Luma is copied row by row. `smear` clamps the source index to `[0, size-1]`. `wrap` takes the C remainder `(i - shift) % size` and adds `size` when the result is negative. Both chroma planes use the plane-1 width and height, as native does. Output planes are owned and tight. The timestamp is copied, and so is the metadata. Natively the result is stable across thread counts for the three implemented formats and identical on macOS and Linux.

## Paths

The descriptor flags `linear`, `graph`, `stream`, `actor` and `timed`. Each is covered by a differential test.

## Evidence

All comparisons are byte-exact against `.build/reference/ffmpeg` (Linux x86_64, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`), run at test time. After the shared negotiation fix every test was rerun on macOS arm64 against the pinned reference (sha256 `1b86106f…ab92`):

| Test (tests/differential/video-chromashift.test.ts) | Cases |
|---|---|
| matches native linear chromashift rawvideo across formats, shifts, edges, sizes and noise and gradient inputs | 486 (3 formats x 5x3, 9x7, 16x12 x 27 shift sets with 0, ±1, ±3, larger than the plane, ±255 x smear and wrap, with noise and gradient frames) |
| matches native chromashift -vf and -filter_complex CLI rawvideo and framecrc including implicit conversions | 448 |
| matches native chromashift frame graphs and replayed streams with split and stack branches | 48 (24 graph, 24 stream) |
| matches native chromashift through activation actors and the timed backend in rawvideo and framecrc | 120 (24 actor, 96 timed CLI) |
| refuses chromashift yuva420p and out-of-range options before output where native accepts or fails them | 24 (rgba names native's `yuva444p`) |
| negotiates every accepted source as native does and refuses the gray and packed-alpha picks without storage before output | `chromashift=cbh=1:crv=-2` from 16 sources (the 14 executable formats but yuva420p, and yuvj420p/422p/444p), native's pick read from showinfo: 11 run byte-exact (`-cpuflags 0`, scalar) on the five paths (yuvj on linear chains); gray, argb, rgba, abgr and bgra are refused naming `yuvj444p` or `yuva444p` on the five paths and through the media `-vf`/`-filter_complex` and timed producer/pull CLIs with no output opened: 88 checks |

The unit tests are in `tests/unit/video-chromashift.test.ts` (4 tests). They cover parsing, refusals, budgets, malformed strides, AbortSignal, an unmutated input, and the yuva420p refusal in the linear, graph and timed planners.

## Unsupported

- `rgbashift`.
- High-bit-depth, yuv440p, yuv411p, yuv410p, yuvj440p, yuvj411p, yuva444p and yuva422p formats have no frame storage here; a negotiation that picks one, such as gray (`yuvj444p`) or packed RGB with alpha (`yuva444p`), is refused by name before output.
- `yuva420p`, which is refused.
- `enable=` and runtime commands.
- Expression-valued options.
