# Sierra SOL demuxer scope

`packages/containers/src/sol.ts` ports `libavformat/sol.c` (`sol_probe`, `sol_codec_id`, `sol_channels`, `sol_read_header`, `sol_read_packet`) and relies on the shared raw PCM packet path for the PCM samples. It registers the demux-only `sol` descriptor with one line in `packages/containers/src/registry.ts`. Native has no SOL muxer, so there is no `-f sol` output. The module exports `openSol`, `solStream`, `isSolHead`, `SolError` and `sol`; it is reached through the registry (`containerFormat('sol')`), not the package barrel.

## Syntax

`ffmpeg [-f sol] -i in.sol [output options] out` for any PCM-path output (framecrc, wav, au, raw PCM, w64, hash muxers). Input `-ss` is refused (see below); output `-ss`, `-t` and `-frames:a` are supported.

## Demux

- Detection: undeclared input whose first six bytes are a magic (`AV_RL32` truncated to 16 bits: `0x0B8D`, `0x0C0D` or `0x0C8D`) followed by `SOL\0`. Probe precedence 100; `head` checks the magic and `SO` in bytes 0-3, `confirm` reads exactly six bytes. Native scores this `AVPROBE_SCORE_MAX`.
- Header, read in pieces of at most `maxReadBytes` with the signal checked around each read: u16le magic, the `SOL\0` tag, u16le rate, u8 type, u32 size (ignored), plus one padding byte unless the magic is `0x0B8D`. Data starts at byte 13 (old magic) or 14 and runs to EOF.
- As in `sol_read_header`, `-f sol` accepts any magic: only `0x0B8D` selects the old layout.
- Codec (`sol_codec_id`): type bit 1 is `sol_dpcm` (refused); otherwise the old magic is `pcm_u8`, type bit 4 is `pcm_s16le`, and anything else is `pcm_u8`. Channels (`sol_channels`): stereo when type bit 16 is set and the magic is not `0x0B8D`, else mono; the layout is `av_channel_layout_default` (channel mask unset).
- Packets: `sol_read_packet` reads 4096 bytes per packet and clears the CORRUPT flag, so `packetSpan` is `4096 / blockAlign` (4096 for u8 mono, 2048 for u8 stereo or s16 mono, 1024 for s16 stereo) and the short final packet is exact.

## Refusals

Mirrored with native's exit status, before any output is opened:

- bad tag under `-f sol`: `sol_read_header` returns a literal `-1`, status 255 on every host (`Invalid SOL tag`);
- sample rate 0: native fails opening the decoder or the muxer with `AVERROR(EINVAL)`; EdgeFFmpeg uses the Linux status 234 (EINVAL is 22 on Linux and macOS, so both agree; the test reads the host value from `os.constants.errno` for native).

Refused although native accepts (`SolError` or `unsupported-command`, exit 1):

- DPCM (any type with bit 1): native decodes `sol_dpcm` (old, new 8-bit and new 16-bit tables); no DPCM decoder is ported;
- a data size that is not a whole number of sample frames (native emits a final packet with a partial sample);
- a header truncated before the data offset whose zero-padded tag still reads `SOL\0` (native reads zeros past EOF and opens an empty stream);
- input `-ss` above zero (native seeks with `ff_pcm_read_seek`; not probed in this wave).

## Determinism and arithmetic profile

Byte copies and integer header arithmetic only; decoding and encoding use the existing PCM codecs (u8 to s16 is an integer shift). Nothing is platform-dependent, so every comparison runs on darwin and linux. No linux-gated cases.

## Evidence

Sandbox reference: `.build/reference/ffmpeg` built from 946fcce0 with `--disable-autodetect --disable-doc --disable-debug --disable-x86asm` on linux-x64, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`. The differential tests read `build-metadata.json` and assert the commit and `--disable-x86asm`; no binary hash or native digest is committed. Node v22.23.5 (Node 24 could not be installed in the sandbox).

- `tests/unit/sol.test.ts` (6 tests): the codec/channel table for all 256 types under the three magics and a foreign magic; header offsets 13/14 with read requests of at most 4 bytes inside the header; packet spans; every refusal with its status; abort before, during and after opening; six-byte probing and the frozen descriptor; the PCM backend path (copy bytes, framecrc packet rows 1024/1024/100) with no output opened for refusals.
- `tests/differential/sol.test.ts` (3 tests, 720 native comparisons, about 8 s on the sandbox):
  - 432 byte-exact comparisons: six layouts (old u8, old magic with the 16-bit and stereo bits ignored, new u8 mono, u8 stereo, s16le mono, s16le stereo) at 8000, 11025 and 22050 Hz, payloads of 4096 bytes minus, plus and exactly one sample frame, and 12295 frames; outputs `-c copy` framecrc with and without `-f sol`, s16le-decode framecrc, wav, raw `-c copy` and au;
  - 288 comparisons of output `-ss`, `-t`, `-ss -t`, `-frames:a` and `-ss` past the end, copy and decode, with and without `-f sol`;
  - native statuses for the zero rate (decode and copy, both layouts) and the bad tag, and native acceptance of every refused-but-accepted case above.

## Proposed contracts

| id | file | title | modes | platforms |
| --- | --- | --- | --- | --- |
| `demuxer.sol` | `tests/differential/sol.test.ts` | matches native SOL copy and decode framecrc, wav, raw and au outputs for three magics, codecs, channels, rates and 4096-byte boundaries | demux, copy, decode | all |
| `demuxer.sol` | `tests/differential/sol.test.ts` | matches native SOL output -ss, -t and -frames selections for copy and decode | time selection | all |
| `demuxer.sol` | `tests/differential/sol.test.ts` | mirrors native SOL bad-tag and zero-rate statuses and refuses DPCM, partial samples, truncation and input seeks before any output | refusal | all |
