# Beam Software SIFF (siff) demuxer scope

`packages/containers/src/siff.ts` is a scoped port of `libavformat/siff.c` at the pinned commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8` (see `packages/containers/NOTICE-SIFF`). It registers the demux-only container `siff` with one line in `packages/containers/src/registry.ts` (`export {siff} from './siff.js';`). Nothing else is shared: no barrel export, and no `detect.ts` or `avformat` edit. Tests import the module by path or reach it through `containerFormat('siff')`. Only audio-only `SOUN` files are demuxed. `VBV1` (VB video, optionally with audio) is detected and then refused.

## Syntax

- Undeclared: `-i in.son` (detected by content).
- Declared: `-f siff -i in.son`.
- Outputs: any registered PCM output. Tested outputs are framecrc (copy and decode), WAV, raw `u8`, raw `s16le` and AU.

## Detection and header

- **Probe** (precedence 100, exact magic): `head` tests `SIFF`, and no other registered head matches it. `confirm` (`probeSiff`) reads exactly the 12 bytes `siff_probe` inspects, using bounded reads. It accepts `VBV1` or `SOUN` at byte 8, zero-padded past EOF like native's probe buffer. Native scores a match `AVPROBE_SCORE_MAX`. Native also lists the extensions `vb,son`, but with a `read_probe` they only raise the score to 1, so no input extension is registered here. An undetected `.son` file with another kind tag is refused as `Unsupported audio container signature`.
- **Header** (`openSiff`): 36 bytes, checked in `siff_read_header` order, with zeros past EOF as `avio_rl32` returns. The layout is `SIFF`, then a size (ignored), `SOUN`, `SHDR`, a big-endian size that must be 8, 4 unknown bytes (ignored), rate `RL16@24`, bits `RL16@26`, `BODY` and a size (ignored). Data runs from byte 36 to EOF.
- **Stream**: `pcm_u8`, mono with no channel mask (native reports `mono`), `durationSamples` = data bytes. The native packet is `block_align = rate*(bits>>3)` bytes. Each byte is one u8 sample, so the descriptor's `packetSpan` is `rate*(bits>>3)` samples (22050 for 22050 Hz/8 bits and for 11025 Hz/16 bits). The rate is not scaled by the bits: a 16-bit header still decodes one byte per sample at `rate`.
- **Timestamps**: native sets 16 pts wrap bits, but its timestamps come from packet durations, and they are not wrapped past 65536. The differential test checks pts 66150 at 22050 Hz and inputs of more than 65536 samples in every layout.
- **Short final packet**: when the data length is not a multiple of `block_align`, `av_get_packet` returns a short last packet flagged `AV_PKT_FLAG_CORRUPT`, which copy framecrc prints as `F=0x3`. Such an input sets `info.copyRefusal` (PREP-COPY), so `-c copy` is refused with `SIFF stream copy of a short final packet is not implemented` before any output exists. Decoding the same input is unaffected and matches native.
- At EOF native's `av_get_packet` returns `AVERROR_EOF`, which `siff_read_packet` turns into `AVERROR_INVALIDDATA`. Native therefore logs `Error during demuxing` and exits 0. That message is not reproduced.

## Refused explicitly (before any output exists)

| Input | Edge | Native |
|---|---|---|
| `VBV1` kind | `SIFF VBV1 video is not implemented` (exit 1) | video demux. A test file without `VBHD` gives 183 |
| `-f siff`, no `SIFF` magic | `Invalid SIFF header` (183) | 183 |
| `-f siff`, kind other than `SOUN`/`VBV1` | `Not a VBV file` (183) | 183 |
| `SHDR` tag missing | `Header chunk is missing` (183) | 183 |
| `SHDR` size other than big-endian 8 | `Header chunk size is incorrect` (183) | 183 |
| `BODY` tag missing (including files of 20..31 bytes) | `'BODY' chunk is missing` (183) | 183 |
| `BODY` present, file shorter than 36 bytes | `Truncated SIFF header` (exit 1) | empty stream, 0 |
| `bits < 8` (zero packet size) | `SIFF input with rate <r> and <b> bits has no packets; not implemented` (exit 1) | empty stream, 0 |
| rate 0 | same message (exit 1) | `AVERROR(EINVAL)` from the muxer's header (host errno; 234 on Linux and macOS) |
| input `-ss` | `SIFF input seeking is not implemented` (exit 1) | generic index seek |
| `-c copy` of a short final packet | `SIFF stream copy of a short final packet is not implemented` (exit 1) | prints `F=0x3` |
| `-f siff` output | `Output requires …` | no muxer |

The 183 statuses are `AVERROR_INVALIDDATA`, which is not an errno, so they are the same on every host. The rate-0 native status is computed as `256 - os.constants.errno.EINVAL`.

## Determinism and arithmetic profile

Integer header arithmetic and byte copies only. Decoding uses the existing `pcm_u8` decoder and PCM encoders. There is no float or libm path and no platform dependence, so every case runs on darwin and linux, with no linux-gated cases.

## Evidence

Linux x86_64 oracle built in this sandbox: `.build/reference/ffmpeg`, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, commit 946fcce0, `--disable-x86asm` (asserted at test time from `build-metadata.json`). Native runs at test time, four calls at a time. No native digests are committed. The differential file runs in about 40 s with `--maxWorkers=1`.

- `tests/differential/siff.test.ts` (4 tests, 253 byte-exact comparisons):
  - 48 comparisons across 8 layouts (8000/11025/22050 Hz × 8 and 16 bits, plus 8000 Hz/24 bits and 11025 Hz/32 bits). Each layout has whole native packets and more than 65536 samples. Outputs are copy framecrc, decode framecrc, WAV, copy raw `u8`, AU and `s16le`. Native rows of 22050 samples with unflagged pts 66150 are asserted.
  - 64 decode comparisons over 16 short-tail inputs (each layout plus 1 or 4321 samples), with decode framecrc, WAV, AU and `s16le`. For each of those inputs, native's copy framecrc ends in `F=0x3` and Edge refuses copy with no output (16 refusals).
  - 140 timing comparisons. Three inputs (8000/8, 11025/16 and 22050/8 with a short tail) are run with output `-t 1.5`, `-t 0.0001`, `-frames:a 2`, `-ss 1.25`, `-ss 0.5 -t 2.1`, `-ss 100` and `-frames:a 0`. Each runs as copy framecrc (whole-packet inputs), as fixed-volume `asetnsamples=n=700:p=0` decode to framecrc and WAV, and as plain and declared `-f siff` decode to framecrc and WAV.
  - A 12-case error matrix with native statuses asserted (183 ×9, EINVAL ×1, 0 ×2) and Edge's message and status asserted with no output. The matrix also covers undetected bad kinds, native's `Error during demuxing` at EOF with exit 0, an empty `BODY` copy framecrc compared byte-exact (1 comparison), the input `-ss` refusal and the absent muxer.
- `tests/unit/siff.test.ts` (5 tests): header parsing with 5-byte reads that never touch the payload, the span formula up to 65535 × 8191, `copyRefusal` only for short tails, re-chunked packets and seeks, every `siff_read_header` check in order with its status, zero-padding past EOF, the empty-stream refusals, budgets and short reads, the 12-byte probe and detection, abort around reads and packets, and the frozen demux-only descriptor routed through the backend with no output on refusal.

## Proposed contracts

| id | file | title | modes | platforms |
|---|---|---|---|---|
| `siff.copy-decode` | `tests/differential/siff.test.ts` | matches native SIFF copy framecrc, decode framecrc, WAV, raw u8, AU and s16le for eight rate and bit layouts with whole packets past 65536 samples | bit-exact-pcm | all |
| `siff.short-tail` | `tests/differential/siff.test.ts` | matches native SIFF decoding of short final packets and refuses their stream copy, which native flags F=0x3 | bit-exact-pcm, diagnostic | all |
| `siff.timing` | `tests/differential/siff.test.ts` | matches native SIFF packet timing for output -ss, -t and -frames:a, declared -f siff and filtered decode | bit-exact-pcm | all |
| `siff.error-matrix` | `tests/differential/siff.test.ts` | refuses VBV1, malformed headers, empty-stream headers and input seeks before any output, with native statuses recorded | diagnostic | all |
| `siff.header` | `tests/unit/siff.test.ts` | follows siff_read_header in its checks, order and native statuses | diagnostic | all |

## Unsupported

- VBV1 video files.
- Muxing (native has no siff muxer).
- Input `-ss`.
- Headers that open natively as empty streams (bits < 8, rate 0, `BODY` present in a file shorter than 36 bytes).
- Stream copy of a short final packet.
- Native's `Error during demuxing` log at EOF.
- FLAC-path and Workers-runtime evidence (there is no workers test).
