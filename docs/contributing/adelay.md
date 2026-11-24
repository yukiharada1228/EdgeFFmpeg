# adelay per-channel delay

The bounded linear audio chain accepts `adelay`, `adelay=<delays>`, `adelay=<delays>:<all>` and the named `delays=`/`all=` options. This is partial adelay compatibility for the WAV, AIFF, raw PCM and framecrc CLI paths and the `delayAudio` stream API. AU output shares the same path but has no native comparison.

```sh
npm run ffmpeg -- --root ./media -- -i /input.wav -af 'adelay=10|1500S:all=1' /delayed.wav
```

## Delay values

`delays` is a `|` list with one value per channel. Empty fields are skipped, as `av_strtok` does. Supported spellings are a subset of the native `%SCNd64%c` / `%f` parse:

| Form | Meaning |
|---|---|
| `<digits>S` | exact samples, up to signed64 |
| `<digits>s` | seconds |
| `<decimal>` | milliseconds |
| `<decimal>s`, `<decimal>S` with a fraction (for example `1.5s`, `.5s`, `7.S`) | milliseconds. Native reads an integer followed by `.`, so these are not seconds or samples |

Seconds and milliseconds follow `config_input`: the value is parsed as float32, `delay * sample_rate / div` is evaluated in float32, and the result is truncated toward zero. For example, 110.839 ms at 11025 Hz gives 1222 samples (the exact value is 1221.999975, which would truncate to 1221), and 1523 s at 11025 Hz gives 16791076 samples. The sample rate is the rate at adelay's position in the chain, so a preceding `asetrate` applies. Decimals that land exactly on a float32 rounding midpoint in double precision are rejected rather than approximated. No committed test covers that rejection; a scratch probe saw it for `1.000000059604644775390625`, which native accepts.

Channels without a value are not delayed. `all=1` copies the last value that was read to the remaining channels. As in native, values beyond the channel count are never parsed, so `adelay=5S|abc` is valid for mono input.

Explicit failures:

- Native rejects these too: negative values, unparsable text, booleans its parser rejects (such as `2`), an extra positional value (`5S:1:1`), a positional value after a named one (`delays=5S:5S`) and unknown options. Native also fails to configure `inf` (exit 244 in a scratch probe), which EdgeFFmpeg refuses as an unsupported token.
- Native accepts these, but they are unimplemented and fail with an `adelay` diagnostic before output is created: signs (`+5S`, `-0`), exponents, hexadecimal, `nan`, trailing text such as `5ms`, leading or inner whitespace (` 5S`, `5S| 6S`), escaping and other boolean spellings such as `yes`.

The differential refusal test asserts native status for the forms it lists. `inf` and whitespace are covered only by the unit parser test and scratch probes. Whitespace at the very end of the filter arguments is removed by the filter-chain parser and accepted, as in native. Scratch probes matched native output for this case, but no committed test covers it.

## Execution

The minimum delay across channels is emitted first as leading silence in chunks of at most 2048 samples. Each channel then keeps a ring holding its delay minus that minimum. Input frames keep their sample counts and are shifted by the leading silence. At end of input, the remaining maximum delay is flushed through the rings in chunks of at most 2048 samples. Output samples therefore equal input samples plus the largest channel delay.

`AudioFilterChain.packetSections` places a leading `{padding, 2048}` section and a trailing `{flush, 2048}` section around upstream sections. The CLI uses these for framecrc packet boundaries, output seek/duration and `-frames:a`, in the same way it does for apad. Silence is `0x80` for u8 and zero bytes otherwise.

Like native, adelay negotiates the planar form of the current precision (`u8p`/`s16p`/`s32p`/`fltp`/`dblp`), so `resolvedSampleFormat` reports a planar format. Packed input is repacked losslessly, and every output frame owns new storage. A fixed-precision `volume` on floating input that shares a format-merge component with adelay negotiates s32 (native picks `s32p`) instead of the encoder format. The same case with an integer `aformat` constraint after it fails explicitly.

Planning needs the channel count (`AudioCountOptions.channels`, the fifth `packetSections` argument), because the number of values read depends on it. Planning without it fails explicitly. `planSamples().buffers` reports the first leading-silence chunk and the longest ring (the flush length), not each ring. The CLI multiplies the largest buffer by the channel count and widest sample size and rejects it above `maxBufferBytes` with `resource-budget`. This bounds the rings' total. `delayAudio` also enforces `maxFrameBytes` for the total ring bytes and for each output frame.

For empty input, a configured format yields leading silence and then the flush. Native emits NOPTS/near-INT64_MIN timestamps here that the native CLI encoder happens to make contiguous. Edge emits contiguous timestamps directly and matches the resulting native framecrc.

## Unsupported

These fail explicitly: automatic sample-rate conversion combined with adelay (`-ar` different from the filter rate), the fixed-volume/integer-aformat case above and stateless `apply()`. Timeline `enable` is refused as an unsupported adelay option. Runtime commands fail because the command filters (such as `asendcmd`) are not implemented. Native accepts both, and only scratch probes cover them, with no committed test. FLAC input with `-ss`/`-t`/`-to` is refused before output by the timed FLAC filter check (`unsupported-command`, "Combined FLAC time selection and filters/rate conversion require additional Native packet scheduling"). FLAC rate conversion fails before output with the same adelay sample-rate-conversion error as the PCM paths. `compileFlacAudioFilters(...).plan()` fails because it passes no channel count.

Untimed FLAC CLI input without rate conversion, including `-ac` channel conversion, runs adelay through `processFlacAudioFilters` (adelay declares `flacInput`). The FLAC two-pass transform does not call that planner. `tests/differential/flac-adelay.test.ts` compares this path with native byte for byte: adelay alone and composed, 1-3 channels, 16 and 24 bits, s16le/s32le/WAV/framecrc output, and `-ac 1`/`-ac 2`. Since registry correction 1 ([audio filter registry](audio-filter-registry.md#intentional-corrections)), the helper reserves adelay's output frame plus its exact ring bytes before any allocation. A ring larger than one frame allocation fails with `FLAC filter buffer exceeds allocation limit`.

`maxBufferedSamples` does not include adelay, because its rings depend on rate and channels; use `planSamples().buffers`.

## Evidence

`tests/differential/adelay.test.ts` runs the pinned native binary (`.build/reference/ffmpeg`, macOS arm64) and compares output byte for byte:

- 540 framecrc cases: u8/s16/s32/f32/f64 sources, 1–3 channels, native and s16 targets, 20 chains including FIFO, apad, fixed/double volume, asetrate, planar aformat, nested and pass-through adelay.
- 192 input/output seek, duration and frame-limit cases.
- 48 empty-input cases.
- 60 whole-file WAV/AIFF/raw outputs from raw and WAV inputs.
- 98 rounding and suffix cases at five rates, including the 1523 s case and unread tokens.
- 36 cases at 128/512-byte I/O budgets.
- 48 mono/stereo conversion cases under the pinned rematrix arithmetic profile.
- 18 explicit-failure checks before output: 7 forms or combinations native rejects too and 11 native-valid forms or combinations, with native status asserted for each.

`tests/unit/adelay.test.ts` covers parsing, float32 resolution, planning, negotiation, ring output against a naive shift for packed/planar formats across ring wraps, ownership, limits and cancellation.

Not verified: s24/companded sources, AU output, untimed FLAC input, canonical Linux x86_64 reference, local workerd and production Workers. The timed FLAC refusal is covered by `tests/integration/flac-timed-filters.test.ts` and `tests/workers/flac-timed-filters.test.ts`.
