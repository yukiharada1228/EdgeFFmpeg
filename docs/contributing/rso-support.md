# Lego Mindstorms RSO support

`packages/containers/src/rso.ts` ports `libavformat/rsodec.c`, `rsoenc.c`, `rso.c` and the `pcm.c` packet and seek helpers (pinned FFmpeg 946fcce0, see `packages/containers/NOTICE-RSO`). It is registered as `rso` with one line in `packages/containers/src/registry.ts`.

## Scope

Demux (`openRso`, `-f rso` or an undeclared `*.rso` input):

- The 8-byte big-endian header: codec tag, data size, sample rate and play mode. The header is read in requests of at most `maxReadBytes`, with the signal checked around every await.
- Only tag `0x0100` (pcm_u8, mono, block align 1) is accepted. Tag `0x0101` (adpcm_ima_wav) fails with `ADPCM in RSO is not implemented`, and any other tag with `Unsupported RSO codec tag`. Both carry native's `AVERROR_PATCHWELCOME` exit status, 176.
- The header size is informational. As in native `ff_pcm_read_packet`, the payload runs from byte 8 to EOF, so `durationSamples` is the physical byte count. The header value is kept as `info.declaredDataBytes`.
- Native has no `read_probe`. Detection uses the registry's `demux.extensions:['.rso']` hook: an undeclared input is detected only when its path ends in `.rso` (case-insensitive). Any other undeclared path fails with `Unsupported audio container signature`.
- Packets, seeks and packet spans come from `openRawPcm` and the default `pcmPacketSpan(rate)`, which equals native `ff_pcm_default_packet_size` for pcm_u8 mono (`1 << av_log2(rate / 10)`, at least 1).

Mux (`muxRso`, `-f rso` or a `.rso` output path):

- The default codec is pcm_u8. Any other codec is refused with `RSO muxer does not support <codec>` and exit 183, as native's `rso_write_header` returns `AVERROR_INVALIDDATA` for a codec with no RSO tag.
- Mono only (`RSO only supports mono`) and a rate below 65536 (`Sample rate must be < 65536`), both with exit 183. These are checked in native's order (codec tag, channels, rate), and every refusal is thrown from `supports`/`refuse` or `validate`, before the output exists.
- The size field is written up front from the known sample count as `min(dataBytes, 0xffff)`. This is what native's `rso_write_trailer` writes on a seekable output, including its path for outputs over 64 KiB, which warns and writes 0xffff.
- The header goes out in chunks of at most `maxWriteBytes`. The payload goes to `muxRawPcm` through a wrapping writer, so the output is aborted exactly once on any failure.
- `dropsMetadata` is set, because `rso_write_header` writes no tags.

## Evidence

The pinned Linux x86_64 oracle (`.build/reference/ffmpeg`, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`) is run at test time. All inputs are synthesized by the tests.

- `tests/differential/rso.test.ts`:
  - Mux bytes for rates 8000, 11025 and 65535 and lengths of 0, 1, 4097, 65535, 65536 and 70000 bytes, from both raw u8 and WAV s16le inputs. That gives 36 byte-exact comparisons against native writing to a seekable file, and each native header is checked against `min(length, 0xffff)`.
  - Refusals with native exit 183 and no Edge output file: rates 65536 and 70000, stereo, `-c:a pcm_s16le` (to a `.rso` path and with `-f rso` to a `.dat` path).
  - Demux of three native-written files and five synthetic files whose header size is 0, 100, 0xffff or 3000 over 3000 data bytes, or 5000 over 4097 data bytes. Each goes through copy framecrc, WAV decode (native writing to a file) and pcm_s16le framecrc, with no seek, input `-ss`, input `-ss` with `-t`, output `-ss`/`-t` and `-frames:a 2`, undeclared and with `-f rso`. That gives 114 byte-exact comparisons.
  - Extension detection: `*.rso` undeclared and `-f rso` on a `.dat` path both match native. An undeclared `.dat` fails on both sides. Tags 0x0101, 0x0200 and 0 fail with exit 176 on both sides.
- `tests/unit/rso.test.ts` covers header parsing, one-byte bounded header reads, packet seeks, the open refusals and their statuses, the validate order and statuses, the `min(samples, 0xffff)` size field, chunked header writes, abort-once on bad packets, budgets, cancellation and refusals, and the descriptor and registry fields, including the extension-only detection reads.

## Unsupported

- adpcm_ima_wav (tag 0x0101) input or output, and unknown tags: refused with exit 176 on input. ADPCM output is not reachable, because `PcmCodec` has no ADPCM codec.
- Headers shorter than 8 bytes are refused with `Truncated RSO header`, and sample rate 0 with `RSO sample rate 0 is not implemented`. Native's own failures for these (it reads zeros past EOF, then fails opening the decoder) are not mirrored, and their exit statuses differ.
- Input `-ss` at or beyond EOF is refused as unimplemented (no `seekBeyondEnd`).
- Non-seekable or pipe output. Native refuses it; the Edge backend always writes a known-size file.
- FLAC input to the RSO muxer: the FLAC output dispatcher does not iterate the registry.
- Input stream duration: native sets `st->duration` from the header size. No compared output depends on it, and Edge uses the physical length.
