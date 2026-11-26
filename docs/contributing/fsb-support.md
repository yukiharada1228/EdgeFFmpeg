# FMOD Sample Bank (FSB) demuxer scope

`packages/containers/src/fsb.ts` ports `libavformat/fsb.c` (`fsb_probe`, `fsb_read_header`, `fsb_read_packet`) for FSB3 files with the PCM format flag, and relies on the shared raw PCM packet path for the samples. It registers the demux-only `fsb` descriptor with one line in `packages/containers/src/registry.ts`. Native has no FSB muxer, so there is no `-f fsb` output. The module exports `openFsb`, `probeFsb`, `matchesFsb`, `FsbError` and `fsb`; it is reached through the registry (`containerFormat('fsb')`), not the package barrel.

## Syntax

`ffmpeg [-f fsb] -i in.fsb [output options] out` for any PCM-path output (framecrc, wav, au, aiff, w64, raw PCM, hash muxers). Input `-ss` is refused (see below); output `-ss`, `-t` and `-frames:a` are supported. `-c copy` is supported for payloads of whole 4096×channels-byte packets.

## Demux

- Detection: undeclared input whose first four bytes are `FSB` and a version digit `1`..`5`, with `RL32@4 == 1` (the sample count `fsb_probe` requires). Probe precedence 100 (exact magic); `head` checks bytes 0-3 and `confirm` reads exactly the 8 bytes `fsb_probe` inspects, zero-padded past EOF as the probe buffer is. Native scores this `AVPROBE_SCORE_MAX`. No input extension is registered: native's `fsb` extension only adds score 1 next to `read_probe`.
- Header, read in pieces of at most `maxReadBytes` with the signal checked around each read, over the first 88 bytes zero-padded past EOF (avio reads zeros there): version digit at 3, data offset `RL32@8 + 0x18`, duration `RL32@56` (kept as `headerDuration`, ignored for reading), format `RL32@72`, rate `RL32@76` (signed, must be > 0), channels `RL16@86` (> 0).
- Format: any format with bit `0x100` is `pcm_s16le` (it is tested before the ADPCM flags, as in native). The channel layout is unspecified (`channelMask` null), so the PCM path guesses the default layout as native does (stereo, quad, ...).
- Data: from the absolute offset to EOF. `avio_skip(offset - 88)` may seek backwards, so an offset below 88 starts the samples inside the header; an offset equal to the file size is an empty stream.
- Packets: `av_get_packet` reads `block_align = 4096 * channels` bytes, so `packetSpan` is 2048 for every channel count. A short final packet keeps `AV_PKT_FLAG_CORRUPT` (native copy framecrc prints `F=0x3`): such inputs set `info.copyRefusal`, so `-c copy` is refused before any output exists while decoding is unaffected (PREP-COPY).

## Refusals

Mirrored with native's exit status, before any output is opened (FFERRTAG statuses, host-independent):

- FSB versions other than 3 and 4 (`FSB1`, `FSB2`, `FSB5`, and any digit under `-f fsb`): `AVERROR_PATCHWELCOME`, 176;
- FSB3 formats with none of the PCM, IMA, PSX or THP flags: 176;
- rate ≤ 0 or zero channels (including every header cut before byte 87): `AVERROR_INVALIDDATA`, 183.

Refused although native accepts (`FsbError` or `unsupported-command`, exit 1):

- FSB4 (XMA2 and THP; native demuxes and copies them);
- FSB3 `adpcm_ima_wav` (`0x00400000`), `adpcm_psx` (`0x00800000`) and `adpcm_thp` (`0x02000000`) flags without `0x100`: no ADPCM decoder is ported;
- a payload that is not a whole number of sample frames (native emits a partial final packet);
- more than 512 channels (native fails decoder open with EINVAL but copies);
- sample rates above 1073741823 (`INT_MAX / 2`): from 2^30 Hz the CLI's `audio_samplerate_update` (`fftools/ffmpeg_dec.c`) finds `1 >= INT_MAX / rate` and rescales decoded timestamps through `1/28224000`, so native's decoded pts leave the 2048-sample clock (the second packet is at 2054 for 2^30 Hz); refused for every output, copy included;
- a data offset beyond the end of the file (native yields an empty stream; not mirrored);
- an 87-byte header whose low channel byte is set (native opens it; not mirrored);
- input `-ss` above zero (native seeks generically; not probed in this wave);
- `-c copy` of a short-tail payload (see above).

Shared-path gaps, not refused here because a demuxer cannot see the output (the same gaps apply to raw PCM input on the integrated base):

- AIFF output of a guessed layout with 3 or more channels: native writes a `CHAN` chunk, the shared PCM path does not (as recorded in `epaf-support.md`);
- a sample-format conversion with more than 64 channels (for example `-c:a pcm_s32le` from 65 to 512 channels): native's auto-inserted `aresample` fails with `AVERROR(EINVAL)` (`SWR_CH_MAX` is 64), the shared PCM path converts.

## Determinism and arithmetic profile

Byte copies and integer header arithmetic only; decoding and encoding use the existing PCM codecs. Nothing is platform-dependent, so every comparison runs on darwin and linux. No linux-gated cases.

## Evidence

Sandbox reference: `.build/reference/ffmpeg` built from 946fcce0 with `--disable-autodetect --disable-doc --disable-debug --disable-x86asm` on linux-x64, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`. The differential tests read `build-metadata.json` and assert the commit and `--disable-x86asm`; no binary hash or native digest is committed. Node v24.22.3.

- `tests/unit/fsb.test.ts` (7 tests): field offsets for 1, 2, 4 and 6 channels with reads of at most 16 bytes inside the 88-byte header; the duration word ignored; backward data offsets (0x18, 0x40, 86) and the empty stream; `copyRefusal` exactly for short tails; every refusal with its status, read budget and short-read errors; the rate refusal above 1073741823 after every native-status check; abort before, during and after opening; 8-byte probing and the frozen demux-only descriptor; the PCM backend path (wav decode equal to raw input, copy bytes, framecrc rows 2048/2048 and 2048/2048/1, copy refusal with no output opened).
- `tests/differential/fsb.test.ts` (4 tests, 360 native runs, about 5 s on the sandbox):
  - 189 byte-exact comparisons and 27 checked copy refusals: 1, 2 and 4 channels at 22050, 24000 and 44100 Hz, with whole packets at offset 0x100, a short tail at 0x100, data at exactly 88 (format `0x00400100`, PCM flag first) and a backward offset 0x40; outputs `-c copy` framecrc with and without `-f fsb`, s16le-decode framecrc, wav, raw `-c copy` and raw decode. Native copy rows are asserted to be 2048 samples, with `F=0x3` on the last row exactly for short tails, where EdgeFFmpeg refuses copy with no output;
  - 108 comparisons of output `-ss`, `-t`, `-ss -t`, `-frames:a` and `-ss` past the end (copy and decode on whole packets, decode on short tails);
  - native statuses for 9 inputs under decode and copy (FSB1, FSB5, a non-digit version, two unknown formats, rate 0, a negative rate, zero channels, a 60-byte header), and native copy acceptance of 9 refused inputs (FSB4 XMA2, IMA, PSX, THP, partial sample, 513 channels, offset past EOF, 87-byte header, input seek).
  - sample rates 1073741823, 1073741824 and 2147483647 (audit follow-up): native decode framecrc keeps the 2048-sample pts only at 1073741823, where decode framecrc, `-f fsb` copy framecrc and raw decode are compared byte for byte (3); at the two higher rates native exits 0 and EdgeFFmpeg refuses all three outputs with no output file (6).

## Proposed contracts

| id | file | title | modes | platforms |
| --- | --- | --- | --- | --- |
| `demuxer.fsb` | `tests/differential/fsb.test.ts` | matches native FSB3 copy and decode framecrc, wav and raw outputs for 1/2/4 channels, three rates, data offsets and short tails | demux, copy, decode | all |
| `demuxer.fsb` | `tests/differential/fsb.test.ts` | matches native FSB3 output -ss, -t and -frames selections for copy and decode | time selection | all |
| `demuxer.fsb` | `tests/differential/fsb.test.ts` | mirrors native FSB version, format, rate and channel statuses and refuses FSB4, ADPCM, partial samples, truncation and input seeks before any output | refusal | all |
| `demuxer.fsb` | `tests/differential/fsb.test.ts` | refuses FSB3 sample rates above 1073741823, where native decode timestamps leave the sample clock, and matches native at 1073741823 | refusal, decode, copy | all |
