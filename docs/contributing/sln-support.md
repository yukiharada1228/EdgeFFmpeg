# Asterisk SLN support

`packages/containers/src/sln.ts` ports the `ff_sln_demuxer` entry of `libavformat/pcmdec.c` (`sln_options`, `pcm_read_header`) and the `pcm.c` packet and seek helpers (pinned FFmpeg 946fcce0, see `packages/containers/NOTICE-SLN`). It is registered as `sln` with one line in `packages/containers/src/registry.ts`. Native has no sln muxer, so the module is demux-only.

## Syntax

| Form | Status |
|---|---|
| `-f sln -i <any path>` | supported |
| `-i <path>.sln` (undeclared, case-insensitive extension) | supported for inputs of at least 4 bytes |
| `-f sln -ar N` / `-ac N`, or `-ar`/`-ac` on an undeclared `.sln` | refused: `Input rate/channel declarations currently require a raw PCM format` |
| `-f sln -sample_rate N` / `-ch_layout L` (demuxer AVOptions) | refused by the CLI parser as unknown options |
| input `-ss` > 0 | refused: `SLN input seek is not implemented` |
| odd byte count (partial trailing sample) | refused: `SLN partial trailing sample is not implemented` |
| undeclared `.sln` shorter than 4 bytes (0 or 1 sample) | refused by detection: `Invalid audio container probe` |
| `-f sln` or a `.sln` output path | refused: no SLN muxer (`Output requires ...`) |

Every refusal happens before the output is opened.

## Semantics

- The stream is always `pcm_s16le`, 8000 Hz, mono (`sln_options` defaults `sample_rate=8000` and `ch_layout=mono`, `raw_codec_id` `AV_CODEC_ID_PCM_S16LE`). There is no header: `headerBytes` is 0, `open` reads nothing and returns `openRawPcm` over the whole input, so `dataOffset` is 0 and `durationSamples` is `size / 2`.
- The descriptor is not `headerless`. That keeps input `-ar`/`-ac` refused by the PCM path: native honours them (`-f sln -ar 16000` gives a 16000 Hz stream with 1024-sample packets), and the module does not mirror them.
- Detection: native has no `read_probe` and scores the `.sln` extension 50 (`AVPROBE_SCORE_EXTENSION`). The descriptor uses `demux.extensions:['.sln']` with no probe, so an undeclared input is detected only when no magic matches and its path ends in `.sln`. Detection reads exactly the first four bytes. The differential test checks native's framecrc header (`1/8000`, `pcm_s16le`, `8000`, `mono`) on every undeclared case before comparing, so no other native probe claimed the test payloads.
- Packets: the default `pcmPacketSpan(8000)` is 512 samples, equal to native `ff_pcm_default_packet_size` (`1 << av_log2(8000*16/8/10/2)`). Native framecrc of 3000 samples shows rows of 512 ×5 and 440.
- Native accepts an odd byte count, drops the last byte with a decoder error and still exits 0; Edge refuses it. Native accepts input `-ss`; Edge refuses it until its packet timestamps are mirrored. Native accepts an undeclared `.sln` of 0 or 2 bytes; Edge detection needs four bytes.

## Determinism and arithmetic profile

Byte copies and integer size arithmetic only. Decoding to framecrc, WAV, raw s16le and AIFF uses the existing PCM codecs with a pcm_s16le → pcm_s16le path, so no float conversion is involved and no `-cpuflags 0` is needed. Nothing is platform-dependent: every case runs on darwin and linux, and there are no linux-gated cases.

## Evidence

Reference: the sandbox-built Linux x86_64 `.build/reference/ffmpeg` (commit 946fcce0, `--disable-x86asm`), sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built with `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`. The tests read `.build/reference/build-metadata.json` and assert the commit and `--disable-x86asm`; no binary digest or native output is committed.

- `tests/differential/sln.test.ts` (2 tests):
  - Lengths 0, 1, 511, 512, 513 and 3000 samples, `-f sln` on a `.dat` path and undeclared `.sln` (lengths ≥ 2 samples), × no time options, output `-ss 0.02`, `-t 0.05`, `-frames:a 2`, output `-ss 0.0125 -t 0.2`, × framecrc copy, framecrc pcm_s16le decode, WAV, raw s16le and AIFF: 250 byte-exact comparisons, with native writing all five outputs of a case in one call (50 native calls). 100 native framecrc headers are checked for 8000 Hz mono pcm_s16le, and the 3000-sample copy rows for the 512-sample layout.
  - Refusals with no Edge output file, each against a native run that exits 0: `-f sln -ar 16000` (native framecrc shows 16000 Hz and 1024-sample packets), `-f sln -ac 2`, undeclared `-ar 8000`, input `-ss` with and without `-f sln`, an odd byte count, undeclared 2-byte and empty `.sln`, `-sample_rate 16000` and `-ch_layout stereo`; and `-f sln` output, which both sides refuse.
- `tests/unit/sln.test.ts` (4 tests): defaults and info fields for the six lengths, no header reads and bounded packet reads, seeks inside the input, partial-sample, seek and budget refusals, abort before and during iteration, the descriptor fields (no probe, `.sln`, `headerBytes` 0, no mux, not headerless), four-byte extension detection, and CLI refusals before any output is opened.
- `tests/unit/container-registry.test.ts` and `container-registry-extension.test.ts` pass unchanged.

## Proposed contracts

| id | file | title | modes | platforms |
|---|---|---|---|---|
| `sln.demux` | `tests/differential/sln.test.ts` | matches native SLN demux for -f sln and undeclared .sln inputs of six lengths through framecrc copy and decode WAV raw AIFF and output -ss -t -frames:a | bit-exact, bit-exact-pcm | all |
| `sln.refusals` | `tests/differential/sln.test.ts` | refuses SLN inputs that native accepts: -ar -ac input -ss partial trailing samples and undeclared inputs under four bytes with no output created | semantic | all |

## Unsupported

- Input `-ar`/`-ac` and the `-sample_rate`/`-ch_layout` demuxer options.
- Input `-ss` > 0.
- Partial trailing samples (odd byte counts).
- Undeclared `.sln` inputs shorter than four bytes.
- Network `mime_type` overrides in `pcm_read_header` (file inputs have none).
