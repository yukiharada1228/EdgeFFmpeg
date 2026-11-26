# GameCube RSD demuxer scope

`packages/containers/src/rsd.ts` ports `libavformat/rsd.c` (`rsd_probe`, `rsd_read_header`, `rsd_read_packet`) for the two PCM tags and relies on the shared raw PCM packet path (`openRawPcm`) for samples, seeks and timestamps. It registers the demux-only `rsd` descriptor with one line in `packages/containers/src/registry.ts`. Native has no RSD muxer, so there is no `-f rsd` output. The module exports `openRsd`, `probeRsd`, `rsdHead`, `RsdError` and `rsd`; it is reached through the registry (`containerFormat('rsd')`), not the package barrel. The tag table is private to the module.

## Syntax

- `-i in.rsd ...` (detected by content) or `-f rsd -i in ...` (declared).
- Any PCM-path output: `-c:a copy` or a decode to framecrc, wav, aiff, au, w64 or raw PCM, with output `-ss`, `-t` and `-frames:a`.

## Demux

- Detection: head `RSD` plus a version digit `2`..`6` (precedence 100, exact and non-overlapping). The confirm reads exactly the 20 bytes `rsd_probe` inspects and accepts only its `AVPROBE_SCORE_MAX` case: channels (RL32 at 8) in 1..256 and rate (RL32 at 16) in 1..384000. The score-12 case (`AVPROBE_SCORE_MAX / 8`) is not detected: other native probes often outscore it (bintext or h263 in the tests), so undeclared such files are refused with `Unsupported audio container signature`. `-f rsd` opens them.
- Header, in native's order, read with bounded reads (`maxReadBytes` per read, signal checked around each await): version is byte 3 minus `'0'` (the magic is skipped unchecked when declared); tag at 4; channels RL32 at 8 (`<= 0` or `> INT_MAX / 36` refused with native `AVERROR_INVALIDDATA`, status 183); bit depth at 12 (skipped); rate RL32 at 16 (0 refused with status 183); unknown at 20; data start RL32 at 24 for every version but 4, which starts at 0x800 and reads no start field. A negative start is refused with status 183. The start is absolute (`avio_skip(pb, start - avio_tell(pb))`), so it may lie inside the header (0, 12, 24 are accepted, and the header bytes are then samples), and a start equal to EOF is an empty stream.
- Tags: `PCM ` is `pcm_s16le`, `PCMB` is `pcm_s16be`. `OGG ` is refused with native's `AVERROR_PATCHWELCOME` status 176, any tag outside `rsd_tags` with `Unknown RSD codec tag: "XXXX"` and status 183.
- Packets: native reads a fixed 1024 bytes per packet regardless of the channel count, so `packetSpan` is `512 / channels` samples (framecrc rows, time selection, schedules). The channel mask is null, as native sets only the channel count; the PCM path applies native's default layout.
- A short final packet (data size not a multiple of 1024) is flagged `AV_PKT_FLAG_CORRUPT` by `av_get_packet`, which native copy framecrc prints as `F=0x3`. Such inputs set `info.copyRefusal`, so `-c copy` is refused (`RSD stream copy of a short final packet is not implemented`, unsupported-command, exit 1) before any output; decoding them is unaffected and matches native.

## Refused although native accepts

These fail before any output is opened (`RsdError` or `containerRefusal`, exit 1):

- the ADPCM and XMA tags (`VAG `, `GADP`, `WADP`, `RADP`, `XADP`, `XMA `): native decodes them, but they are not PCM codecs;
- a channel count that does not divide 512 (3, 5, 6, 7, 1024, ...): native's 1024-byte packets split sample frames, so copy packets are not frame-aligned and decoding fails per packet (3 channels: 1020-byte decoded frames and `Invalid PCM packet` errors, exit 0);
- a negative rate (RL32 above `INT_MAX`; native behaviour not probed);
- a data start beyond EOF (native writes an empty output, exit 0);
- a trailing partial sample frame;
- input `-ss` greater than 0 (native seeks through the generic index; not probed or mirrored);
- `-c copy` of an input with a short final packet (see above);
- undeclared files at native's score 12.

## Determinism and arithmetic profile

Byte copies and integer header arithmetic only; decoding uses the existing PCM codecs. Nothing is float- or platform-dependent, so every comparison runs on darwin and linux and no case is linux-gated.

## Evidence

Linux x86_64 oracle built in the sandbox (`.build/reference/ffmpeg`, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, commit 946fcce0, `--disable-x86asm`). The tests read `build-metadata.json` and assert the commit and flag; no binary sha or native digest is committed. Each file's native outputs come from one native call.

- `tests/differential/rsd.test.ts` (3 tests, about 3 s):
  - 32 files: versions 2, 3, 4 and 6 x `PCM `/`PCMB` x 1, 2, 4 and 8 channels, 1 to 3 whole packets, starts 32, 0x800, 24 and 0 (0x800 for version 4, with a garbage start field), four rates. Each is compared byte for byte for copy framecrc, pcm_s16le framecrc, wav, s16le decode and copy to the native raw format: 160 comparisons.
  - 8 files (3 x 4096 bytes, both tags, 1/2/4/8 channels): output `-t` copy framecrc, output `-ss` copy framecrc, `-ss`/`-t` decode framecrc and wav, `-t` raw: 40 comparisons. 8 short-tail files: decode framecrc, wav, raw and `-ss`/`-t` framecrc: 32 comparisons, plus an assertion that native copy ends with `F=0x3` and that copy is refused here. Declared `-f rsd`: a 400000 Hz rate (5 comparisons), 512 channels with one-sample packets (2), and a start at EOF (2): 81 comparisons in all.
  - Native statuses: unknown tag 183 and OGG 176 (equal here); 3 channels autodetected and declared, VAG, start beyond EOF (native 0) and the score-12 file (native `256 - os.constants.errno.EINVAL`, as bintext takes it and the audio output fails) are refused here with exit 1 and no output. Input `-ss` is refused, and rsd output fails in both.
- `tests/unit/rsd.test.ts` (6 tests): versions, tags and starts (inside the header, at EOF, version 4) with 4-byte header reads and no payload reads; packet spans for 1..512 channels; copy refusal marking; every refusal with its status; abort before, during and after the header; the 20-byte probe, its score-100 bounds, the head digits, and the descriptor fields and freezing; the PCM backend path (copy, framecrc rows, short-tail copy refusal, seek and mux refusals with no output opened).
- `tests/unit/container-registry.test.ts`, `container-registry-extension.test.ts` and `container-registry-copy-refusal.test.ts` pass unchanged.

## Proposed contracts

- `demuxer.rsd` / `tests/differential/rsd.test.ts` / `matches native RSD copy and decode framecrc, WAV and raw for versions 2 3 4 and 6, PCM and PCMB, 1 2 4 and 8 channels`; scope: autodetected RSD PCM/PCMB demux, copy and decode; platforms: all.
- `demuxer.rsd` / `tests/differential/rsd.test.ts` / `matches native RSD output -ss and -t for copy and decode, short final packets on decode, and declared -f rsd`; scope: time selection, short-tail decode, declared input; platforms: all.
- `demuxer.rsd` / `tests/differential/rsd.test.ts` / `refuses inputs native rejects or that the module does not mirror before any output, with native statuses`; scope: refusals; platforms: all.

## Unsupported

RSD output (native has none), the ADPCM, XMA and OGG tags, channel counts that do not divide 512, start beyond EOF, partial trailing frames, input seeking, stream copy of short final packets, undeclared score-12 files, Workers-runtime verification and FLAC input. The native comparisons ran only on the sandbox's Linux x86_64 reference; the macOS arm64 reference was not run here.
