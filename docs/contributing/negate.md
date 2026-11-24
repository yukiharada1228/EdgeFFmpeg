# negate video filter

`negate` follows the standalone pinned `libavfilter/vf_negate.c` (FFmpeg 9.0.2 no
longer routes it through the lut filters). `negateVideoFrame` materializes owned
tight positive-stride planes, preserves bigint PTS and metadata and checks frame,
storage, time-base and cancellation limits like the reflection operators.

The linear chain (`compileVideoFilterChain`, rawvideo `-vf`), the branch graph
(`compileVideoFilterGraph`, rawvideo `-filter_complex`) and the replay executor
accept `negate`. MP4/H264 processing shares the linear chain but has no negate
comparison yet. Negotiation restricts it to the twelve
declared layouts in the native list: gray, YUV420P/422P/444P, YUVA420P, the six
packed RGB layouts and GBRP. NV12/NV21 input receives an automatic conversion, as
in native negotiation. The timed actor executors reject `negate` explicitly with
`Actor operators not implemented`; `planTimedVideoGraph` does not restrict it.

## Options

`components` (shorthand position one) and `negate_alpha` (position two) are
supported. Component flags fold left from the current value as `AV_OPT_TYPE_FLAGS`
does: `y+u`, `+a`, `-y`, `all-r`, repeated `components=` keys and the expression
constants `default`, `max`, `min`, `none` and `all`. Terms may be declared names or
decimal/`0x` integers up to 4294967295. `negate_alpha` uses the LP64 `strtol` and
signed32 narrowing of `AV_OPT_TYPE_BOOL`, including empty and named values.

Native configuration semantics are retained and checked before file I/O:

- Exactly `0x77` (the default, `default`, `119` or `y+u+v+r+g+b`) skips the
  availability check; YUV/gray planes 0-2 are negated and `negate_alpha` adds plane 3.
- Any other value fails with `Requested components not available` when it names a
  component the negotiated format lacks, and otherwise selects planes from the
  components only; `negate_alpha` is then ignored.
- Packed RGB selects bytes through the rgba map from the components only, so
  `negate_alpha=1` leaves packed alpha unchanged while `components=a` negates it.
  GBRP maps R/G/B to planes 2/0/1.
- After a semiplanar conversion boundary, negate can share an RGB sink constraint,
  which makes Y/U/V components unavailable as in native.

Unsupported forms fail explicitly: `enable` timeline expressions, generic filter
context options such as `threads`, av_expr flag terms (`y*2`, `1e1`, `++y`, `(y)`),
flag values longer than 255 characters, runtime commands, 9-16 bit and other
undeclared formats, and negative-stride input.

## Evidence

All comparisons run the pinned `.build/reference/ffmpeg` built from
`compat/configure.flags`; on 2026-11-24 this was the macOS arm64 build.

- `tests/differential/video-negate-helper.test.ts`: 1,440 native runs over twelve
  formats, six geometries and twenty option sets: 726 raw byte matches and 714
  matching `Requested components not available` rejections.
- `tests/differential/video-negate-options.test.ts`: 248 option/format cases with
  identical acceptance (116 raw byte matches), plus 28 explicit rejections of
  forms of which 20 are native-valid.
- `tests/differential/video-negate-graph.test.ts`: 10,080 negotiated linear cases
  over 14 sources, 15 targets, six chains, output sizes and default/scalar
  arithmetic: 8,936 raw byte matches and 1,144 matching rejections.
- `tests/differential/video-negate-cli.test.ts`: 384 rawvideo/framecrc CLI outputs
  with time and size options, 96 `-filter_complex` branch outputs and seven
  rejections before any output is opened.
- `tests/differential/video-negate-stream.test.ts`: 16 replayed graph outputs.
- `tests/integration/video-negate.test.ts`: 16 actual Node launcher outputs.

Workers runtime, Linux x86_64 reference and production behavior remain unverified
for this filter. The arithmetic of inserted conversions follows the existing
profile selection in `tests/helpers/reference-pixel-profile.ts`.
