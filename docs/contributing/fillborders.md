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

The candidate formats are `yuv444p`, `yuv422p`, `yuv420p`, `yuva420p`, `gbrp` and `gray`. This
is native `pix_fmts` intersected with `negotiationOrder`, in table order. Native also lists
formats that the negotiation table does not have, such as `gbrap`, `yuvj*` and high bit depths.
Implicit conversions from other inputs can therefore negotiate a different format than native
would: native picks `gbrap` for `rgba` input, while this table picks `yuva420p`. For that reason
the differential tests use inputs in the operator's own formats.

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
`npm run reference:build` produces on Linux x86_64:

| Test | Cases |
|---|---|
| `matches native linear fillborders across formats, modes, border tuples, colours and sizes` | 6 formats x 7 modes x 8 border tuples (zeros, two asymmetric, the maximum allowed, one-sided maxima, and three too large for native) x colours (6 for fixed/fade, 2 otherwise) x sizes 9x7, 20x10 and 33x17, on two frames (structured, then noise). 1926 rawvideo outputs are byte-identical. 1188 native "Borders are bigger" errors are reproduced with the same message. 24 reflect cases and 30 margins cases that native runs with out-of-plane reads are refused. |
| `matches native fillborders rawvideo and framecrc through linear, graph, actor and timed CLI execution` | 768 byte-identical outputs: 6 formats x 2 sizes x 8 filters x rawvideo/framecrc x 4 executions (`-vf`, `-filter_complex` on the media backend, and the timed backend with the default producer actor scheduler and the `pull` timed executor). |
| `matches native replayed fillborders branches and joins frame by frame` | 24 replay-stream graphs with split, hstack, nullsink, hflip and vflip. |
| `refuses margins on narrow chroma, named colours and timeline options before opening outputs where native runs` | 8 filters that native accepts, refused on the linear plan and on 3 CLI backends with no output opened (24). |

`tests/unit/video-fillborders.test.ts` covers parsing, refusals, the chroma shifts and fills,
every mode on a padded input, budgets, malformed strides, `AbortSignal`, an unmutated input and planning on
each path.

## Unsupported

The following are refused explicitly:

- formats outside the six listed above, including high bit depths;
- expression-valued borders;
- named colours and `random`;
- `enable=` and runtime commands;
- `reflect` borders that reach half a plane;
- `margins` on planes narrower than 8 samples.
