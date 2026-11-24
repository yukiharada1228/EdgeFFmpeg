# extrastereo stereo difference widening

The bounded linear audio chain accepts `extrastereo`, its two options `m` (difference coefficient) and `c` (clipping), and the positional shorthand `extrastereo=<m>` and `extrastereo=<m>:<c>`. The descriptor is `packages/avfilter/src/audio/extrastereo.ts`, adapted from `libavfilter/af_extrastereo.c` at the pinned commit (see `packages/avfilter/NOTICE-EXTRASTEREO`). It covers the raw PCM, WAV and framecrc CLI paths on stereo input. Native comparisons are gated to Linux x64.

```sh
npm run ffmpeg -- --root ./media -- -i /input.wav -af 'extrastereo=m=1.5:c=0' /wide.wav
```

## Syntax

| Form | Meaning |
|---|---|
| `extrastereo` | `m=2.5`, `c=1` |
| `m=<decimal>` | AV_OPT_TYPE_FLOAT. The decimal is parsed as a double, must lie in [-10,10] (checked before rounding, as in `write_number`), then is stored as float32 |
| `c=0`, `c=1`, `c=false`, `c=true` | AV_OPT_TYPE_BOOL |
| `extrastereo=<m>[:<c>]` | shorthand in option order. A positional value after a named one is refused, as in native |

A repeated option keeps its last value.

The chain refuses these explicitly:

- Native rejects them too: `m` outside [-10,10] (`extrastereo m must be within [-10,10]`), unknown options (`Unsupported extrastereo option: <option>`), a third positional value, a positional value after a named one, and `c` values that are not booleans (such as `2`).
- Native accepts them, but they are unimplemented: timeline `enable` (`extrastereo timeline enable is not implemented`), `m` expressions and constants such as `1+1` or `max` (`Only decimal extrastereo m values are implemented`), and the other boolean spellings (`yes`, `no`, `on`, `off`, `enable`, `disable`, `y`, `n`, any letter case; `Only 0, 1, true or false extrastereo c values are implemented`).
- Runtime commands (`process_command`) are refused because no command filter, such as `asendcmd`, is implemented.
- An empty argument list, `extrastereo=`, is refused as an unsupported filter.

## Negotiation and layout

`formats()` returns the native list `['flt']`. Every source format (u8, s16, s32, flt, dbl, packed or planar) is converted to packed float before the filter, and the encoder converts afterwards, as native's auto-inserted converters do. `negotiatedSampleFormats` is `['flt']` for every input format and encoder hint. With an integer encoder, `requiresScalarRounding` is true: the CLI comparisons use `-cpuflags 0` on both sides.

`query_formats` accepts only the stereo layout, so native remixes every other layout implicitly. `constraint()` accepts only `channels === 2 && channelLayout === 'stereo'`. Mono, three or more channels, and two-channel WAV/W64 input with a non-default mask (for example `2 channels (FL+FC)` or `downmix`) fail before output with `extrastereo requires stereo input; <layout> would be remixed implicitly`. Automatic sample-rate conversion next to the filter is refused by the derived rate rule (`extrastereo with sample rate conversion is not implemented`).

FLAC input is refused before decoding: the descriptor does not declare `flacInput`.

## Arithmetic

`apply` is stateless and works on an owned copy of the converted frame. For each sample pair it follows the C types of `filter_frame` exactly:

```text
average = fround(fround(l + r) / 2)          // float sum, double division by 2., stored as float
l'      = fround(average + fround(m * fround(l - average)))
r'      = fround(average + fround(m * fround(r - average)))
c=1:      x = x > -1 ? x : -1;  x = x > 1 ? 1 : x   // av_clipf_c: FFMIN(FFMAX(x,-1),1), NaN -> -1
```

Signed zeros follow IEEE rules. For example, `(-0,-0)` stays `(-0,-0)` with `m=-1` and becomes `(+0,+0)` with `m=0`, and the differential tests include zero, negative-zero and opposite-sign pairs. These are the unfused float semantics of the Linux x64 reference build. A scout run matched the unfused simulation on Linux in 10000/10000 cases, and the fused (FMA) simulation in only 7562/10000. macOS arm64 matched the fused simulation in 10000/10000 cases. No fused profile is implemented, so the float comparisons skip on every platform other than Linux x64.

Non-finite input samples fail with `Non-finite extrastereo input is not yet supported`. Finite float input above about 1.7e38 can overflow to `inf - inf`. With `c=1` that NaN clips to -1, as in native. With `c=0` it fails with `NaN extrastereo output without clipping is not yet supported`, because JavaScript does not pin NaN payloads. Infinite outputs from finite inputs with `c=0` are kept.

The step allocates one output frame (`frameReservation`), keeps no state and changes no counts, packet boundaries or timestamps. It checks `options.signal` every 8192 sample pairs, and `maxFrameBytes` bounds the conversion.

## Evidence

`tests/unit/extrastereo.test.ts` (6 tests) covers:

- accepted and refused syntax, with exact messages;
- negotiation for every input format and encoder hint;
- `planSamples`, `packetSections`, `plannedReservations` and the rate refusal;
- layout refusals, including masked two-channel layout names (`2 channels (FL+FC)`, `downmix`) through `validateInputFormat`. No CLI test with a masked WAV file is committed for this filter;
- per-sample output against a direct transcription of the C loop, for eight `m` values with and without clipping;
- signed zeros, opposite signs, overflow and the non-finite refusals;
- frame-split invariance, ownership, s16 conversion, allocation limits and cancellation.

`tests/differential/extrastereo.test.ts` runs `.build/reference/ffmpeg` at test time and compares bytes:

- 360 cases (Linux x64): stereo u8/s16le/s32le/f32le/f64le sources × `m` ∈ {-10,-1,0,1,2.5,10} × `c` ∈ {0,1} × six outputs (raw f32le, raw s16le, WAV pcm_f32le, WAV pcm_s16le, framecrc pcm_f32le, framecrc pcm_s16le).
- 200 framecrc cases (Linux x64): s16le and f32le sources × 10 chains (defaults, shorthand, `asetnsamples` splits before and after, `asetnsamples=1`, two chained extrastereo, `apad`, `anull`, `asetrate`) × 5 output selections (`-ss`, `-t`, `-frames:a`, both) × pcm_f32le/pcm_s16le.
- 13 refusals with native's exit status: mono and three-channel input (native 0, remixes); six forms native rejects; five forms native accepts but that are unimplemented. Each one fails before the output file exists.

A deliberately fused-style implementation (`average + m*(l-average)` in double) fails both comparison tests.

## Scoped test contracts

| File | Test title | Scope |
|---|---|---|
| `tests/differential/extrastereo.test.ts` | `matches native extrastereo bytes for stereo sources, every m and clip setting, raw, WAV and framecrc outputs (Linux x64 unfused float)` | 360 byte comparisons, linux/x64 |
| `tests/differential/extrastereo.test.ts` | `matches native extrastereo framecrc in composed chains, frame splits, defaults and output time selection (Linux x64 unfused float)` | 200 framecrc comparisons, linux/x64 |
| `tests/differential/extrastereo.test.ts` | `refuses layouts native would remix and unimplemented options before output, recording native status` | 13 refusals with native status |
| `tests/unit/extrastereo.test.ts` | `matches the C transcription per sample for every m and clip setting, including zeros, opposite signs and subnormals` | arithmetic |

## Unsupported

- Non-stereo layouts and masked two-channel layouts (native remixes them).
- Timeline `enable`, runtime commands, option expressions and constants, other boolean spellings.
- FLAC input.
- Non-finite input, and NaN output with `c=0`.
- Fused-float platforms: the comparisons skip on darwin and on any platform other than Linux x64.
