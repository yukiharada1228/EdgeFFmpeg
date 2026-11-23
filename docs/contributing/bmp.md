# BMP codec and declared BMP image2pipe scope

The media backend supports finite, explicitly declared BMP image2pipe input and
rawvideo, BMP or BMP packet-copy output. It runs TypeScript code without Native
FFmpeg or an external media service at runtime. This is partial compatibility.

## Public API and CLI

`@edge-ffmpeg/avcodec` exports `decodeBmp`, `encodeBmp`, `BmpOptions` and `BmpError`.
Packets become independently owned, tight, top-to-bottom frame planes. The
containers package exports `openBmpStream` with bounded `ReadHandle` reads,
short-read handling, rational clocks, cancellation and one packet per iteration.

The existing `FFmpeg` API with `createMediaBackend()` accepts this scoped path:

```text
-f image2pipe -c:v bmp -i /input/frames.bin -c:v rawvideo -f rawvideo /output/pixels.bin
-f image2pipe -c:v bmp -i /input/frames.bin -c:v bmp -f image2pipe /output/frames.bin
-f image2pipe -c:v bmp -i /input/frames.bin -c:v copy -f image2pipe /output/copy.bin
```

One input/output, selected map aliases, frame limits, overwrite handling and the
existing transactional output group are connected. Copy does not require decoder
success. Input declarations and unsupported options fail explicitly.

## Compared behavior

- BI_RGB 1/4/8/16/24/32-bit images; OS/2 core and Windows 40/56/64/108/124-byte
  headers; palettes, top-down/bottom-up rows and missing row-alignment fallback.
- Supported 16/32-bit bitfields, inferred unused BGRA alpha, RLE4/RLE8 runs,
  literals, padding, deltas, early end and named malformed partial frames.
- All twelve Native BMP encoder input formats, canonical headers, masks,
  systematic palettes, discarded palette alpha and zero row padding.
- Named packed32 encoder negotiation, including unused bytes and alpha.
- Scoped raw packet layouts, BMP-to-existing-raw-codec bridges and BMP framing.

Evidence includes436 original decoder cases,118 full encoder packets,156 raw
layout cases,24 raw codec bridges,120 public Node CLI and54 local R2 CLI cases,
six R2 fault/recovery modes,13 workerd codec roundtrips and three stream clocks.
Additional comparisons cover384 malformed RLE inputs,1536 controlled Native RLE
row-capacity profiles, eight decoder-failing copy inputs and ten packed32
negotiation cases. The profile corpus stores full-payload SHA256 results and the
Native oracle/library/compiler provenance. Input recipes and upstream sources
are hashed by the corpus guard.

`BmpOptions.rleLineAlignment` accepts8/16/32/64. Default16 matches the pinned
local aarch64 build. Malformed RLE parser state depends on Native row capacity;
this option is an explicit reference profile, not CPU autodetection. A Native
decoder with a controlled buffer allocator verifies all four profiles.

## Resource and compatibility limits

Packet/frame allocation bounds are explicit; row reads/writes and packet counts
are bounded, processing follows backpressure and cancellation is checked. CLI
payload limits reserve a fraction of the resident budget for simultaneous
buffers. This is not measured total-heap or CPU-budget certification.

General BMP error/log parity, unusual RLE/depth combinations, image2 file
patterns, automatic probing, parser resynchronization, changing frame geometry,
general filters/pixel conversion/time/map semantics, distributed execution and
production Cloudflare/resource verification remain unfinished. The named BMP
and image2pipe capability entries remain partial. Passing these cases does not
certify full BMP, image2pipe or FFmpeg compatibility.

See the pinned sources and notices in `packages/avcodec/NOTICE-BMP` and
`packages/containers/NOTICE-BMP-STREAM`. The development-only oracle is
`tools/differential-runner/bmp-rle/oracle.c`; regenerate its binary with
`node tools/differential-runner/build-oracle.mjs bmp-rle`.

Recheck the cached corpus against1536 fresh Native runs with
`node tools/differential-runner/bmp-rle/generate.mjs --check`. The explicit
`--write` mode updates cached results and oracle provenance after the same source,
recipe, target and library checks. Runtime packages never invoke this tool.

Four additional Native spatial cases preserve palette storage through direct
frame flips and positioned actor crop, and preserve packed monob vertical rows.
Horizontal monob reflection/crop and paletted or bit-packed transpose require
format negotiation and are rejected at unsupported direct entry points. These
checks do not add general CLI negotiation for the new wire formats.
