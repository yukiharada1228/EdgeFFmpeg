# Initial rawvideo path

The finite rawvideo path starts the video phase of the detailed design. It provides declared headerless input/output, rawvideo decode/encode, gray/YUV/RGB output-size resizing and video framecrc. Compressed video, general color conversion, general-format scaling and general video filters remain incomplete.

## Pixel layouts and codecs

`pixelLayout(format, width, height)` in avutil returns immutable tight wire-plane offsets, row byte counts, plane dimensions and aggregate bytes, without allocating pixel payloads. Supported 8-bit formats are gray (gray8 alias), rgb24, bgr24, rgba, bgra, argb, abgr, yuv420p, yuv422p, yuv444p, yuva420p, nv12, nv21 and gbrp. Chroma dimensions round up independently for odd width/height. Semi-planar chroma rows have two components per chroma position; alpha planes remain full resolution. Dimensions and aggregate packet sizes are checked using bigint before conversion to allocation sizes. No color interpretation or conversion is inferred from these layouts.

`decodeRawVideo(packet, format, {maxFrameBytes, signal})` accepts exactly one tight frame and creates one owned allocation with disjoint plane views and tight linesizes. Packet PTS/time base are preserved. `encodeRawVideo(frame, frameRate, options)` validates all planes and positive strides, strips row padding and returns an independently owned tight packet. Input-plane aggregate storage and output allocation each must fit maxFrameBytes. Negative strides and unsupported formats fail explicitly. Timestamps are rescaled with bigint rational arithmetic; one output packet represents one frame. Unknown PTS stays unknown in the codec API, while the finite muxers require known timestamps matching their explicit output plan.

## Finite I/O and staging

`openRawVideo` takes declared width, height, pixelFormat, frameRate, maxReadBytes and maxFrameBytes. Frame assembly accepts short bounded range reads and holds one frame at a time. Packet ranges and PTS use bigint; no whole-file read is used. Input byte size must be known, fit signed64 and contain an integral number of complete frames. A truncated final frame is rejected before creating CLI output. This strict policy is not a claim of identical native malformed-input recovery.

`muxRawVideo` and `muxRawVideoFrameCrc` validate packet size, count, stream index, flags, timestamps and durations against the output plan. Writes are bounded and awaited for backpressure. Success commits only after the declared frame count; cancellation, read/write failures or invalid packets abort staged output. framecrc writes native rawvideo dimensions and the default 0/1 sample-aspect-ratio header, plus each frame's checksum and rational time base. Non-bitexact output identifies EdgeFFmpeg as its software. Checksum loops also observe cancellation.

## CLI scope

The existing createMediaBackend factory routes explicitly declared rawvideo input to this path; createWavBackend remains a backward-compatible alias. One input and one output use absolute virtual paths. Input requires `-f rawvideo` and explicit `-video_size SIZE` (or `-s`). Size accepts numeric dimensions and the 55 pinned native size names; see [size syntax](pixel-resize.md). Pixel format defaults to yuv420p and accepts `-pixel_format` or `-pix_fmt`. Frame rate defaults to 25 and accepts `-framerate`: positive integer, finite decimal, fraction or the eight native named rates. Exact numeric ratios within the native default 1001000 bound are supported; expression syntax and bounded-rational approximation are not implemented.

Output requires explicit `-f rawvideo` or `-f framecrc`. Codec defaults to rawvideo; copy and rawvideo accept the documented generic/video codec aliases. Output `-pix_fmt` selects a supported component-preserving packing conversion when encoding rawvideo. Stream copy accepts only the unchanged format; a differing format is explicitly unsupported in this path. Frame-count aliases include `-frames`, `-frames:v`, stream-zero forms and `-vframes`, with last-option precedence, zero, negative unlimited and signed64-max counts. One video-stream map, output -an/-sn/-dn, scoped bitexact and overwrite policies are supported.

```sh
npm run ffmpeg -- --root ./media -- \
  -f rawvideo -pixel_format yuv420p -video_size 160x90 \
  -framerate 30000/1001 -i /input.yuv \
  -c:v copy -frames:v 10 -f rawvideo /output.yuv
```

For large frames, API callers must set an explicit buffer/resident budget sufficient for the full frame. The backend preflights three simultaneous input frame payloads for copy or eight for unchanged-format decode/encode. Conversion preflights four input-frame plus six output-frame payloads; both individual layouts must fit maxBufferBytes. A small framecrc text reservation is added. Oversized work fails before source reads or output creation. This is conservative payload accounting, not observed isolate heap, CPU, GC or adapter-retention measurement. Tiled large-frame processing remains future work.

Frame-rate conversion, general color conversion, general filters, arbitrary aspect/color metadata, demuxer stride options, compressed containers/codecs, multiple streams and live/unknown-size input remain incomplete and are rejected by this path. [8-bit resizing](pixel-resize.md) documents output -s, aliases, resource bounds and ignored streamcopy sizes. No native process, remote transcoder or hidden execution fallback is used by the runtime packages.

## Scoped time selection

Input and output `-ss`, `-t` and `-to` use the shared microsecond parser and last-option precedence; `-t` takes precedence over `-to`. Video seek/stop values may be signed; negative durations remain rejected. Failed negative rawvideo seeks retain the pinned Native probe-flush position, and uninitialized decoder clocks use physical demux fallback timing. See [signed video time](signed-video-time.md) for the exact finite scope. Stream copy selects against native microsecond-rounded packet clock thresholds. Decode/encode additionally follows accurate input trimming, filter frame rounding and the encoder deadline, including extended time-base quantization near half-frame boundaries. These paths intentionally have different sub-frame duration behavior.

Input seek beyond EOF preserves the native last-frame fallback with a negative copy PTS; accurate decode drops that frame. An explicit output `-ss 0` also drops negative copy timestamps. Selection and timestamp calculation use bigint and binary search without reading or enumerating a discarded prefix.

At rates of at least 1000 fps, native default stream-info probing leaves initially buffered copy packets with duration zero; subsequent packets have duration one. The default 5,000,000-byte probe cap and 41-packet (below 2000 fps) or 21-packet analysis cap determine that boundary. Any explicit input seek, including zero, flushes that prefetch. This behavior belongs to the CLI execution plan; the standalone rawvideo demuxer continues to return logical one-frame durations. Nondefault probing options are unsupported. Extreme native floating-point timing limits are not certified by the finite test matrix.

## Evidence

Native differential tests compare full output bytes and framecrc text in 3024 scenarios: fourteen formats, 1x1/5x3/8x6 dimensions, three frame rates, copy/rawvideo encoding, six frame-limit profiles and both output formats. Another 324 cases cover defaults, named rates, empty streams, aliases, option precedence, explicit mapping and three-byte physical reads. Unit tests cover odd planes, padded rows, independent ownership, sparse/invalid geometry, large bigint PTS/ranges, preflight budgets, short reads, backpressure, cancellation and staged failures. The actual Node CLI launcher verifies committed frame-limited output and explicit unsupported-filter errors. Local workerd executes odd-sized YUV420P decode/encode with rational framecrc timestamps and three-byte reads; a second case verifies finite NV12 output through local R2 staging and cleanup. No original video FATE case or production Cloudflare video run is certified by this evidence.

Scoped time differential coverage adds 2016 cases across three formats and four rates, plus 1120 microsecond boundary cases across eight slow/fractional/high rates. Another 60 cases exercise probe duration transitions with 200 small frames or a 5.76 MB input crossing the byte probe cap, explicit input seeks and output trimming. These cases compare complete raw output or framecrc text against the fixed native build.

## Component-preserving pixel conversion

The portable `@edge-ffmpeg/swscale` package now exports `canConvertPixelFormat` and `convertVideoFrame`. The first conversion path changes component packing with unchanged dimensions and sample values. RGB24, BGR24, RGBA, BGRA, ARGB, ABGR and GBRP convert within the RGB family. YUV420P, YUVA420P, NV12 and NV21 convert within the 4:2:0 family. Alpha is preserved when available, discarded when absent in the destination, or filled with opaque 255 when absent in the source. GBRP plane order is G, B, R. Odd chroma dimensions use independently rounded-up width and height. Gray (gray8 alias), YUV422P and YUV444P have identity paths; their color/chroma extensions are described below.

`convertVideoFrame(frame, outputPixelFormat, {maxFrameBytes, signal})` validates all source planes and positive padded strides, aggregate input plane storage, output size and timestamp time base before returning one independently owned tight output allocation. It preserves PTS and shallow-copies metadata. Identity conversion also returns owned storage. Negative strides, missing/short planes, unsupported cross-family conversion and oversized input/output are rejected. Cancellation is checked before allocation and within conversion loops. The conversion kernels use independent component-position mappings; no FFmpeg code or Wasm dependency is introduced.

CLI conversion occurs between rawvideo decoding and encoding, after scoped input/output time selection. Muxers validate the output layout and retain declared descriptors for empty streams. Conversion follows the existing staged commit/abort path and awaited per-frame backpressure. Payload reservations are conservative; observed heap, GC, CPU and production Workers measurements remain incomplete.

The new native matrix compares complete raw bytes and framecrc in 2856 cases: 68 input/output pairs, seven odd/even geometries including 15/16/17/33-wide SIMD boundaries, three time/frame profiles, and both output formats. Source patterns contain 0/1/127/128/254/255 and varying component values. Edge reads are physically capped at seven bytes. Another 136 complete-framecrc cases cover converted empty streams, zero-time selection and gray8 aliases. Native default CPU dispatch is retained. Unit tests cover padded planes, ownership, unknown/large PTS, invalid storage, cancellation, expansion budgets, backpressure and staged write failure. The actual CLI launcher checks eight converted outputs. Local workerd checks four scoped conversion paths with three-byte reads and native checksum anchors; local R2 verifies odd NV12-to-YUVA420P output and staging cleanup. These tests do not certify color matrices, range conversion, chroma interpolation, scaling or general swscale compatibility.

## Default color conversion

The converter also supports forty default BT.601 color paths connecting RGB, YUV444 and gray, with gray-to/from-subsampled-YUV luma/range handling. See [numeric behavior and evidence](pixel-color.md). Other color matrices remain incomplete; default forward subsampling and YUV chroma conversion are described below.

## Default chroma conversion

All six declared YUV layouts now interconvert with default bicubic chroma sampling, and RGB inputs can target YUV420/YUV422/NV12/NV21 as well as YUV444. Filter/workspace payload is included in CLI preflight. [Chroma scope and provenance](chroma-resampling.md) records the native fast paths, alpha behavior, resource bounds and inherited component license. Subsampled YUV-to-RGB has [explicit profile restrictions](pixel-inverse.md); same-format gray/YUV/RGB resizing is available.

## Inverse numeric profiles

[Subsampled YUV-to-RGB](pixel-inverse.md) adds aarch64/scalar/x86_64 arithmetic options, preserves fractional chroma through the matrix, and rejects a recorded nondeterministic aligned semiplanar default path before I/O. The scalar profile is selected by CLI -cpuflags 0. This is explicit profile selection, not a hidden execution fallback.

## Linear video filters

The bounded [video filter chain](video-filters.md) supports null, constant-size bicubic scale, declared-format candidate lists, horizontal reflection and vertical reflection. Shared format negotiation retains chroma/alpha conversion boundaries; output sizing follows the explicit chain. Empty whole-filter option strings use defaults. General graphs, timeline expressions, other layouts and arbitrary metadata remain incomplete.

## Fused size and format conversion

Output -s and -pix_fmt now execute a single fused transform for all 196 directed pairs of the fourteen declared formats, with explicit inverse arithmetic profiles. Linear filter chains negotiate output and declared-format candidate lists, including automatic conversion boundaries that preserve chroma and alpha. General graph negotiation remains incomplete. Equal-size conversions retain their existing numeric profiles. See [fused scope and evidence](pixel-resize.md).

Streamcopy output option handling and explicit output-rate rescaling are described
in [finite rawvideo streamcopy](video-streamcopy.md). These options do not enable
general frame-rate conversion in the simple encode path; select the timed/complex
video path for its separately documented synchronization modes.

Finite rawvideo also accepts scoped [timestamp preservation flags](video-copy-ts.md).
They preserve input packet clocks, distinguish forced decoder initialization and
retain Native automatic synchronization startup behavior. Audio/compressed and
nonzero-origin timestamp modes remain outside this implementation scope.
