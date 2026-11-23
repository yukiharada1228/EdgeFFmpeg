# Partial WAV container support

`@edge-ffmpeg/containers` exports `openWav(ReadHandle, { maxReadBytes, maxChunks?, signal? })`. Opening scans bounded-size RIFF headers and skips payloads by offset. It does not preload the audio data. Iterating `packets(startSample?)` reads at most `maxReadBytes` per packet, aligned to complete interleaved sample frames. Callers must apply queue backpressure and account for retained packets.

Supported input is finite, little-endian RIFF/WAVE with one format and one data chunk. Integer PCM supports 8/16/24/32 bits; IEEE float supports 32/64 bits. Standard PCM subtypes in WAVE_FORMAT_EXTENSIBLE are recognized when valid bits equal container bits (or valid bits are unspecified). Channel masks are preserved as raw metadata; channel-layout interpretation is not implemented. Unknown chunks are skipped with even-byte padding. Duration, PTS, DTS and exact sample seeks use bigint sample counts and a 1/sampleRate time base.

Unsupported input includes RF64/BW64/RIFX, other compressed codecs, unknown streaming sizes, multiple data chunks, nonmatching valid/container bit depths and metadata extraction. Packet boundaries are determined by the configured read budget and are not claimed to match native FFmpeg packet boundaries. PCM decoding/encoding and the scoped CLI path are described in [PCM support](pcm-support.md) and [CLI execution](cli-execution.md); complete WAV compatibility is not claimed.

The parser bounds chunk traversal, rejects inconsistent sizes/alignment and checks cancellation between reads. These strict failures are not yet FFmpeg error-compatible. Per-read limits do not measure total JavaScript/Wasm resident memory; header copies, retained packet buffers, adapters and scheduler state require additional accounting.

Differential tests generate six stereo WAV encodings with the pinned reference build, compare ffprobe codec/rate/channels/duration, compare concatenated packet bytes to native stream-copy output and check exact sample seeking. Native packet timestamps are not compared packet-for-packet because packet sizes differ. A workerd test reads PCM WAV through the bounded R2 adapter. No production Cloudflare conformance is inferred.

Format references used for independent implementation:

- [Microsoft RIFF description](https://learn.microsoft.com/en-us/windows/win32/xaudio2/resource-interchange-file-format--riff-)
- [Microsoft WAVEFORMATEX](https://learn.microsoft.com/en-us/windows/win32/api/mmeapi/ns-mmeapi-waveformatex)

No FFmpeg source was translated into this reader; the pinned executable is the behavioral oracle.


## Finite PCM output

`muxWav(WriteHandle, format, packets, { sampleCount, maxWriteBytes, signal? })` writes RIFF/WAVE sequentially without seeking or buffering the complete file. The total sample count must be known. It supports the six linear PCM encodings and G.711 A-law/mu-law, emits extensible format metadata for larger/multichannel/masked samples, emits float/G.711 fact chunks and adds odd-byte RIFF padding. Output headers are independently constructed; binary identity with FFmpeg headers is not claimed.

Packets must belong to stream zero and describe contiguous, zero-based sample positions. Equivalent rational time bases are accepted. Data must consist of complete interleaved sample frames; declared duration, packet duration, PTS and DTS must agree with byte lengths. The mux awaits each write before requesting another input packet. Its own header allocation is small and fixed; the caller remains responsible for input-packet memory accounting.

The mux owns the output transaction: it commits only after all expected bytes have been written and calls abort on validation, input, write, commit or cancellation failure. If abort also fails, both errors are preserved. The WriteHandle implementation must stage writes until commit and define how an uncertain commit outcome is recovered; the mux cannot guarantee rollback after an externally visible commit. Cancellation is cooperative between awaited operations and does not interrupt an arbitrary in-flight WriteHandle call.

Unknown sample counts, RF64-size output, other compressed codecs, timestamp gaps/reordering, and metadata copying are not implemented. R2 output persistence is available through the opt-in [R2 adapter](r2-output.md). The workerd mux test uses a tiny collecting sink only for test fixtures; it is not the production storage strategy. Native differential tests read generated output through ffprobe/FFmpeg for all six encodings and compare stream information and raw PCM bytes.

[G.711 WAV](g711.md) also supports format tags 6/7, known fact counts and native interoperability. Full malformed fact semantics are unverified.
