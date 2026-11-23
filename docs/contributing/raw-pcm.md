# Partial raw PCM input/output

`@edge-ffmpeg/containers` now exports openRawPcm, muxRawPcm, rawPcmCodec and their parameter/info types. Supported finite headerless formats include the twenty [PCM representations](pcm-representations.md). Raw data has no stored sample rate, channel count or timestamps: declarations are authoritative.

openRawPcm takes a ReadHandle and explicit codec/channels/rate/read-budget parameters. It reads nothing until packets are requested, assembles short reads, emits complete sample frames, supports exact bigint sample seeking and bounds each physical read/packet. Metadata is immutable. Default channel masks for tested multichannel counts follow the pinned native layout guesses; masks can be explicitly supplied through the programmatic API. Arbitrary layout declarations/CLI -ch_layout are not implemented.

muxRawPcm writes only sample bytes, without headers or padding. The supplied sample count, stream-zero timestamps and frame alignment must agree. Writes are awaited sequentially; commit occurs only after byte-count validation. Failure/cancellation calls abort. As with WAV, an externally uncertain commit requires adapter-specific recovery rather than an assumption of rollback. Empty finite streams are valid.

## CLI execution and defaults

Use createMediaBackend() from avformat. createWavBackend remains a backward-compatible alias to the expanded backend.

```sh
# Interpret raw input as stereo 48 kHz signed 16-bit PCM, then encode WAV.
npm run ffmpeg -- --root ./media -- -f s16le -ar 48000 -ac 2 -i /input.pcm /output.wav

# Decode WAV and write headerless float32 PCM. The raw output format selects its default codec.
npm run ffmpeg -- --root ./media -- -i /input.wav -f f32le /output.pcm
```

Raw input requires explicit -f. Its CLI defaults are 44100 Hz and one channel when -ar/-ac are omitted. WAV input continues to probe its header; overriding WAV input rate/channels is unsupported. Numeric rate/channel declarations currently accept positive decimal integers, not the complete native numeric-expression syntax.

WAV output now defaults to pcm_s16le when no codec is supplied. Each raw output format defaults to its matching PCM codec. Explicit -c copy preserves input bytes, but the selected codec must match a raw mux format; mismatches fail before output creation, matching the native raw muxer's restriction. Copy/filter combinations remain invalid.

Output rate/channel options can validate unchanged values. Output -ac also supports the documented [mono/stereo remix](channel-remix.md). Actual sample-rate conversion supports the scoped [default FIR path](resampling.md); other processing profiles and general multichannel remix remain incomplete. Float-to-integer/default-WAV encoding still requires -cpuflags 0 within the documented scalar value profile. Explicit raw output -f is required; native filename-extension inference is not fully implemented.

The existing scoped PCM timing model applies to raw input/output because the measured native default PCM packet spans agree. Input seek at/beyond EOF remains explicitly unsupported by the backend. The programmatic reader itself permits exact sample-EOF seeks, independent of native CLI I/O fallback quirks.

## Scope and evidence

Known-size, complete, interleaved little-endian/unsigned-byte PCM only. Planar data, unsupported PCM representations, unknown-length/live input, arbitrary timestamp gaps, unaligned trailing bytes, general probing and full native error compatibility remain incomplete. Malformed partial sample frames are rejected before output instead of being silently dropped.

Tests cover six raw source formats by six raw output formats, raw-to-WAV default encoding, WAV-to-raw output, copy identity, default rate/channels, channel metadata for 1/2/3/4/5/6/7/8/9/16 channels, unchanged output declarations and scoped timing at 10/8000 Hz against the pinned reference. Programmatic tests exercise short reads, bigint offsets beyond number precision, budgets, EOF, invalid timestamps and abort cleanup. workerd reads raw PCM from R2, filters it and commits headerless float output through staged R2 storage.

Per-operation limits are not total resident-memory/CPU enforcement. The full FFmpeg compatibility target remains unchanged; these formats and CLI paths are reported as partial.

Companded G.711 uses one code byte per channel/sample; see [codec and interoperability evidence](g711.md).
