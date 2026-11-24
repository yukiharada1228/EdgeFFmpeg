# NIST SPHERE demuxer scope

`packages/containers/src/nistsphere.ts` registers the demux-only `nistsphere` container (`export {nistsphere} from './nistsphere.js';` in `registry.ts`). It exports `openNistSphere`, `probeNistSphere`, `readNistSphereHeader`, `nistSphereCodec`, the sscanf helpers `scanNistInteger`, `scanNistWord` and `isNistMetadata`, and `NistSphereError`. They are reached by module path or `containerFormat('nistsphere')`; there is no barrel export. There is no muxer, as native has none.

## Detection

`head` matches `NIST` and `confirm` reads exactly the eight bytes native `nist_probe` compares (`NIST_1A\n`), with reads of at most `maxReadBytes`. Precedence is 100 (exact magic). `-f nistsphere` skips detection and, like native, does not check the first line. The `.sph` and `.nist` extensions are not used: native has `read_probe`, so an extension only scores 1, and input without the magic is not detected.

## Header

The module ports `ff_get_line` over a sequential reader (chunks of at most `min(256, maxReadBytes)` bytes, signal checked around every read). A line ends at LF, CR (a following LF is swallowed, otherwise the reader steps back one byte unless at EOF), NUL or EOF. A line with more than 255 content bytes is refused, where native would truncate it. Header scanning stops after 65536 bytes (an EdgeFFmpeg limit; native has none), so `headerBytes` is 512.

Line 2 is `header_size` (`sscanf %d`; missing or non-positive is exit 183). Keys are matched by prefix in native order: `end_head`, `channel_count` (1..32767, else 183), `sample_byte_format` (`01` LE, `10` BE, `1` unchanged, `mu-law` selects mu-law, anything else 176), `sample_coding`, `sample_count`, `sample_n_bytes` (0..4095, else 183), `sample_rate` and `sample_sig_bits` (1..32767, else 183). Values follow sscanf semantics: two skipped tokens, then a signed decimal prefix (`2abc` is 2, `+16000` is 16000), words truncated to 31 bytes, and a missing value keeps the previous one. Integers longer than 9 digits (18 for `sample_count`) are refused rather than emulating overflow. Every line must end before `header_size` (else 183), and a header without `end_head` is exit 187, both checked as native does after each line. Data starts at `header_size` and runs to EOF.

The codec is `ff_get_pcm_codec_id(sig_bits || n_bytes*8, 0, be, 0xFFFF)` for `pcm` (case-insensitive): pcm_s8, pcm_s16le/be, pcm_s24le/be or pcm_s32le/be; `alaw` gives pcm_alaw, `ulaw`/`mu-law` give pcm_mulaw. Any other line with at least a key, a skipped token and a value (native's `"%31s %*s %31s" == 2`) becomes native global metadata, and the opened info sets `metadata:true`. The PCM path then refuses WAV, AIFF and AU output ("Input metadata for the WAV muxer is not implemented") and accepts raw, framecrc and W64, which write no tags. `sample_count` is kept as `info.sampleCount` (duration only); the physical data length decides `durationSamples`.

## Refused explicitly (native accepts)

Before output creation, with exit 1:

- bit depths that are not a multiple of 8 (`sample_sig_bits 12`), 0-bit, 5-7 byte and 64-bit PCM;
- A-law or mu-law with anything other than 8 bits per sample;
- `pcm,embedded-shorten` and every other coding;
- missing or zero `sample_rate` or `channel_count` (native fails later for the rate);
- `header_size` past EOF, and data that is not a whole number of frames;
- header lines longer than 255 bytes and headers longer than 65536 bytes;
- input `-ss` when `sample_count` is present and differs from the physical sample count (not probed); `-t` and frame limits with a mismatched count are compared and match.

Native exit statuses for these are recorded in the differential test (0 for all, except 234 for a missing rate).

## Evidence

On the pinned Linux x86_64 oracle built in this sandbox (`.build/reference/ffmpeg`, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`), inputs synthesized in the tests:

- `tests/differential/nistsphere.test.ts`
  - Matrix of 4 codings x 3 byte formats x 4 widths x 1/3 channels x 8000/44100 Hz. 84 accepted files are each compared byte for byte with native in copy framecrc, copy raw, `-cpuflags 0` decoded WAV and decoded f32le (336 comparisons). 108 companded files with widths over one byte are refused.
  - Timing: three files (`sample_count` exact, absent, mismatched), five profiles (none, input and output seek with duration, `-frames:a 2`, input seek with duration, `-t`), copy and a fixed-volume/asetnsamples chain, framecrc, WAV and s16le output: 78 byte comparisons, and 12 refusals of input seek with a mismatched count.
  - Text edges: CRLF, CR, small and minimal `header_size`, blank lines, uppercase coding, `sample_sig_bits` 16 and 24, tabs and trailing garbage, mu-law byte format, `-f nistsphere` with a non-magic first line, a NUL line, a 254-byte line and metadata keys. Each is compared in copy framecrc, copy raw, WAV and W64 (55 comparisons); WAV with metadata is refused. 11 native refusals (no `end_head`, `end_head` at or past `header_size`, `header_size` 0, channel and width bounds, unknown byte format, a missing channel value) give the same exit status (183, 176, 187) with no output. 8 scope refusals record native's status.
- `tests/unit/nistsphere.test.ts`: the sscanf helpers, the line reader (LF, CR, CRLF, NUL, the 255-byte limit), key parsing and codec selection, native statuses, bounded reads, packets and seeks, refusals, the probe and the descriptor fields, and abort.

## Unsupported

Shorten-coded and other non-PCM SPHERE files, 12-bit and other non-byte widths, files without the magic (extension detection), metadata propagation to WAV/AIFF/AU tags, FLAC input paths, workerd runs and macOS reproduction.
