# WVE (Psion 3 audio) demuxer scope

`packages/containers/src/wve.ts` ports `libavformat/wvedec.c` and is registered as the demux-only container `wve` (`export {wve} from './wve.js';` in `registry.ts`). Native FFmpeg 9.0.2 has no wve muxer, so `-f wve` is an input format only. The module exports `openWve`, `probeWve`, `matchesWve`, `WveError` and its types. See `packages/containers/NOTICE-WVE`.

## Scope

- **Detection.** The probe has precedence 100. Its head is the four bytes `ALaw`. Its confirmation reads at most the 32 bytes that `wve_probe` inspects: the 18-byte magic `ALawSoundFile**\0\017\020`, and bytes 22..31 equal to `00 00 00 01 00 00 00 00 00 00`. Bytes 18..21 are not checked. Like native's probe buffer, a file shorter than 32 bytes is zero padded for the probe.
- **Header.** The rb32 at offset 18 is native's `st->duration`. It is stored as `info.headerDuration` and has no other effect. The stream is `pcm_alaw`, 8000 Hz, mono, `block_align` 1, with no channel mask. Data runs from byte 32 to EOF, as native's `ff_pcm_read_packet` reads it. `wve_read_header` never checks the magic, so `-f wve` opens any 32-byte header, as native does.
- **Packets.** `openRawPcm` over the data range with the default PCM span (`pcmPacketSpan(8000)` = 512 samples, `ff_pcm_default_packet_size`). Decoding goes through the existing G.711 A-law table decoder.
- **Bounded reads.** Opening reads only the 32 header bytes, in reads of at most `maxReadBytes`, and checks the signal around every await. `demux.headerBytes` is 32.

## Refusals

- A header shorter than 32 bytes fails with `Truncated WVE header`. Native demuxes a 26..31-byte file that its zero-padded probe accepts, and it exits 0 (tested). Edge refuses it explicitly.
- Input `-ss` greater than zero fails with `WVE input seek with a header duration that differs from the data length is not implemented` when the header duration is not equal to the physical sample count. Native's `ff_pcm_read_seek` with a mismatched `st->duration` was not mirrored. When the duration is equal, input `-ss` is supported and tested. A seek at or beyond EOF is refused by the shared PCM path (`seekBeyondEnd` is not set).
- Undetected inputs (one magic byte altered, or a nonzero byte 22..31) fail explicitly with `Unsupported audio container signature`, and no output is created. Native fails with exit 183 (`AVERROR_INVALIDDATA`). Edge exits 1, because the shared `detect.ts` throws a plain `Error`. Fixing that status needs a shared edit outside this capability.

## Evidence

Native oracle: `.build/reference/ffmpeg` built on Linux x86_64 from pinned commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8 (sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`).

- `tests/differential/wve.test.ts` (3 tests). Inputs are synthesized in the test, and native runs at test time.
  - Data lengths {0, 1, 511, 512, 513, 3000, 8001} × header duration {equal, 100, 0, length+4000}. Each of the 28 files is compared byte for byte with native output for `-c:a copy -f framecrc`, decoded framecrc, s16le, WAV, AU and `-c:a copy -f alaw`: 168 comparisons.
  - Output `-ss`/`-t`, `-frames:a 2` and `-t 0.0641`, for lengths 513, 3000 and 8001 across all four durations, plus input `-ss 0.000125` and `-ss 0.1 -t 0.03` with an equal duration. Each runs as copy and as a fixed-volume decode to framecrc: 82 comparisons. `-f wve` over an altered magic and a nonzero byte 23 is also compared to s16le: 1 comparison.
  - Probe negatives: magic bytes 0, 5, 14, 15, 16 and 17, and fixed bytes 22, 23, 24, 25, 26 and 31. Native exits 183 and Edge fails with no output: 12 exit-code comparisons. Truncated 26- and 31-byte files: native exits 0, and Edge refuses them: 2 comparisons. The mismatched-duration input seek is refused before any output.
- `tests/unit/wve.test.ts` (6 tests): header parsing, the 32-byte header read under 64-, 7- and 1-byte budgets, probe bytes and the bytes it reads, refusals, abort before, during and after opening, and the descriptor fields.

## Unsupported

- A wve muxer, which native does not have.
- Truncated headers (under 32 bytes).
- Input `-ss` when the header duration differs from the data length.
- Native's exit status 183 for undetected input (Edge exits 1).
