# MIDI Sample Dump Standard (sds) demuxer scope

`packages/containers/src/sds.ts` is a scoped port of `libavformat/sdsdec.c` at the pinned commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8` (see `packages/containers/NOTICE-SDS`). It registers the demux-only container `sds` with one line in `packages/containers/src/registry.ts`. Nothing else is shared: no barrel export, no `detect.ts` or `avformat` edit. Tests import the module by path or reach it through `containerFormat('sds')`.

## Detection and header

- **Probe** (precedence 100, exact magic): `head` tests `F0 7E xx 01`. `confirm` (`probeSds`) reads exactly the 21 bytes `sds_probe` inspects, in bounded reads. It requires `F7` at byte 20 and a bit depth of 8 to 28 at byte 6. Native scores this as `AVPROBE_SCORE_EXTENSION`. No other registered head overlaps it.
- **Header** (`openSds`): 21 bytes. As in `sds_read_header`, only the bit depth is checked. A declared `-f sds` input with a different magic or no closing `F7` still opens. Depth 8..13 unpacks 2 bytes per sample (60 samples per packet), 14..20 unpacks 3 (40) and 21..28 unpacks 4 (30). Any other depth is refused (`Invalid SDS bit depth: <n>`).
- **Rate**: bytes 7..9 hold a 21-bit sample period in nanoseconds, made of three 7-bit groups (`SDS_3BYTE_TO_INT_DECODE`, so bit 7 of each byte is ignored). The rate is the integer `1000000000 / period`, or 16000 when the period is 0. Periods 1 (1 GHz) and `0x1FFFFF` (476 Hz) are tested.
- **Stream**: `pcm_u32le`, mono with no channel mask (native reports `mono`), and `durationSamples = packets * samplesPerPacket` (native `((size-21)/127)*size/4`).

## Packets

Each 127-byte data packet is `F0 7E ch 02 nn`, 120 data bytes, a checksum and `F7`. `byte2_read`, `byte3_read` and `byte4_read` are ported exactly (`unpackSdsBlock`), including `byte2_read`'s addition: it differs from the OR in `byte3/4_read` only for payload bytes with bit 7 set, which native accepts. Channel, packet number and checksum are ignored, as native ignores them. Payload reads are bounded by `maxReadBytes`. Emitted packets are re-chunked to the backend's packet budget, and timestamps are in samples at `1/rate`. The descriptor's `packetSpan` returns the native span of 60, 40 or 30 samples. Time selection and framecrc regrouping therefore reproduce native packet rows.

## Refused explicitly (before any output exists)

- A file shorter than 21 bytes (`Truncated SDS header`). Native opens a declared 20-byte file as an empty stream and exits 0.
- Data that is not a whole number of 127-byte packets, either a truncated last packet or trailing bytes (`Truncated SDS data packet`). Native drops the partial packet and exits 0.
- A packet without `F0 7E` at its start (`Invalid SDS data packet header at <offset>`) or without `F7` at its end (`Missing SDS data packet end at <offset>`). Native returns `AVERROR_INVALIDDATA` mid-stream, prints `Error during demuxing`, may skip or resume packets, and exits 0. Those mid-stream semantics are not mirrored. `openSds` scans every packet's three framing bytes with bounded windowed reads at open, and never reads the payload while it does so.
- Input `-ss` (`SDS input seeking is not implemented`). Native seeks through the generic index, emits shifted timestamps (a first packet at pts -4 for `-ss 0.001` at 44101 Hz) and ends with a demux error.
- `-f sds` output. Native has no sds muxer, and the module registers no `mux`.

Native exit statuses recorded by the differential test: mid-stream framing errors, a truncated last packet and trailing bytes exit 0. Undetected depth 7 or 29 (the probe fails and another probe claims the file) exits 187. A declared depth of 7 or 29 exits 183. Edge exits nonzero in every case and opens no output.

## Evidence

On the Linux x86_64 oracle built in this sandbox (`.build/reference/ffmpeg`, sha256 `ac302e4d…893c`):

- `tests/differential/sds.test.ts`:
  - 300 byte-exact comparisons over 75 synthesized dumps: bit depths {8,13,14,20,21,28} × periods {0, 22675, 1, 0x1FFFFF} × {0, 1, 7} packets with 7-bit random payloads, plus three 8-bit-payload dumps. Each dump is compared as copy framecrc (`-bitexact`), `-cpuflags 0` s16le decode, `-bitexact` WAV decode and copy to raw `u32le`.
  - 90 timing comparisons for depths 8, 16 and 24 at periods 0 and 22675: `-t 0.004`, `-frames:a 2`, `-t 0.0001`, declared `-f sds` with `-frames:a 0` and `-t 1`, each as copy framecrc and as a fixed-volume/asetnsamples decode to framecrc and WAV.
  - A 10-case error matrix (bad `F07E`, missing `F7`, truncated packet, trailing bytes, depth 7/29 detected and declared, truncated declared header) with native exit statuses asserted, the input-seek refusal against native's shifted output, and the demux-only refusal.
- `tests/unit/sds.test.ts` (8 tests): the three unpackers against independent formulas (including 8-bit bytes), the width and rate formulas, header parsing with 2-byte reads that never touch the payload on open, re-chunked packets with seeks and budgets, declared-input leniency, refusals, abort around reads and packets, the 21-byte probe, the frozen demux-only descriptor, and backend routing with no output opened on refusal.

## Unsupported

Muxing; input `-ss`; native's mid-stream demux error recovery for malformed packets; partial last packets; files shorter than the header; FLAC-path and Workers-runtime evidence (no workers test); checksum verification (native ignores it too).
