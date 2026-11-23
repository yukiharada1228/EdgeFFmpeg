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

Seconds and milliseconds follow `config_input`: the value is parsed as float32, `delay * sample_rate / div` is evaluated in float32, and the result is truncated toward zero. For example, 110.839 ms at 11025 Hz gives 1222 samples (the exact value is 1221.4), and 1523 s at 11025 Hz gives 16791076 samples. The sample rate is the rate at adelay's position in the chain, so a preceding `asetrate` applies. Decimals that land exactly on a float32 rounding midpoint in double precision are rejected rather than approximated.

Channels without a value are not delayed. `all=1` copies the last value that was read to the remaining channels. As in native, values beyond the channel count are never parsed, so `adelay=5S|abc` is valid for mono input.

Explicit failures:

- Native rejects these too: negative values, unparsable text, and boolean values other than `0`, `1`, `false` and `true`.
- Native accepts these, but they are unimplemented and fail with an `adelay` diagnostic before output is created: signs (`+5S`, `-0`), exponents, hexadecimal, `nan`/`inf`, trailing text such as `5ms`, whitespace, escaping, positional options after named ones, other boolean spellings, and runtime commands.

## Execution

The minimum delay across channels is emitted first as leading silence in chunks of at most 2048 samples. Each channel then keeps a ring holding its delay minus that minimum. Input frames keep their sample counts and are shifted by the leading silence. At end of input, the remaining maximum delay is flushed through the rings in chunks of at most 2048 samples. Output samples therefore equal input samples plus the largest channel delay.

`AudioFilterChain.packetSections` places a leading `{padding, 2048}` section and a trailing `{flush, 2048}` section around upstream sections. The CLI uses these for framecrc packet boundaries, output seek/duration and `-frames:a`, in the same way it does for apad. Silence is `0x80` for u8 and zero bytes otherwise.

Like native, adelay negotiates the planar form of the current precision (`u8p`/`s16p`/`s32p`/`fltp`/`dblp`), so `resolvedSampleFormat` reports a planar format. Packed input is repacked losslessly, and every output frame owns new storage. A fixed-precision `volume` on floating input that shares a format-merge component with adelay negotiates s32 (native picks `s32p`) instead of the encoder format. The same case with an integer `aformat` constraint after it fails explicitly.

Planning needs the channel count (`AudioCountOptions.channels`, the fifth `packetSections` argument), because the number of values read depends on it. Planning without it fails explicitly. Each ring is reported as a buffer requirement, and the CLI rejects rings above `maxBufferBytes` with `resource-budget`. `delayAudio` also enforces `maxFrameBytes` for the total ring bytes and for each output frame.

For empty input, a configured format yields leading silence and then the flush. Native emits NOPTS/near-INT64_MIN timestamps here that the native CLI encoder happens to make contiguous. Edge emits contiguous timestamps directly and matches the resulting native framecrc.

## Unsupported

These fail explicitly: automatic sample-rate conversion combined with adelay (`-ar` different from the filter rate), the fixed-volume/integer-aformat case above, FLAC CLI paths (their planner does not pass a channel count), stateless `apply()`, commands and timeline `enable`.

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
- 18 explicit-failure checks.

`tests/unit/adelay.test.ts` covers parsing, float32 resolution, planning, negotiation, ring output against a naive shift for packed/planar formats across ring wraps, ownership, limits and cancellation.

Not verified: s24/companded sources, AU output, canonical Linux x86_64 reference, local workerd and production Workers.
