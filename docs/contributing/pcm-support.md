# Partial PCM codec support

`@edge-ffmpeg/avcodec` exports `decodePcm`, `encodePcm`, `PcmFormat`, `PcmOptions` and `PcmError`. The codec layer has no container or Runtime dependency. `PcmCodec` is a shared avutil type.

Supported packed codecs are pcm_u8, pcm_s16le, pcm_s24le, pcm_s32le, pcm_f32le and pcm_f64le, plus [G.711](g711.md) pcm_alaw/pcm_mulaw. Decoding produces packed AudioFrameData: u8, s16, s32, flt or dbl. Signed 24-bit samples expand into left-justified signed 32-bit samples; other linear formats are copied into owned frame buffers; G.711 expands to signed16. Encoding also produces owned buffers. Floating-point same-format processing copies payload bits without numerical interpretation. Cross-format operations follow the scalar rules documented separately.

Integer frames may be encoded into any of the four integer PCM depths. Unsigned 8-bit bias and signed expansion are handled explicitly. Reducing depth truncates low bits without dither. Sample-format conversion delegates to swresample, including integer/floating and floating precision changes within the [documented scalar scope](sample-format-conversion.md). Codec entry points do not resample or remix and do not accept planar input; the media backend composes the separate [mono/stereo remix](channel-remix.md) operator. Supported [endian/sign-bias representations](pcm-representations.md) are converted at codec boundaries. Channel layout may be supplied; without one, mono/stereo are inferred for one/two channels and other layouts are unspecified.

Every call requires an explicit maxFrameBytes. Alignment, packed plane length, channel/rate values and allocation sizes are checked before allocating the output. Cancellation is checked before work and periodically during integer sample loops. Ownership is independent of the input. Returned PCM packet timestamps use a sample time base and frame PTS rescaling. Codec delay, general buffering/flush behavior and complete FFmpeg native frame/error semantics remain unimplemented.

## WAV backend

The WAV backend now accepts explicit `-c:a pcm_u8`, pcm_s16le, pcm_s24le or pcm_s32le for integer PCM inputs, plus floating PCM and the scoped scalar sample-format conversions. It preserves channel count (except explicit mono/stereo remix), rate (except explicit asetrate), sample count (except padding/reframing) and the WAV channel mask. Output packets are bounded by the configured buffer size; the backend chooses smaller input packets to accommodate decoder expansion and larger output samples. Source packets, decoded frames and encoded packets can coexist, so per-buffer limits are not a total resident-memory measurement.

```sh
npm run ffmpeg -- --root ./media -- -n -i /input.wav -c:a pcm_u8 /output.wav
```

WAV defaults to pcm_s16le and raw output formats select matching default codecs; explicit copy/codec selection is also supported. Unpinned float-to-integer conversion fails before output creation; unsupported sample values detected later abort staged output. This sequential backend is not a general filter graph, sample-rate resampler or compressed audio engine.

## Evidence

Native differential tests cover all 16 integer source/target codec combinations, with deterministic raw PCM patterns including signed/bias boundaries. Both direct codec output and CLI-generated WAV output are compared to the pinned FFmpeg's raw output. Separate same-format float tests compare native output payload bits for both precisions. workerd tests exercise all six codec pairs and an R2-backed s16-to-u8 WAV conversion. These are partial implementation tests, not certification of every input or platform condition.

The [twenty-representation matrix](pcm-representations.md) extends the codec/raw path; WAV codec choices retain their separate container limits.
