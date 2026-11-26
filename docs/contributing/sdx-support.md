# Sample Dump eXchange (sdx) demuxer scope

`packages/containers/src/sdx.ts` is a scoped port of `libavformat/sdxdec.c`, with packets as in `libavformat/pcm.c` `ff_pcm_read_packet`, at the pinned commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8` (see `packages/containers/NOTICE-SDX`). It registers the demux-only container `sdx` with one line in `packages/containers/src/registry.ts` (`export {sdx} from './sdx.js';`). Nothing else is shared: no barrel export, and no `detect.ts` or `avformat` edit. Tests import the module by path or reach it through `containerFormat('sdx')`. Capability: `demuxer.sdx`. Wave 2 branch `wave2/fmt-sdx`.

## Syntax

```
ffmpeg -i in.sdx [-ss S] [-t T] [-frames:a N] [-c:a <pcm codec>] -f framecrc|wav|au|w64|<raw pcm> out
ffmpeg -f sdx -i in.bin ...
```

## Detection and header

- **Probe** (precedence 100, exact magic plus a `confirm`): `head` tests `SDX:`, as `sdx_probe` compares `AV_RB32(buf)` with `AV_RB32("SDX:")` and returns `AVPROBE_SCORE_EXTENSION` (50). No other registered head overlaps it. Native ranks probes by score, so a file whose bytes also satisfy a higher-scoring probe goes to that demuxer instead. The one such probe that always reads these bytes is `mov_probe`: `SDX:` is a 1.4 GB atom size, so it reads only the atom type at byte 4. `moov`, `mdat`, `pnot`, `udta` and `ftyp` score 100, `ediw`, `wide`, `free`, `junk` and `pict` 95, and `skip`, `uuid` and `prfl` 50, which ties sdx and detects nothing. Native then fails (183, or 234 once mov opens a `moov` head). `confirmSdx` reads at most 12 bytes in bounded reads and resolves false for those 13 tags, except `ftyp` with a `jp2 ` or `jxl ` brand (score 5). Files shorter than 8 bytes, where `mov_probe` reads no tag, stay sdx. `-f sdx` reads every such file as native does (tested). Data-dependent probes that scan the payload (mp3, ac3 and similar) are not mirrored.
- **Header** (`openSdx`), field by field as in `sdx_read_header`:
  1. It skips the four magic bytes. They are not checked when the input is declared `-f sdx`.
  2. It scans bytes for `0x1a` (`scanSdxMarker`). The scan reads windows of at most `min(maxReadBytes, 64)` bytes, so no single read exceeds the budget, and it can run as far as EOF. Reaching EOF fails with `INVALIDDATA` (exit 183), because `avio_r8` then returns 0.
  3. The next byte must be 1 (183 otherwise, including at EOF).
  4. A length byte, then that many name bytes, then 4 bytes, are skipped unread.
  5. The depth byte must be 8, 16, 24 or 32, giving `pcm_u8`, `pcm_u16le`, `pcm_u24le` or `pcm_u32le`. Any other value, or EOF (read as 0), fails with 183.
  6. Then the RL32 sample rate, and 16 bytes skipped unread.
  7. The data runs from `marker + 28 + nameLength` to EOF.
- **Stream**: mono with no channel mask (native: one channel, unspecified order, which the CLI reports as `mono`), `blockAlign = depth / 8`, and `durationSamples = dataBytes / blockAlign`. Only header bytes are read while opening: the scan windows, 2 bytes after the marker and 5 bytes at the depth. The header is never parsed from the payload; at most one 64-byte scan window can overlap it.

## Packets and timestamps

Packets come from the shared `openRawPcm` reader: bounded reads, re-chunked to the backend's packet budget, with sample timestamps at `1/rate`. The descriptor has no `packetSpan`, so the default `pcmPacketSpan(rate)` applies. That equals `ff_pcm_default_packet_size` for one channel: 512 samples at 8000 Hz, 2048 at 22050 Hz and 4096 at 44100 Hz. Native framecrc of copied packets confirms the span (4096 bytes at 22050 Hz u16le).

`sdx_read_header` sets no pts info, so native packets keep the 1/90000 time base from `avformat_new_stream`. The decode paths match byte for byte anyway: framecrc rows, WAV, AU and raw output, with and without output `-ss`/`-t`/`-frames:a`. Native `-c copy` prints 90 kHz timestamps and durations, which EdgeFFmpeg does not mirror. The opened `info.copyRefusal` therefore refuses copy through PREP-COPY.

## Supported vs refused (all refusals happen before any output exists)

| Form | Native | EdgeFFmpeg |
|---|---|---|
| depths 8/16/24/32, any rate 1..INT_MAX, names of 0..255 bytes, free text before `0x1a` | decodes | decodes, byte-exact (tested at 8000, 22050 and 44100 Hz) |
| `-c copy` (any output) | 1/90000 packets | `unsupported-command`, exit 1: `SDX stream copy is not implemented: native packets use a 1/90000 time base` |
| input `-ss` > 0 | `ff_pcm_read_seek` in 1/90000 units | `unsupported-command`: `SDX input seeking is not implemented` |
| depth not in {8,16,24,32} (for example 0, 12 or 64) | 183 | 183: `Invalid data found when processing input: SDX bit depth <n>` |
| no `0x1a` after the magic, or a magic-only file | 183 | 183: `... SDX header marker` |
| version byte other than 1, or EOF after the marker | 183 | 183: `... SDX header version` |
| EOF at or before the depth byte | 183 | 183: `... SDX bit depth` |
| rate 0 or above INT_MAX (RL32 into an `int`) | opens, decoder fails with `AVERROR(EINVAL)`: exit `(256-EINVAL)&255` on the host (234 on Linux and macOS) | 234: `SDX sample rate <n> is not implemented` |
| header cut after the depth byte (partial rate or skip) | exit 0, no packets | `Truncated SDX header is not implemented` |
| trailing partial sample | drops it, exit 0 | `Partial trailing SDX sample is not implemented` |
| no sample data after the header | exit 0; the decoder never opens, so decoded framecrc prints `#tb 0: 1/90000` | `Empty SDX sample data is not implemented` (every output) |
| undeclared `SDX:` head with a mov atom type at byte 4 (see Probe) | mov claims it and fails (183 or 234) | `Unsupported audio container signature` |
| `-f sdx` output | no muxer | `Output requires ...` (no `mux`) |

## Determinism and arithmetic profile

Only byte copies and integer header arithmetic. Decoding uses the existing integer PCM codecs (`pcm_u8`/`u16le`/`u24le`/`u32le` into s16/s32). Nothing depends on the platform or on float, so every comparison runs on darwin and linux, with no linux-x64 gate. The tests run native with `-cpuflags 0` on decode paths as a precaution.

## Evidence

Sandbox Linux x86_64 reference built by `npm run bootstrap -- --only npm,submodule,reference --allow-unpinned-reference`:

- `.build/reference/ffmpeg` sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, built at commit 946fcce0 with `--disable-autodetect --disable-doc --disable-debug --disable-x86asm`.
- `cc --version`: `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`.
- The sandbox Node was 22.23.5. Node 24.22.3 was installed from npm (`node@24`) for bootstrap and every run.

The differential tests read `.build/reference/build-metadata.json` and assert commit `946fcce0` and `--disable-x86asm`. They never pin a binary sha or commit native digests. The file runs in about 6 s with `--maxWorkers=1`.

- `tests/differential/sdx.test.ts` (6 tests):
  - **Decode matrix.** 48 synthesized inputs: depths {8,16,24,32} × rates {8000,22050,44100} × name lengths {0,1,17,255}. Lengths cycle through 1, span−1 and 2·span+3 samples. The free text before the marker is empty, one byte or 99 bytes with NUL and 0xFF, and half the files use a `.dat` extension. One native call per input writes four outputs (framecrc, WAV, s32le raw, AU, `-bitexact`), so there are 192 byte-exact comparisons.
  - **Output time selection.** 4 inputs × 6 profiles (`-ss 0.0125`, `-t 0.07`, `-ss 0.03 -t 0.1`, `-ss 0.2`, `-t 1`, `-frames:a 2`), each as framecrc and WAV: 48 byte-exact comparisons from 24 native calls.
  - **Copy refusal.** Native `-c copy` succeeds for 4 depths with `#tb 0: 1/90000`, 3 packets, a first packet of `span·depth/8` bytes and a duration of `round(span·90000/rate)`. EdgeFFmpeg refuses framecrc and raw copy with exit 1, and no output file exists (8 refusals).
  - **Statuses.** Native and EdgeFFmpeg statuses match for 9 inputs: depth 12, 0 and 64, a missing `0x1a`, a magic-only file, version 2 and a cut before the depth (183), and rate 0 and 2^31 (host EINVAL for native, 234 for EdgeFFmpeg). Three inputs that native accepts with exit 0 (trailing partial sample, a cut after the depth, input `-ss`) are refused explicitly. No output exists in any of these cases.
  - **Forced format.** For `free` at byte 4, native's undeclared status (183, mov) is asserted, and native `-f sdx` framecrc is compared byte-exact (1 comparison).
  - **mov heads and empty data** (added by the wave-2 audit and run on macOS arm64 against the darwin reference build `1b86106f…ab92`; its linux-x64 run is CI's). For the 13 mov atom types at byte 4, native's undeclared failure is asserted, EdgeFFmpeg refuses with no output, and `-f sdx` framecrc is byte-exact (13 comparisons, 13 refusals). For `ftyp` with `jp2 `/`jxl ` brands, the 0x82827f7d tag, `Free` and `text`, both detect sdx and framecrc is byte-exact (5). An empty data section decodes natively with a `1/90000` framecrc header; EdgeFFmpeg refuses all four outputs with none created (4 refusals).
- `tests/unit/sdx.test.ts` (6 tests):
  - the depth table and its refusals;
  - header parsing for 4 depths × read budgets {1,2,3,4,64} (those at least one sample frame) × names {0,1,255}, with request sizes bounded and the name, skipped and payload bytes never read on open at budget 1;
  - packets after a seek;
  - the first-`0x1a` rule;
  - every refusal with its exit status;
  - abort before, during and after open;
  - the frozen demux-only descriptor, detection within 12 bytes and the mov-tag confirm with its bounded reads;
  - backend decode, copy, input seek, bad-input and sdx-output refusals with no output opened.
- Registry: `tests/unit/container-registry*.test.ts` (3 files, 17 tests) pass unchanged, along with `npm run typecheck`, `npm run lint` and `npm run boundaries`.

## Proposed contracts

| id | file | name | modes | scope |
|---|---|---|---|---|
| `sdx.decode` | `tests/differential/sdx.test.ts` | `matches native SDX decode framecrc WAV raw and AU for four depths three rates name lengths 0 to 255 and three lengths` | semantic, bit-exact-pcm | 48 inputs × 4 outputs byte-exact; all platforms |
| `sdx.time` | `tests/differential/sdx.test.ts` | `matches native SDX decode with output -ss -t and -frames:a through framecrc and WAV` | semantic, bit-exact-pcm | 48 time-selection comparisons; all platforms |
| `sdx.copy-refusal` | `tests/differential/sdx.test.ts` | `refuses SDX -c copy before any output exists while native copies with a 1/90000 time base` | diagnostic | native 1/90000 copy asserted, Edge refusal before output; all platforms |
| `sdx.statuses` | `tests/differential/sdx.test.ts` | `matches native SDX statuses for depth 12 a missing 0x1a and other invalid headers, and refuses unmirrored inputs before output` | diagnostic | 9 native statuses (errno mapped) plus 3 explicit refusals; all platforms |
| `sdx.forced` | `tests/differential/sdx.test.ts` | `matches native -f sdx on free text that native detection would hand to the mov probe` | semantic, bit-exact-pcm | -f sdx byte-exact and native's undeclared mov status; all platforms |
| `sdx.mov-empty` | `tests/differential/sdx.test.ts` | `leaves SDX heads that native hands to the mov probe undetected and refuses empty sample data that native decodes with a 1/90000 framecrc time base` | semantic, bit-exact-pcm, diagnostic | 13 mov heads refused undeclared and byte-exact with -f sdx, 5 heads detected by both, empty data refused for 4 outputs; all platforms |
| `sdx.header` | `tests/unit/sdx.test.ts` | `scans for 0x1a in bounded reads and parses the header without reading the payload` | semantic | bounded header parse; no native run |
| `sdx.refusals` | `tests/unit/sdx.test.ts` | `fails like read_header with INVALIDDATA and refuses the unmirrored forms` | diagnostic | refusal statuses; no native run |
| `sdx.backend` | `tests/unit/sdx.test.ts` | `decodes through the PCM backend and refuses copy, input seeks, sdx output and bad inputs before any output opens` | api | backend routing; no native run |

## Unsupported

- muxing;
- `-c copy`, because of its 1/90000 timestamps;
- input `-ss`;
- rate 0 or above INT_MAX;
- headers truncated after the depth byte;
- trailing partial samples;
- empty sample data;
- native's score-based detection where a payload-scanning probe (mp3, ac3 and similar) would outscore sdx on an `SDX:` file; mov's atom-type claims at byte 4 are mirrored by leaving those heads undetected;
- FLAC-path and Workers-runtime evidence (no workers test).
