# Fillborders

`fillborders` fills the left, right, top and bottom borders of each plane in place, as
pinned FFmpeg `libavfilter/vf_fillborders.c` does. It is a `frame` operator
registered in `packages/avfilter/src/video-ops/fillborders.ts`. The kernel is in
`packages/avfilter/src/video-fillborders.ts`, and provenance is in
`packages/avfilter/NOTICE-FILLBORDERS`.

## Syntax

`fillborders=left:right:top:bottom:mode:color`, using the native shorthand order, or named
`left=`, `right=`, `top=`, `bottom=`, `mode=` and `color=`. When an option is repeated, the last value wins.

- **Borders.** Decimal integers from 0 to 2147483647. The default is 0. Expressions,
  signs, fractions and suffixes are refused.
- **Mode.** `smear` (the default), `mirror`, `fixed`, `reflect`, `wrap`, `fade` or `margins`, or the
  single-digit index `0` to `6`. Flag expressions such as `smear+mirror` are refused.
- **Color.** Used by `fixed` and `fade`. Accepted forms: the default `black`, `0xRRGGBB[AA]`,
  `#RRGGBB[AA]`, and each of them with an `@0xHH` or decimal `@alpha` in
  [0, 1], which is truncated as `255 * alpha` the way native's double-to-uint8 store
  truncates it. Named colours other than `black`, bare hex, `0X`, `random` and
  `bikeshed` are refused. There is no shared colour module.
- **Refused.** `enable=`, every other option and runtime commands. The descriptor sets
  neither `timeline` nor `geometryCommands`, so commands are refused automatically.

## Formats

`formats()` is native `pix_fmts` in declared order (57 formats: planar YUV, YUVA, GBR(A)P and
gray at every depth, `yuvj` included), so the shared negotiators pick exactly what native picks.
Frames run in `yuv444p`, `yuv422p`, `yuv420p`, `yuva420p`, `gbrp` and `gray`
(`fillbordersPixelFormats`, the eight-bit members with frame storage), and in the legacy
`yuvj420p`/`yuvj422p`/`yuvj444p` sources of linear chains. nv12 and nv21 convert to yuv420p, and
rgb24 and bgr24 to gbrp, as natively.

Packed RGB with alpha (`rgba`, `bgra`, `argb`, `abgr`) converts to `gbrap` natively, which has no
frame storage here. The negotiators refuse it at plan time with `Video filter fillborders input
negotiates gbrap, which is not implemented`, on every path and before any output is opened.
Before the shared negotiation fix this table picked `yuva420p` for `rgba` and diverged.

## Semantics

- **Size checks.** `geometry` repeats native's "Borders are bigger than input frame
  size." check with the same message: `w < l+r`, `w <= l`, `w <= r`, `w < 2l`, `w < 2r`, and the same
  checks on the height. `frame` repeats it.
- **Chroma planes.** Their borders are the luma borders shifted right by the
  format's log2 chroma subsampling. Their sizes are rounded up, as `AV_CEIL_RSHIFT` does.
- **Fill colour.** YUV formats use integer `RGB_TO_Y_CCIR`/`RGB_TO_U_CCIR`/`RGB_TO_V_CCIR`,
  and the alpha plane of `yuva420p` takes the colour's alpha. `gbrp` uses the rgba map
  (G, B, R planes); `gray` uses the CCIR luma.
- **Order of operations.** Every mode runs native's in-place loops in native order on an owned tight copy, so overlapping
  border reads give the same result. `fade` is the integer `lerp8`.
- **Refusal of out-of-plane reads.** Native reads uninitialized or out-of-bounds memory in two cases, and both are refused:
  - `reflect` when a nonzero border on any plane is at least half of that plane. Native then reads one
    sample or row past the plane.
  - `margins` when any plane is narrower than 8 samples. Native copies 8 bytes at `width - 8`. With a nonzero top border on
    7x7 `gray`, the native reference crashed.

## Paths

`linear`, `graph`, `stream`, `actor` and `timed` are all flagged. The registry examples cover all seven modes on
8x8 `gray`.

## Determinism

The filter is all integer arithmetic, with no SIMD-dependent path. The native reference was run with `-cpuflags 0`.

## Evidence

`tests/differential/video-fillborders.test.ts` runs the native reference that
`npm run reference:build` produces on Linux x86_64; after the shared negotiation fix every test
ran on macOS arm64 against the pinned reference (sha256 `1b86106f…ab92`). The Linux x86_64 runs
predate the re-land, which changed this operator's module and tests. The re-landed code,
including the per-source negotiation test, has run only on macOS arm64:

| Test | Cases |
|---|---|
| `matches native linear fillborders across formats, modes, border tuples, colours and sizes` | 6 formats x 7 modes x 8 border tuples (zeros, two asymmetric, the maximum allowed, one-sided maxima, and three too large for native) x colours (6 for fixed/fade, 2 otherwise) x sizes 9x7, 20x10 and 33x17, on two frames (structured, then noise). 1926 rawvideo outputs are byte-identical. 1188 native "Borders are bigger" errors are reproduced with the same message. 24 reflect cases and 30 margins cases that native runs with out-of-plane reads are refused. |
| `matches native fillborders rawvideo and framecrc through linear, graph, actor and timed CLI execution` | 768 byte-identical outputs: 6 formats x 2 sizes x 8 filters x rawvideo/framecrc x 4 executions (`-vf`, `-filter_complex` on the media backend, and the timed backend with the default producer actor scheduler and the `pull` timed executor). |
| `matches native replayed fillborders branches and joins frame by frame` | 24 replay-stream graphs with split, hstack, nullsink, hflip and vflip. |
| `refuses margins on narrow chroma, named colours and timeline options before opening outputs where native runs` | 8 filters that native accepts, refused on the linear plan and on 3 CLI backends with no output opened (24). |
| `negotiates every accepted source as native does and refuses the packed-alpha gbrap picks before output on every path` | `fillborders=2:1:1:2:fixed:0x4080c0` from 17 sources (the 14 executable formats and yuvj420p/422p/444p), native's pick read from showinfo: 13 run byte-exact (`-cpuflags 0`, scalar) on the five paths (yuvj on linear chains); argb, rgba, abgr and bgra are refused naming `gbrap` on the five paths and through the media `-vf`/`-filter_complex` and timed producer/pull CLIs with no output opened. 89 checks. |

`tests/unit/video-fillborders.test.ts` covers parsing, refusals, the chroma shifts and fills,
every mode on a padded input, budgets, malformed strides, `AbortSignal`, an unmutated input and planning on
each path.

## Unsupported

The following are refused explicitly:

- formats outside the six listed above, including high bit depths and `gbrap` (packed RGB with
  alpha converts to it natively): a negotiation that picks one is refused by name;
- expression-valued borders;
- named colours and `random`;
- `enable=` and runtime commands;
- `reflect` borders that reach half a plane;
- `margins` on planes narrower than 8 samples.
