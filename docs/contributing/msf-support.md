# Sony PS3 MSF (msf) demuxer scope

`packages/containers/src/msf.ts` ports `msf_probe`, `msf_read_header` and `msf_read_packet` from `libavformat/msf.c` and registers a demux-only `msf` descriptor (one line in `packages/containers/src/registry.ts`). Native has no MSF muxer, so `-f msf` output is refused like any other demux-only format. The module exports `openMsf`, `probeMsf`, `readMsfHeader`, `MsfError`, the constants `msfFieldBytes` (20), `msfDataOffset` (64) and `msfPacketSamples` (512), and the `msf` descriptor. It is not re-exported from the package barrel, and tests import it by path. Only codecs 0 (`pcm_s16be`) and 1 (`pcm_s16le`) are decoded.

## Syntax

- Detected: `-i in.msf ...` (content probe only, any file name).
- Declared: `-f msf -i in.bin ...`.
- Outputs: every PCM-path muxer (framecrc, wav, w64, au, aiff, raw PCM, hash muxers), decoded or `-c copy`, with output `-ss`, `-t`, `-frames:a` and audio filters.

## Detection

The probe head is the exact bytes `MSF` with any fourth byte (the version). `confirm` reads the same 20 bytes `msf_probe` inspects, in bounded reads, and requires non-zero big-endian words at 8 (channels) and 16 (rate). `AV_RB32` is unsigned, so only zero fails, as natively. The codec word only lowers native's score (20 instead of 66 above 16), so every codec is detected and then refused by the header if it is not 0 or 1. Precedence is 100: no other registered head starts with `MSF`. Native also matches the `.msf` extension (score 50), which selects a file whose probe failed. Following the registry rule, no `demux.extensions` are declared, so such files report `Unsupported audio container signature` (see Unsupported).

## Header

`openMsf` refuses files shorter than 64 bytes, then reads only bytes 0..19 in bounded reads (at most `maxReadBytes` each, signal checked around every await). It never reads the flags word, the padding or the payload while opening. The checks follow `msf_read_header` in order:

1. channels = RB32@8 as a signed int, which must be in 1..2097150 (`<= 0 || >= INT_MAX/1024` is `AVERROR_INVALIDDATA`, exit 183);
2. rate = RB32@16 as a signed int, which must be greater than 0 (exit 183, so 0x80000000 and above are refused);
3. codec = RB32@4: 0 is `pcm_s16be`, 1 is `pcm_s16le`. Codecs 3 (adpcm_psx), 4-6 (atrac3) and 7 (mp3) are refused as not implemented (`unsupported`, exit 1). Every other id is `AVERROR_PATCHWELCOME` natively and is refused with exit 176.

The size word RB32@12 only sets native's stream duration (`av_get_audio_frame_duration2`), which no supported output reads. It is kept as `info.sizeField`, and the data runs from 0x40 to EOF regardless. Channel counts above 65535 are refused (the shared raw PCM limit). The layout is unspecified (`channelMask:null`, as nistsphere and epaf), so the shared PCM path guesses the default layout under `-guess_layout_max` as native does.

## Packets and copy

`msf_read_packet` returns `av_get_packet(1024 * channels)` bytes, which is 512 sample frames of 16-bit PCM. `packetSpan` is 512 for every input, so framecrc rows, schedules and time selection follow native's 512-sample packets (both codecs, 1 to 6 channels, three rates and the timing profiles were compared). Packets come from `openRawPcm` over the data range.

When the payload is not a whole number of 1024·channels-byte packets, `av_get_packet` returns a short final packet flagged `AV_PKT_FLAG_CORRUPT`, which copy framecrc prints as `F=0x3`. Such inputs set `info.copyRefusal`, so `-c copy` to any output is refused (`MSF stream copy of a short final packet is not implemented`, `unsupported-command`, exit 1) before any output is created. Decoding the same input is unaffected and matches native. Inputs of whole packets, including empty payloads, copy unchanged.

## Determinism and arithmetic profile

The header is integer arithmetic, the payload is byte copies, and decoding uses the existing PCM codecs. No float path is involved, and nothing depends on the platform, so every comparison runs on darwin and linux. There are no linux-gated cases.

## Evidence

Linux x86_64 sandbox oracle `.build/reference/ffmpeg` (FFmpeg n9.0.2, commit 946fcce0, `--disable-x86asm`), sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built with `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`. This is not the pinned linux-x64 binary. The tests read `build-metadata.json` and pin no binary digest. All inputs are synthesized in the tests and native runs at test time, with one native process per input writing every output.

- `tests/differential/msf.test.ts` (4 tests, about 8 s on the sandbox):
  - 432 byte-for-byte outputs and 96 copy refusals: codecs 0 and 1 × 1, 2, 3 and 6 channels × 32000, 44100 and 48000 Hz × 1024, 1536, 700 and 1 frames (odd frame counts also get a size word that differs from the data). Each is written as decoded framecrc, copy framecrc, WAV, s16le, copy raw and AIFF (AIFF for 1 and 2 channels only, see below). For the 48 short-tail inputs the test checks native's `F=0x3` final row and that both copy outputs are refused here with no output file.
  - 504 timing outputs: both codecs × four inputs (2 ch 44100 Hz 2560 frames, 3 ch 32000 Hz 1536, 6 ch 48000 Hz 1024, and a 1 ch 8000 Hz 700-frame short tail, which is decoded only) × detected and `-f msf` × output `-ss 0.01`, `-t 0.02`, `-ss 0.005 -t 0.03`, `-frames:a 2`, `-frames:a 0`, `-t 1` and `-ss 0.0001 -frames:a 1`. Copy (framecrc and raw) and a `volume=0.5:precision=fixed,asetnsamples=n=300:p=0` decode go to framecrc, WAV and raw.
  - 24 layout outputs: 3 and 6 unlabelled channels under `-guess_layout_max 0` and `2`, as WAV, W64, AU, copy and decoded framecrc, and AIFF.
  - 10 refusals with native statuses recorded: codec 3 (native 0), codec 5 declared (0), codec 7 declared (native copy exited 0 in a manual probe; not asserted, as the mp3 parser depends on payload), codec 99 detected and declared (176 = 176), zero channels declared (183 = 183), 2097151 channels (183 = 183), rate 0x80000000 (183 = 183), a partial trailing sample (native 0) and input `-ss 0.001` (native 0). Also zero channels undetected (native 183 through the extension; `Unsupported audio container signature` here) and `-f msf` output (refused by both). No refusal leaves an output file.
- `tests/unit/msf.test.ts` (6 tests): header fields for both codecs, read offsets and lengths (20 bytes, none from the payload), the size word ignored for duration, the copy-refusal rule for 1, 2, 3 and 6 channels × 7 frame counts, every refusal with its code and status in native order, short files, read budget, short reads, abort before, during and after opening, the 20-byte probe (any fourth byte, unsigned words), the descriptor fields, and backend copy, decode, framecrc rows, the copy refusal, seek refusal and msf-output refusal before any output opens.

## Unsupported

- Codecs 3 (adpcm_psx), 4-6 (atrac3) and 7 (mp3), refused (exit 1) where native decodes or copies them. Other codec ids are refused with native's 176.
- `-c copy` of an input whose payload is not whole 1024·channels-byte packets (native flags the last packet corrupt), refused before output. Decoding works.
- A partial trailing sample frame, refused where native decodes with an invalid-packet error and exits 0.
- Input `-ss` above 0, refused (`MSF input seeking is not implemented`) because native's generic seek semantics are not mirrored.
- Files shorter than 64 bytes, refused where native may open an empty stream.
- More than 65535 channels, refused (shared raw PCM limit).
- Undetected inputs whose probe fails (a zero channel or rate word) report `Unsupported audio container signature` (exit 1). Native falls back to the `.msf` extension and reports INVALIDDATA (183).
- AIFF output of a guessed layout with 3 or more channels (without `-guess_layout_max` below the channel count): native writes a CHAN chunk with the guessed layout. The shared PCM path passes no mask to the AIFF muxer for an unlabelled input, so the chunk is missing. This is not refused, because a demuxer cannot see the output format. It needs the shared change already recorded in `epaf-support.md` (a guessed mask for AIFF in `packages/avformat/src/index.ts` and a layout tag table in `packages/containers/src/aiff.ts`).
- FLAC, workers and integration paths were not exercised.

## Proposed contracts

| id | file | title | modes | scope | platforms |
|---|---|---|---|---|---|
| `demuxer.msf.decode-copy` | `tests/differential/msf.test.ts` | `matches native MSF decode framecrc, copy framecrc and raw, WAV, raw and AIFF for both codecs four layouts three rates and whole or short final packets` | decode, copy | codecs 0/1, 1-6 channels, 32000/44100/48000 Hz, whole packets and short-tail copy refusal | all |
| `demuxer.msf.timing` | `tests/differential/msf.test.ts` | `matches native MSF output -ss, -t and -frames:a timing with copy and decode, and declared -f msf` | decode, copy | output time selection, frame limits, declared input | all |
| `demuxer.msf.layout` | `tests/differential/msf.test.ts` | `matches native MSF unlabelled 3 and 6 channel layouts under -guess_layout_max 0 and 2, including AIFF where nothing is guessed` | decode, copy | unlabelled layouts | all |
| `demuxer.msf.refusals` | `tests/differential/msf.test.ts` | `refuses unsupported MSF codecs, invalid headers, partial frames and input seeks before any output and records native statuses` | refusal | codecs 3/5/7/99, invalid channels and rate, partial frame, input seek, msf output | all |
