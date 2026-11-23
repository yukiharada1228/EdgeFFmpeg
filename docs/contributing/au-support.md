# AU container scope

`@edge-ffmpeg/containers` exports `openAu`, `muxAu`, `supportsAuCodec`, `validateAuOutput`, `AuError` and their types. The finite audio backend supports explicit `-f au`, automatic `.snd` signature detection and `.au`/`.snd` output extensions. The default encoder is pcm_s16be.

Supported encoding IDs are 1 (mu-law), 2/3/4/5 (signed 8/16/24/32 PCM), 6/7 (float32/64) and 27 (A-law). Multibyte samples are big endian. Header rates must be positive integers up to signed32 maximum; channels are bounded to 65535 and must fit the buffer budget. AU stores no explicit channel layout; existing CLI layout guessing applies. No channel mask is serialized.

Input requires a finite range handle. The 24-byte header is assembled through bounded reads. Annotation data between the header and sound offset is skipped by range, without an annotation-sized allocation. An unknown data size of 0xffffffff uses the physical remaining input length. Known declared lengths must exactly match it and sample frames must be complete. Native FFmpeg can accept mismatched declared lengths and read through EOF; this profile rejects them explicitly rather than claiming equivalent malformed-input behavior. Annotation text is not parsed or copied.

Output requires a known sample count and data length below 0xffffffff bytes. A 32-byte header, including eight zero annotation bytes, matches tested native bitexact seekable output. Known counts permit sequential writes without seeking or retaining the entire file. Raw PCM packet validation enforces sample alignment, contiguous timestamps and exact counts. The staged destination commits only after all bytes succeed; failure aborts once, including failed header or commit operations. Pipe-style unknown-length output headers are not emitted.

Native packet timing follows the existing PCM sample-rate-based packet span. Physical reads may be smaller without changing framecrc semantic packet boundaries. Tests compare copy, input/output seek, duration, frame limits, fixed volume, FIFO padding and asetrate; exact/beyond-EOF input seeks produce empty output in the tested AU profile.

Evidence includes 48 complete-file/metadata/decode cases (eight codecs, three rates, mono/stereo), 80 timing/filter cases, an unknown-length finite annotation fixture, malformed/header/resource unit checks and local workerd staged R2 roundtrip. Canonical Linux reproducibility and production Workers verification remain outstanding. ADPCM, arbitrary metadata, unknown-length/live media and full error/probe compatibility remain unimplemented.
