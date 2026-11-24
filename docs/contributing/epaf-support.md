# Ensoniq PARIS (epaf) demuxer scope

`packages/containers/src/epaf.ts` ports `epaf_probe` and `epaf_read_header` from `libavformat/epafdec.c` and registers a demux-only `epaf` descriptor (one line in `packages/containers/src/registry.ts`). Native has no EPAF muxer, so `-f epaf` output is refused like any other demux-only format. The module exports `openEpaf`, `probeEpaf`, `EpafError` and the `epaf` descriptor; it is not re-exported from the package barrel, and tests import it by path.

## Detection

The probe head accepts `'fap '` or `' paf'`. `confirm` then reads the same 24 bytes `epaf_probe` inspects and requires, as native does: little-endian word 1 at byte 8 for `'fap '` or word 0 for `' paf'`, a zero word at 4 and non-zero words at 12 (rate) and 20 (channels). The codec word is not inspected, so codec 1 files are detected and then refused by the header check, exactly as natively. Precedence is 100: no other registered head matches these magics. Native also matches the `.paf` and `.fap` extensions, but only with score 1, which never selects a file whose probe failed; no `demux.extensions` are declared.

## Header

`openEpaf` makes bounded reads (at most `maxReadBytes` each, signal checked around every await) of bytes 0..23 only, and never reads the 2024 skipped bytes or the payload while opening. The checks follow `epaf_read_header` in order, and every refusal carries native's `AVERROR_INVALIDDATA` exit status 183 (`containerRefusal(message,183)`):

- a file shorter than 2048 bytes (native reads zero words past EOF and its `avio_skip(2024)` fails);
- a non-zero word at 4, or a byte-order word at 8 other than 0 or 1 (with `-f epaf` the magic itself is not checked, as natively);
- channels outside 1..512 (`FF_SANE_NB_CHANNELS`) or a sample rate of 0 or below, read as signed 32-bit values in the file's byte order;
- codec 1 (24-bit, `avpriv_request_sample` natively) and any codec other than 0 and 2.

Codec 0 maps to `pcm_s16le` for `'fap '`-style little-endian files and `pcm_s16be` for big-endian ones, and codec 2 to `pcm_s8`. The channel layout is left unspecified (`channelMask:null`), so the shared PCM path guesses it under `-guess_layout_max` as native does. PCM runs from byte 2048 to EOF through `openRawPcm`, with the default PCM packet span, so seeks, packet budgets and timestamps match the other PCM inputs. A payload that is not a whole number of sample frames is refused (`Partial trailing EPAF sample frame is not implemented`, exit 1) before any output exists; native decodes it with an invalid-packet decoder error and exits 0.

## Evidence

Linux x86_64 native oracle `.build/reference/ffmpeg` (FFmpeg 9.0.2, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`), inputs synthesized in the tests:

- `tests/differential/epaf.test.ts` (4 tests, 279 native comparisons):
  - 204 byte-for-byte outputs: LE and BE files x codecs 0 and 2 x 1, 2 and 6 channels x 8000, 44100 and 96000 Hz, with odd frame counts (1031 or 4097), each as copy framecrc (detected and `-f epaf`), WAV, AIFF (1 and 2 channels only, see below), raw copy and s16le decode;
  - 40 framecrc timings: four LE/BE codec files with input/output `-ss`/`-t`, `-t`, `-frames:a 2` and input `-ss` profiles, copy and a fixed-volume/asetnsamples chain;
  - 17 outputs for 6 unlabelled channels under default, `-guess_layout_max 2` and `-guess_layout_max 0` (WAV, W64, AU, copy and decoded framecrc, plus AIFF where nothing is guessed);
  - 2 zero-sample outputs and 16 refusal exit codes (codec 1, codec 3, 0 and 513 channels, negative rate, 1000-byte and 23-byte truncated headers, each detected and with `-f epaf`; plus the partial trailing frame, which native accepts and the module refuses). Every refusal leaves no output file.
- `tests/unit/epaf.test.ts` (6 tests): header parsing for both byte orders and both codecs, read offsets and lengths, packet seeks, the 24-byte probe, every refusal and its status, read-budget and abort handling, the descriptor fields and backend refusals before output creation.

## Unsupported

- Codec 1 (24-bit PARIS PCM) and other codecs: refused, as natively.
- Partial trailing frames: refused, where native decodes with an error and exits 0.
- AIFF output of a guessed multichannel layout (3 or more channels without `-guess_layout_max` below the channel count): native writes a CHAN chunk with the guessed layout's tag (MPEG_5_1_A for 6 channels), but the shared PCM path passes no mask to the AIFF muxer, so the CHAN chunk is missing. This is not refused, because a demuxer cannot see the output format; it needs a shared change in `packages/avformat/src/index.ts` (guessed mask for AIFF and AU) and a channel-layout tag table in `packages/containers/src/aiff.ts`, which currently writes a channel bitmap where native writes a layout tag for any 5.1 input.
- Undetected inputs whose probe fails (zero channel word, files shorter than 24 bytes) report `Unsupported audio container signature` with exit 1 from the shared detector, where native reports INVALIDDATA (183).
- Workers, R2 and FLAC paths were not exercised; no workers or integration test was added.
