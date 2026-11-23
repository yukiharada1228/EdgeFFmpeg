# Native AAC packet oracle

`node build-native.mjs` links the C probe to the fixed reference build's static
libavformat/libavcodec/libswresample/libavutil artifacts. It checks the upstream
commit/clean headers, reference executables, static-library hashes, compiler,
source and builder/verifier hashes, linked API versions and cached binary hash.
Each newly built binary must match ffprobe on12 standard owned AAC inputs.
`node verify-native.mjs .build/aac-native-probe/probe --all` verifies all1533
standard inputs across six existing corpora. The canonical generator requires
that full parity receipt and unchanged corpus/artifact hashes.

Pinned ffprobe unconditionally opens decoder contexts after stream discovery;
its AAC decoder rejects sampling_frequency_index15 even when the explicit
frequency equals a supported table frequency. Native ffmpeg streamcopy succeeds.
The C probe uses unmodified avformat_open_input/find_stream_info/read_frame,
without ffprobe's additional unconditional decoder open. Discovery may still
log decoder rejection; this does not turn into a decoding-conformance claim.

All64-bit timestamps,positions,durations and counts are emitted as decimal
strings or null. Raw packet SHA256 is calculated by the reference libavutil.
Copy comparisons omit container byte positions. The probe is a host-only test
oracle; production packages/Workers never execute or link FFmpeg.

Regenerate explicit-frequency fixtures with `node generate.mjs` from the repo
root. Descriptors and ancestor box sizes are rewritten, chunk offsets after
moov are adjusted, and all bounds/expected case counts are checked. Sources
include leading/multiple edits,faststart and v1 odd-tick timestamps beyond2^53.
