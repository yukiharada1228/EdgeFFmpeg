# GENeric Header (GENH) demuxer scope

`packages/containers/src/genh.ts` ports `libavformat/genh.c` (`genh_probe`, `genh_read_header`, `genh_read_packet`) for codec 13 (`pcm_u8`), with the short-packet semantics of `av_get_packet` in `libavformat/utils.c`. It registers the demux-only `genh` descriptor with one line in `packages/containers/src/registry.ts`. Native has no GENH muxer, so there is no `-f genh` output. The module exports `openGenh`, `probeGenh`, `matchesGenh`, `GenhError` and `genh`. You reach it through the registry (`containerFormat('genh')`), not through the package barrel.

## Syntax

```
ffmpeg -i in.genh [-f genh] … out.wav|out.raw|-f framecrc out.crc
ffmpeg -i in.genh -c:a copy -f framecrc out.crc
```

## Demux

- **Detection.** An undeclared input is detected when its first four bytes are `GENH` (probe precedence 100, an exact magic that no other head matches). A confirm step then reads the eight bytes that `genh_probe` inspects. It requires the channel count (rl32 at 4) to be in 1..0xFFFF, and it zero-pads a shorter file as the probe buffer does. `-f genh` selects the format explicitly. The native `.genh` extension is not registered, because native has a `read_probe`.
- **Header.** The 60-byte header is read in pieces of at most `maxReadBytes`, with the signal checked around each read. A file shorter than 60 bytes is refused (`Truncated GENH header`). As in native, the magic is not checked under `-f genh`.
- **Fields and refusals, in native order**, keeping native's `int` casts. 183 is `AVERROR_INVALIDDATA`, 176 is `AVERROR_PATCHWELCOME`.
  - Channels (rl32 at 4) at or below 0: 183.
  - Interleave (rl32 at 8) below 0, or above `INT_MAX / channels`: 183. `block_align` is interleave × channels.
  - Rate (rl32 at 12) below 0: 183.
  - The duration at 20 is kept as `headerDuration` and does not affect the data. The tests use both matching and mismatching durations.
  - Codec (rl32 at 24):
    - codec 1 or 11 with more than `INT_MAX / 36` channels: 183;
    - codec 6 with `block_align > INT_MAX / 1024`: 183;
    - an id outside {0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 17}: 176.
  - `header_size` (at 32) above `start_offset` (at 28): 183. A `header_size` of 0 sets the start to 0x800.
  - Codec 12 (THP) is refused here as unported. Native would next read coefficient tables.
  - `block_align` at or below 0, which is interleave 0 for every ported path: 183.
- **Codecs.** Only 13 (`pcm_u8`) is ported. Every other known id is refused with `GenhError` and named in the message: 0 adpcm_psx, 1/11 adpcm_ima_wav, 2 adpcm_dtk, 6 sdx2_dpcm, 7 adpcm_ima_ws, 10 adpcm_aica, 12 adpcm_thp and 17 adpcm_ima_qt. Codecs 3, 4 and 5 are refused as `pcm_s16be_planar`, `pcm_s16le_planar` and `pcm_s8_planar`. Native picks the planar ids whenever `block_align > 0`, so here they are always planar, and planar codecs are not in `PcmCodec`.
- **Rate 0.** Native accepts the header, then fails to open the `pcm_u8` decoder, and stream copy, with `AVERROR(EINVAL)`. The port refuses it with the Linux value 234. The differential test expects native's host value, `(256 - os.constants.errno.EINVAL) & 255`.
- **Layout.** One channel is mono (mask 4) and two are stereo (mask 3). Any other count is unspecified (mask null), and the PCM path then guesses the default layout as native does: 5 channels show `5.0` in framecrc, both for copy and for decode.
- **Data.** The data runs from `start_offset`, an absolute position, to EOF. A start inside the header is valid: `avio_skip` seeks back, so header bytes become samples. Packets come from `openRawPcm`. `demux.packetSpan` returns the interleave, so native packets of `block_align` bytes, which is interleave samples, drive copy framecrc rows, time selection and regrouping. For example, there are 100-sample rows for interleave 100 and 4096-sample rows for interleave 4096.
- **Short final packet.** If the data is whole sample frames but not whole packets, the last packet is short. `av_get_packet` flags it `AV_PKT_FLAG_CORRUPT`, and `genh_read_packet` keeps the flag, so native copy framecrc prints `F=0x3`. The port sets `info.copyRefusal` (`GENH stream copy of a short final packet is not implemented`). `-c copy` is then refused (`unsupported-command`, exit 1) before any output exists. Decoding the same input is unaffected and matches native.

## Refused although native accepts

These are refused before any output is opened:

- codecs 0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12 and 17. The tests assert that native decodes and copies codecs 3, 4 and 5 (planar) with interleave 100 (status 0), and that it copies codec 0 but fails to decode it with 183;
- a data size that is not a whole number of sample frames (native emits a partial frame);
- a start at or past EOF. Native's `avio_skip` past EOF fails silently, and native then demuxes from byte 60;
- more than 65535 channels (only reachable with `-f genh`, since the probe stops at 0xFFFF);
- input `-ss` greater than 0. genh has no `read_seek`, and native's generic seek is not mirrored. The check runs after the header checks, so invalid headers keep their native status.

## Determinism and arithmetic

The demuxer does byte copies and integer header arithmetic only (int32 casts, `INT_MAX` bounds). Decoding uses the existing `pcm_u8` codec path. Nothing is platform-dependent, so every case runs on darwin and linux. No case is linux-gated.

## Evidence

Linux x86_64 oracle built in the sandbox: `.build/reference/ffmpeg`, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built from 946fcce0 with `--disable-x86asm`, compiler `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`. The differential file asserts the commit and the flag from `build-metadata.json` and pins no binary. It ran in about 9 s with `--maxWorkers=1`.

- `tests/differential/genh.test.ts` (6 tests):
  - Build-metadata identity.
  - 18 test-built files: channels {1, 2, 5} × interleave {1, 100, 4096} × {8000, 11025} Hz, with whole-packet payloads (2205, 23 or 3 packets). They cycle through four start rules: start 60, `header_size` 0 (start 0x800), start 16 inside the header, and start 100 with `header_size` 40. Before claiming parity, the test checks native's framecrc header (pcm_u8, rate, mono/stereo/5.0), the row count and the absence of flags. Then it compares byte for byte, autodetected and with `-f genh`: copy framecrc and decode framecrc; and, autodetected only, `-bitexact` WAV, raw `u8` and `pcm_s16le` framecrc. That makes 126 comparisons.
  - Output `-ss`/`-t`, `-t`, `-ss`, `-frames:a 2` and `-ss` with `-frames:a 3`, each with copy and with pcm_s16le framecrc, on four layouts (including interleave 333 and 4096 × 5 channels): 40 comparisons.
  - Short final packet on four files. The test asserts that native prints exactly one `F=0x3` row, last. Decode framecrc, s16le and u8 match native (12 comparisons). Copy to framecrc, u8 and WAV is refused with exit 1 and no output (12 refusals).
  - 14 invalid headers: channels 0 and negative, interleave 0, negative and overflowing, negative rate, rate 0, codecs 8 and 9999, the codec 1 channel overflow, the codec 6 block overflow, `header_size` above start (codec 13 and codec 4), and codec 4 with interleave 0. Each runs with decode and with copy, autodetected wherever native's probe matches and with `-f genh`. Edge's exit status equals native's (183, 176, or the EINVAL value), and no output is created.
  - 8 unported inputs: codecs 3, 4 and 5 planar, codec 0, codec 12, start past EOF, a partial frame and input `-ss`. Each runs with decode and with copy, with native's status asserted (except codec 12, which needs coefficient tables). Edge refuses each with a message naming the reason, and no output is created.
- `tests/unit/genh.test.ts` (6 tests):
  - header fields with 7-byte reads and no payload reads;
  - packet offsets and seeks, the interleave packet span and the channel masks;
  - the start/`header_size` rules (0x800, a start inside the header, a padded start, `header_size` above start);
  - 14 native-status refusals in order;
  - 12 unported codec ids named;
  - partial frames, the channel limit, truncation, the seek refusal and its order, and the read budget;
  - the copy refusal flag for short and whole packets;
  - abort before, during and after the header, and a probe with an already-aborted signal;
  - the descriptor fields, freezing, the probe channel range, the 8-byte bounded confirm and detection.
- `tests/unit/container-registry.test.ts`, `container-registry-extension.test.ts` and `container-registry-copy-refusal.test.ts` pass unchanged.

## Proposed contracts

All proposed contracts are in `tests/differential/genh.test.ts`, with modes `semantic` and `bit-exact-pcm`, and run on all platforms (no gate).

| id | title | scope |
|---|---|---|
| `demuxer.genh.copy-decode` | `matches native GENH pcm_u8 copy and decode framecrc, WAV and raw u8 for channels interleaves rates and start rules` | GENH codec 13: 1/2/5 channels, interleave 1/100/4096, 8000/11025 Hz, four start rules; copy and decode framecrc (autodetected and `-f genh`), WAV, u8 and s16le framecrc. |
| `demuxer.genh.time` | `matches native GENH output -ss, -t and -frames selections for copy and decode` | Output `-ss`/`-t`/`-frames:a` selections, copy and pcm_s16le framecrc, four layouts. |
| `demuxer.genh.short-tail` | `decodes a short final GENH packet as native does and refuses its stream copy before any output` | Short final packet: decode parity, copy refused (native `F=0x3`). |
| `demuxer.genh.refusals` | `refuses invalid GENH headers with native exit statuses before any output` | Native 183/176/EINVAL statuses for 14 invalid headers, decode and copy. |

## Unsupported

- every GENH codec other than 13, including the planar PCM ids and all ADPCM/DPCM codecs;
- partial trailing frames;
- a start at or past EOF;
- more than 65535 channels;
- input `-ss`;
- GENH output (native has none);
- the coefficient, DSP interleave and split-coefficient fields, which only THP reads;
- Workers-runtime verification and FLAC input.

The comparisons ran only on the sandbox's Linux x86_64 reference. macOS arm64 parity is expected because nothing is platform-dependent, but it was not run here.
