# SoX native container scope

`packages/containers/src/sox.ts` ports the SoX native intermediate format from `libavformat/soxdec.c`, `soxenc.c`, `sox.h` and the `pcm.c` packet path (pinned FFmpeg 946fcce0, see `packages/containers/NOTICE-SOX`). It is registered as `sox` by one line in `packages/containers/src/registry.ts`, and exports `openSox`, `probeSox`, `muxSox`, `validateSoxOutput`, `supportsSoxCodec`, `SoxError` and the `sox` descriptor. It is not re-exported from the package barrel; tests import it by path or reach it through `containerFormat('sox')`.

## Demux

- **Detection.** The probe head matches `.SoX` (little-endian, pcm_s32le) or `XoS.` (big-endian, pcm_s32be), with precedence 100. `confirm` mirrors `sox_probe`: it reads at most 28 bytes, zero-pads a shorter file as the probe buffer is, and requires nonzero words at offsets 4 (header size) and 24 (channels). A file that fails it is undetected, so the backend reports `Unsupported audio container signature` (exit 1), where native reports `Invalid data found` (exit 183). `-f sox` skips the probe.
- **Header.** The 32-byte fixed header is read in pieces of at most `maxReadBytes`, with the signal checked around each await. The fields are header size (u32), sample count (u64, ignored as natively), rate (f64), channels (read as a signed 32-bit value) and comment size (u32). Native's checks run in native order and fail with `containerRefusal(..., 183)`, matching native `AVERROR_INVALIDDATA`:
  - comment size above `0xFFFFFFFF - 32`;
  - rate not in (0, INT_MAX], including NaN and infinity;
  - `(header_size + 4) % 8 != 0` (u32 wrap), `header_size < 28 + comment_size`, or channels outside 1..65535.
- **Rate.** A fractional rate is truncated, as native does (8000.75 Hz becomes 8000 Hz). A rate that truncates to 0 (for example 0.5 Hz) is refused with exit 234, the status native's decoder returns for a zero rate.
- **Payload.** The padding between byte 32 and `4 + header_size` is skipped without reads. The payload runs to EOF and goes through `openRawPcm` with a null channel mask, so the backend's `-guess_layout_max` rules choose the layout as native does for an unspecified layout. Packets use the default PCM packet span. Seeks, packet budgets and timestamps match the raw PCM path.
- **Explicit refusals** for inputs that native accepts but this module does not mirror:
  - a comment (comment size > 0): native exports it as `comment` metadata, which the WAV muxer writes as ICMT even with `+bitexact`;
  - a header shorter than 32 bytes, where native reads zeros past EOF;
  - a header size reaching past EOF;
  - a partial trailing sample frame, where native's decoder drops the remainder with an error;
  - a magic other than `.SoX`/`XoS.` under `-f sox`, which native parses as big-endian.

Because comments are refused, `info.metadata` is never set.

## Mux

- The default codec is pcm_s32le, and `-c:a pcm_s32be` writes the `XoS.` big-endian form. Any other codec is refused with exit 234 (native `EINVAL` from `sox_write_header`) before the output is created. Native creates an empty file first.
- The header is the fixed 32 bytes with comment size 0. The sample-count field holds `samples * channels`, which is what native's seekable trailer patches in (`(file_size - header_size - 4) >> 2`). It is written up front from the known sample count, and the payload is passed through `muxRawPcm`, so the output aborts exactly once on failure. The header is written in chunks of at most `maxWriteBytes`.
- `dropsMetadata` is not set, because native writes a `comment` tag into the header. Inputs whose demuxer exports metadata are therefore refused by the backend before output. The tests use only metadata-free inputs.
- The `.sox` extension selects the muxer.

## Evidence

All runs used the Linux x86_64 oracle built in this sandbox (`.build/reference/ffmpeg`, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`).

- `tests/differential/sox.test.ts` (4 tests):
  - **Mux.** 288 files are compared byte for byte with native writing to a seekable file: {pcm_s32le, pcm_s32be} × channels {1, 2, 3, 6} × rates {8000, 44100, 96000} × lengths {0, 1, 67, 4097}, from raw s16le, s32le and f32le, with `-cpuflags 0` for f32le.
  - **Demux.** 190 byte-exact comparisons. The inputs are native-written files (both codecs, 1, 2, 3 and 6 channels, 4300 frames), each auto-detected and also declared with `-f sox`. The profiles are:
    - `-c:a copy` framecrc and decoded framecrc;
    - input and output `-ss`/`-t` (with copy);
    - `-ss 0.25 -t 0.1`;
    - `-frames:a 2`;
    - `-af volume=0.5`;
    - `-guess_layout_max 0` and `2`;
    - WAV, AIFF (1 and 2 channels) and s16le decode;
    - `-ss 0.5` with volume.

    Hand-built files with header padding (header size 60 and 124) and fractional rates add framecrc and s16le comparisons.
  - **Malformed.** 13 native-invalid headers, each auto-detected and declared, match native's exit status (183), except the zero-channel file, which is undetected in both. The headers have bad alignment (both byte orders), header size below 28, 0, 65536 and negative channel counts, NaN, negative, zero, infinite and above-INT_MAX rates, an overflowing comment size, and a comment larger than the header. Five native-accepted cases are refused explicitly with no output: a comment, a 0.5 Hz rate (exit 234 as native), a truncated header, a header past EOF and a partial frame. Four muxer codec refusals match native's exit 234 without creating an output.
  - **FATE `lavf-sox`.** `tests/audiogen.c` is compiled at test time, and Edge's output matches the reference md5 `683635d5cb1344e44fa96df90c3a993c` and size 176432 exactly. It is byte-identical to native running the FATE command, and native's crc of it is `0x3a1da17e`, as in `tests/ref/lavf/sox`. A copy-framecrc decode also matches.
- `tests/unit/sox.test.ts` (6 tests):
  - both byte orders and header padding parse without payload or padding reads;
  - frame seeks;
  - probe words and zero padding;
  - every refusal and its status;
  - a header round trip within a 128-byte read budget (one 32-byte read);
  - chunked header writes;
  - abort-once and cancellation;
  - the descriptor fields.

## Unsupported

- SoX comments, both in and out. Output comments would need metadata to reach muxers (a contract change).
- AIFF output from 3 or more SoX channels. Native writes a CHAN layout tag for the guessed layout and the shared AIFF muxer does not. Raw PCM input diverges the same way. The output is not refused, and the tests exclude it.
- Channel conversion other than mono/stereo, which the backend refuses.
- Non-seekable or pipe output, where native leaves the sample count 0.
- Unknown-length (checkpointed) output, FLAC input to the SoX muxer, Workers and R2 runs, and macOS reproducibility. None of these were run.
