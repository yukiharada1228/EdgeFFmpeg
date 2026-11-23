# Packed PCM representations

The codec and raw-container registries support twenty representations:

| Wire formats | Internal packed frame |
|---|---|
| u8, s8 | u8 (s8 sign bias is converted) |
| s16le/be, u16le/be | little-endian s16 |
| s24le/be, u24le/be | little-endian s32, left-justified with eight zero low bits |
| s32le/be, u32le/be | little-endian s32 |
| f32le/be | little-endian flt |
| f64le/be | little-endian dbl |
| alaw, mulaw | little-endian s16 reconstruction |

Signed8 and unsigned wider words toggle the sign-bit bias at the wire boundary.
Endian conversion copies bytes without interpreting floating values, preserving
same-precision NaN payloads, infinity and signed zero. Integer depth reduction
retains the documented truncation semantics; numeric sample-format conversions
still follow the finite scalar profile. G.711 companding remains lossy.

`decodePcm` and `encodePcm` operate on independently owned buffers and preserve
bigint sample timestamps. `getPcmFormat` describes wire and decoded sample widths;
`isPcmCodec` validates supported IDs. The frontend sizes reads for decoded
expansion, conversion widths and conservative aggregate reservations.

Raw formats require explicit `-f` and inherit the existing declaration, timing,
frame-count, filter and staged-output behavior. For example:

```sh
npm run ffmpeg -- --root ./media -- -f u24be -ar 8000 -ac 1 -i /input.raw -f s16be /output.raw
```

WAV output retains its eight supported linear/G.711 encodings. Signed8, unsigned
16/24/32 and big-endian codec requests are rejected before output creation;
select a supported WAV codec or a matching raw output format. `supportsWavCodec`
and the narrower WavPcmCodec type expose that container boundary. Raw input in
any supported representation can still be converted to default pcm_s16le WAV.

Evidence covers a 20-by-20 raw conversion matrix, plus copy/stateful filtered
framecrc timing for all twelve newly added formats. Complete signed16 input
values are compared for signed8/unsigned16 encoding, all signed8/unsigned16
codewords for decoding, and special floating payloads for endian conversion.
Workerd exercises unsigned24 expansion and endian/bias conversion through the
CLI. These fixtures do not certify every numeric conversion, error case or
runtime. Planar formats, signed64, extra PCM encodings, resampling and general
container support remain incomplete.
