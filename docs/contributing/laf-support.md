# Limitless Audio Format (laf) demuxer scope

`packages/containers/src/laf.ts` is a scoped port of `libavformat/lafdec.c` at the pinned commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8` (see `packages/containers/NOTICE-LAF`). It registers the demux-only container `laf` with one line in `packages/containers/src/registry.ts` (`export {laf} from './laf.js';`). Nothing else is shared: no barrel export, no `detect.ts` or `avformat` edit. Tests import the module by path or reach it through `containerFormat('laf')`.

Only files with exactly one stream (`st_count` 1) are supported. Native exposes one mono `AVStream` per LAF channel, and the CLI maps only one of them, so multi-stream files are refused.

## Syntax

```
ffmpeg -i in.laf [-ss T] [-t T | -frames:a N] [-c:a copy | -c:a pcm_*] [-af ...] -f wav|framecrc|<raw pcm>|... out
ffmpeg -f laf -i in.laf ...
```

## Detection and header

- **Probe** (precedence 100, exact magic that no other registered head overlaps): `head` tests `LIMI`. `confirm` (`probeLaf`) reads exactly the 13 bytes `laf_probe` compares (`LIMITLESS` then `HEAD`), in bounded reads. Native scores a match `AVPROBE_SCORE_MAX`. Native also accepts a `.laf` file whose probe fails by falling back to its extension. Detection here is by content only, so such a file is refused as `Unsupported audio container signature` unless `-f laf` is given. Native's statuses for that case (0 with the `.laf` extension, 183 for `.bin`) are asserted.
- **Header** (`openLaf`): 40 bytes for one stream: `LIMITLESS`, `HEAD`, quality u8, mode u8, `st_count` rl32, vertical and horizontal rl32 floats, lfe u8, sample rate rl32 and duration rl64. Like `laf_read_header`, only `HEAD` is checked (the first nine bytes are skipped), so a declared `-f laf` input with a wrong `LIMITLESS` still opens. The checks run in native order, and each failure has native's `AVERROR_INVALIDDATA` status (183): `HEAD`, quality ≤ 3, mode ≤ 1, `st_count` from 1 to 4096, the whole header present (native reads zeros past EOF and then fails `avio_feof`), and `bpp * rate` from 1 to `INT32_MAX - 1`.
- **Codec**: quality 0, 1, 2 and 3 select `pcm_u8`, `pcm_s16le`, `pcm_f32le` and `pcm_s24le` (bpp 1, 2, 4, 3).
- **Layout**: a nonzero lfe byte gives `LFE`. Otherwise, with vertical `== 0`, horizontal 0, -30, 30, -110 and 110 give `FC` (mono), `FL`, `FR`, `SL` and `SR`. Every other position gives mono. The comparisons are exact float32 `==`, as in C: -0.0 equals 0, NaN matches nothing, and -30.000002 is mono. Mono is reported with no mask (`channelMask: null`), as the other single-channel demuxers report it. The other layouts are reported as their single-bit masks.
- **Duration**: the header duration is ignored. `durationSamples` is `blocks * rate`.

## Packets

The body is a sequence of blocks: one stored-bitmask byte (for one stream only bit 0 counts, and it must be 1), then `rate * bpp` sample bytes. Each block is one native packet of `rate` samples, so the descriptor's `packetSpan` is the rate. Time selection and framecrc regrouping therefore reproduce native's rows, for example 8000-sample rows at 8000 Hz. `packets(startSample, maxPacketBytes)` maps the start sample to its block and offset, skips each block's bitmask byte, and re-chunks samples to the packet budget with bounded reads. Timestamps are in samples at `1/rate`. A truncated final block (a lone bitmask byte, a partial sample, or all but one byte of the next block) is dropped, as native's `ffio_read_size` drops it. `openLaf` reads the 40 header bytes and one bitmask byte per block, including the dropped tail's, and never reads the samples.

## Refused explicitly (before any output exists)

- Header failures, each with exit status 183: `Invalid LAF header`, `Invalid LAF quality: <n>`, `Invalid LAF mode: <n>`, `Invalid LAF stream count: <n>`, `Truncated LAF header` and `Invalid LAF sample rate: <n>`.
- `st_count` greater than 1 (`LAF files with <n> streams are not implemented`). Native exits 0 and maps the first stream.
- A stored bitmask with bit 0 clear, in any block including a dropped tail (`Invalid LAF stored bitmask at <offset>`). Native fails mid-stream with `Error during demuxing: Invalid data` and exits 0.
- Input `-ss` (`LAF input seeking is not implemented`). `laf_read_seek` returns -1, and native falls back to the generic index.
- `-f laf` output. Native has no laf muxer, and the module registers no `mux`.
- Through the existing PCM path (not this module): framecrc output for the `FL`, `FR`, `SL`, `SR` and `LFE` layouts is refused with `Unknown channel mask for framecrc output`, because the path's framecrc layout table names only the 12 standard masks. Native prints `1 channels (FL)` and so on. WAV and raw outputs of those layouts match native byte for byte.

## Determinism and arithmetic profile

The module does only byte copies and integer header arithmetic. The float32 position fields are compared, never converted. Decoding uses the existing PCM codecs. `pcm_f32le` input reaches only the existing PCM conversions, run with `-cpuflags 0`, using finite samples in [-1, 1). Nothing is platform-dependent, so every case runs on darwin and linux, and no case is linux-gated. No errno-based native status is involved: every header refusal is `AVERROR_INVALIDDATA` (183).

## Evidence

Linux x86_64 oracle built in this sandbox (`.build/reference/ffmpeg`, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, commit 946fcce0, `--disable-x86asm`). The differential tests read `build-metadata.json` and assert the commit and the flag. Native runs at test time with one batched call per input, and no digests are committed.

- `tests/differential/laf.test.ts` (4 tests, about 8 s):
  - 240 byte-exact outputs over 48 synthesized files: qualities 0..3 × rates 8000 and 22050 × {0 blocks, 1, 2 plus a lone bitmask byte, 3 plus a partial sample, 4 plus all but one byte of a block, a header plus a rate-byte tail}. Each file is compared as copy framecrc, s16le decode framecrc, WAV, copy to its raw format and s32le raw.
  - 54 byte-exact layout outputs over 12 positions (FC, -0.0/-0.0, FL, FR, SL with -0.0 vertical, SR, LFE, LFE byte 255 with -30, 12.5, vertical 1, NaN, -30.000002) as WAV, copy WAV, s16le and u8 raw, plus copy framecrc for the six mono positions. Native's `#channel_layout_name` is asserted for all 12. The six single-speaker framecrc refusals are asserted with no output opened.
  - 127 byte-exact timing outputs: qualities 0, 1 and 3 × 8000/22050 Hz × 7 profiles (output `-ss 0.5 -t 1.7`, `-t 0.0001`, `-ss 1`, `-frames:a 2`, declared `-f laf` with `-ss 3.9` and `-t 9`, `-ss 5` past the end), each as copy framecrc, fixed-volume decode framecrc and WAV, plus a declared input with a wrong `LIMITLESS`. Undeclared detection of that input is refused, with native's statuses (0 and 183) asserted.
  - A 15-case error matrix with native exit statuses asserted: quality 4 and 255 (declared), mode 2, `st_count` 0 and 4097 (183), `st_count` 2 and 3 (0), rate 0, rate overflow for f32le and u8, truncated header and bad `HEAD` (183), and zero bitmasks in the first, middle and tail block (0, with native's demux error asserted). EdgeFFmpeg exits 183 or 1, prints the expected message and opens no output in each case. The test also covers the largest accepted f32le rate (536870911) as a byte-exact empty stream, the input `-ss` refusal (native exits 0), and the demux-only refusal.
- `tests/unit/laf.test.ts` (6 tests): the quality and layout tables (including -0.0, NaN, infinity and near misses); bounded header reads that touch only the bitmask bytes; block reader offsets with `startSample` and 6-byte packet budgets; truncated tails; every refusal and its exit status; the rate limits at their edges; abort around reads and packets; the 13-byte probe; the frozen demux-only descriptor; and backend routing with no output opened on refusal.
- `tests/unit/container-registry.test.ts` (9) and `container-registry-extension.test.ts` (7) pass unchanged.

## Proposed contracts

| id | file | test title | modes | platforms |
|---|---|---|---|---|
| `laf.tables` | `tests/unit/laf.test.ts` | maps quality to codec and the stream position to a single-channel mask as laf_read_header does | semantic | all |
| `laf.bounded-open` | `tests/unit/laf.test.ts` | reads the header in bounded reads, checks one bitmask byte per block and drops a truncated final block | semantic | all |
| `laf.refusals` | `tests/unit/laf.test.ts` | refuses malformed headers with native INVALIDDATA, multi-stream files, zero bitmasks and bad budgets | diagnostic | all |
| `laf.copy-decode` | `tests/differential/laf.test.ts` | matches native LAF copy and decode framecrc, WAV and raw for four qualities at 8000 and 22050 Hz with 0 to 4 blocks and truncated tails | bit-exact-pcm | all |
| `laf.layouts` | `tests/differential/laf.test.ts` | matches native LAF channel layouts for FC, FL, FR, SL, SR, LFE, -0.0 and unmatched positions in WAV and raw, and refuses non-mono framecrc as before | bit-exact-pcm, diagnostic | all |
| `laf.timing` | `tests/differential/laf.test.ts` | matches native LAF packet timing for output -ss, -t and -frames:a, declared -f laf and a header duration | bit-exact-pcm | all |
| `laf.error-matrix` | `tests/differential/laf.test.ts` | refuses malformed, multi-stream and seeking LAF before any output and records native exit statuses | diagnostic | all |

## Unsupported

Multi-stream files (`st_count` > 1) and native's per-channel stream selection; input `-ss`; native's mid-stream demux error for a zero bitmask; framecrc output of single-speaker layouts (a PCM-path layout-table limit); muxing (native has none); detection by the `.laf` extension alone; FLAC-path and Workers-runtime evidence (there is no workers test).
