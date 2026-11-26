# Sony OpenMG (OMA) LPCM demuxer scope

`packages/containers/src/oma.ts` ports the LPCM path of `libavformat/omadec.c` (`oma_read_probe`, `oma_read_header`, `read_packet`), the codec table of `oma.c`/`oma.h` and `ff_id3v2_match` from `id3v2.c`, and relies on the shared raw PCM packet path for the samples. It registers the demux-only `oma` descriptor with one line in `packages/containers/src/registry.ts`. The native `oma` muxer writes ATRAC only, so there is no `-f oma` output (`muxer.oma` is excluded). The module exports `openOma`, `probeOma`, `isOmaHeader`, `isEa3Tag`, `OmaError` and `oma`; it is reached through the registry (`containerFormat('oma')`), not the package barrel.

## Syntax

`ffmpeg [-f oma] -i in.oma [output options] out` for any PCM-path output (framecrc, wav, aiff, au, raw PCM, w64, hash muxers). Input `-ss` is refused; output `-ss`, `-t` and `-frames:a` are supported.

## Demux

- Detection: undeclared input that starts with `EA3`, any byte, `0` and `96` (`oma_read_probe` without a leading ID3v2 `ea3` tag, `AVPROBE_SCORE_MAX`). Probe precedence 100 (exact magic, no overlap); `head` checks `EA3`, `confirm` reads exactly six bytes. Native's `oma,omg,aa3` extensions are not registered, since native has a `read_probe`.
- Header: the 96-byte EA3 header (`EA3_HEADER_SIZE`), read in pieces of at most `maxReadBytes` with the signal checked around each read. `eid` (RB16 at 6) must be `0xFFFF` or `0xFF80` (-1 or -128); the codec id is byte 32.
- Codec id 4 (`OMA_CODECID_LPCM`): `pcm_s16be`, stereo, 44100 Hz, as native fixes them. Data runs from byte 96 to EOF.
- Packets: `read_packet` reads `block_align` = 1024 bytes, so `packetSpan` is 256 sample frames. pts is `(pos - 96) * 44100 / 176400`, which equals the sample position, so the shared raw PCM timestamps match.
- Short tail: a payload that is not whole 1024-byte packets ends in a short packet that `read_packet` flags `AV_PKT_FLAG_CORRUPT` (framecrc `F=0x3`). Such an input sets `info.copyRefusal`, so `-c copy` is refused before any output exists (PREP-COPY); decoding is unaffected and matches native.

## Refusals

Mirrored with native's exit status, before any output is opened:

- a file shorter than the 96-byte header: `oma_read_header` returns a literal `-1`, status 255 on every host;
- `-f oma` without `EA3`, 0, 96 at the start: `AVERROR_INVALIDDATA`, 183;
- an encrypted `eid` (anything but 0xFFFF and 0xFF80): without an ID3 GEOB tag `decrypt_init` fails and the header returns `-1`, 255;
- a codec id with no case in `oma_read_header` (5, WMA, and every unknown id): `AVERROR(ENOSYS)`. EdgeFFmpeg uses the Linux status 218 (ENOSYS 38); the test reads the host value from `os.constants.errno` for native (178 on macOS).

Refused although native accepts (`OmaError` or `unsupported-command`, exit 1):

- codec ids 0 (ATRAC3), 1 (ATRAC3+), 2 (AAC), 3 (MP3), 33 (ATRAC3+ AL) and 34 (ATRAC3 AL): not PCM;
- a leading ID3v2 `ea3` tag (`ff_id3v2_match`): native skips it, exports its metadata and chapters, and finds the EA3 header after it;
- a payload that is not a whole number of 4-byte sample frames;
- `-c copy` of a short final packet (see above);
- input `-ss` above zero (native seeks with `ff_pcm_read_seek`; not mirrored).

## Determinism and arithmetic profile

Byte copies and integer header arithmetic only; decoding uses the existing PCM codecs. Nothing is platform-dependent, so every comparison runs on darwin and linux. No linux-gated cases.

## Evidence

Sandbox reference: `.build/reference/ffmpeg` built from 946fcce0 with `--disable-autodetect --disable-doc --disable-debug --disable-x86asm` on linux-x64, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`. The differential tests read `build-metadata.json` and assert the commit and `--disable-x86asm`; no binary hash or native digest is committed. Node v24.22.3.

- `tests/unit/oma.test.ts` (5 tests): header fields and offset 96 with read requests of at most 7 bytes inside the header; packets after a start sample; `copyRefusal` for short tails and its absence for whole packets and empty payloads; every refusal with its status, in native order; `oma_read_probe` and `ff_id3v2_match` byte rules and the six-byte confirm; abort before, during and after opening; the frozen demux-only descriptor, packet span 256 and the input-seek refusal.
- `tests/differential/oma.test.ts` (3 tests, 166 native runs, about 4 s on the sandbox):
  - 100 byte-exact comparisons: payloads of 0, 1, 2, 7 and 40 whole packets, and 3 short tails (4, 2044 and 6148 bytes), with and without `-f oma`; outputs `-c copy` framecrc, s16le and s16be decode framecrc, wav, raw s16be `-c copy` and decode, aiff. Native's framecrc header is checked to show `pcm_s16be` stereo 44100 Hz, whole packets carry 256 samples and no flag column, and short tails end in `F=0x3`; the 12 copy runs of short tails are refused by EdgeFFmpeg with no output;
  - 38 comparisons of output `-ss`, `-t`, `-ss -t`, `-frames:a` and `-ss` past the end, copy and decode, with and without `-f oma`, plus a raw decode range;
  - 12 status comparisons (truncated 255, bad EA3 183, two encrypted eids 255, codec 5 and 99 ENOSYS) for decode and copy, native acceptance of ATRAC3 (framecrc `atrac3` header), an ea3-tagged file (native `pcm_s16be`) and input `-ss`, all refused by EdgeFFmpeg before any output.

## Proposed contracts

| id | file | title | modes | platforms |
| --- | --- | --- | --- | --- |
| `demuxer.oma` | `tests/differential/oma.test.ts` | matches native OMA LPCM copy and decode framecrc, wav, raw s16be and aiff outputs for whole-packet payloads and refuses copy of a short final packet | demux, copy, decode | all |
| `demuxer.oma` | `tests/differential/oma.test.ts` | matches native OMA output -ss, -t and -frames selections for copy and decode | time selection | all |
| `demuxer.oma` | `tests/differential/oma.test.ts` | mirrors native OMA statuses for truncated, non-EA3, encrypted and unknown-codec headers and refuses ATRAC3, ea3 tags and input seeks before any output | refusal | all |
