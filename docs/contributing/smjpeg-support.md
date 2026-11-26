# SMJPEG (Loki SDL MJPEG) muxer scope

`packages/containers/src/smjpeg.ts` registers `smjpeg` (`export {smjpeg} from './smjpeg.js';` in `registry.ts`) as a mux-only descriptor. It ports the audio path of `libavformat/smjpegenc.c`, with the magic and chunk tags of `smjpeg.h` and the `pcm_s16le` entry of `ff_codec_smjpeg_audio_tags` in `smjpeg.c`, at the pinned commit `946fcce0`. See `packages/containers/NOTICE-SMJPEG`. The module also exports `muxSmjpeg`, `validateSmjpegOutput`, `supportsSmjpegCodec`, `smjpegHeader`, `smjpegDuration`, `smjpegMilliseconds`, `smjpegRescale` and `smjpegScratchBytes`. Nothing is added to the package barrel, and the chunk tables stay private.

## Syntax

```
ffmpeg -f s16le -ar 44100 -ac 2 -i in.raw [-c:a copy|-af ...] [-ss T] [-t T] [-frames:a N] [-bitexact] -f smjpeg out.smjpeg
```

- `-f smjpeg` is required. Native has no output extension for this muxer, and neither has the descriptor, so `out.smjpeg` without `-f` is refused (native refuses it too).
- The default and only codec is `pcm_s16le`, encoded or copied.

## Output layout

All integers are big-endian unless noted. Chunk tags are written as `MKTAG` with `avio_wl32`, so they appear in reading order.

| Bytes | Content |
|---|---|
| 8 | `"\0\nSMJPEG"` |
| 4 | version 0 |
| 4 | duration in ms (see below) |
| 30 | `_TXT`, size 22, `encoder = Lavf63.1.102` (absent with `-bitexact`) |
| 16 | `_SND`, size 8, rate as BE16 (low 16 bits, so 96000 is written as 30464 and 65536 as 0), bits 16, channels u8, `NONE` |
| 4 | `HEND` |
| per packet | `sndD`, pts in ms (BE32), size (BE32), the PCM bytes |
| 4 | `DONE` |

- **Packet boundaries** are the native packets of the selected range. The muxer regroups the PCM path's chunks with `planPcmFraming` and `framePcmPackets` from `pcm-framing.ts` (the shared PREP-FRAMING API), without buffering a whole packet. The framing is validated before the first byte: block align must be `2 x channels`, the sample count must equal the stream's, and the start pts must be non-negative.
- **Timestamps.** `pts_ms = av_rescale_rnd(pts, 1000, rate, NEAR_INF)` (half away from zero; the `PASS_MINMAX` part only affects `AV_NOPTS_VALUE`), `duration_ms` the same, as `av_packet_rescale_ts` does from the encoder time base 1/rate to the muxer's 1/1000. The pts word keeps the low 32 bits.
- **Duration field.** Native seeks back in `write_trailer` and writes `max(pts_ms + duration_ms)` over all packets, kept in a `uint32_t`. The output here is sequential, so `smjpegDuration` computes the same value up front by running `framePcmPackets` over a synthetic zero stream of at most 4096-byte chunks with the same framing. For 4096 + 904 samples at 44100 Hz the rows are pts 0 and 93 and the duration is 113 (93 + 20).
- Writes are chunked to `maxWriteBytes`, the signal is checked around every await, and the output is aborted exactly once on any failure. `scratchBytes` is 128 (66-byte header, 12-byte packet header, 4-byte trailer).

## Supported vs refused

Supported, byte-exact with native: `pcm_s16le` encode or `-c copy`, 1 to 255 channels, any rate the PCM path accepts (the header keeps the low 16 bits), with or without `-bitexact`, audio filter chains such as `asetnsamples` and `apad`, and output `-ss`, `-t` and `-frames:a`.

Refused before any output exists:

- **Other codecs** (`pcm_s16be`, `pcm_u8`, `pcm_s24le`, ..., including `-c copy` of such an input): `containerRefusal('SMJPEG muxer does not support <codec>', 234)`. Native fails in `write_header` with `unsupported audio codec`, `AVERROR(EINVAL)`. The differential test reads the host's `EINVAL` from `os.constants.errno` for native and expects the Linux value 234 from EdgeFFmpeg.
- **Inputs with global metadata** (`info.metadata`, for example a NIST SPHERE extra key). Native writes each tag as a `_TXT` chunk; the PCM path carries no tags, so the descriptor leaves `dropsMetadata` unset and the PCM path refuses with `Input metadata for the SMJPEG muxer is not implemented`.
- **More than 255 channels**: native's `avio_w8` truncates the count; unprobed, so refused as unimplemented.
- Invalid framing, write budgets, packets outside the 1/rate time base, a short input (`Smjpeg sample count mismatch`), and aborts.

Not in scope: the smjpeg demuxer, video (`_VID`/`vidD`, MJPEG), ADPCM IMA SMJPEG audio, non-seekable native output (duration 0), and FLAC input (the FLAC output dispatcher does not iterate the registry).

**Known gap outside this module.** The shared WAV demuxer (`wav.ts`) does not set `info.metadata` for `LIST`/`INFO` tags. Native copies such tags into SMJPEG `_TXT` chunks (probed: `title = x` for a WAV written with `-metadata title=x`), but EdgeFFmpeg accepts the input and writes no `_TXT` chunk for it. Fixing it needs a shared edit to `wav.ts` (reported in the wave-2 report); until then tagged WAV input to `-f smjpeg` differs from native. The same applies to every muxer that writes tags.

## Determinism and arithmetic profile

Integer rescaling (bigint) and byte copies only. No floating point is involved, so every comparison runs on darwin and linux; there are no linux-gated cases. Native `u8 -> s16le` conversion in the matrix is an integer path.

## Evidence

Sandbox reference: `.build/reference/ffmpeg` built from `946fcce0` with `--disable-x86asm`, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c` (unpinned sandbox build, linux-x64), `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`. Node v24.22.3.

- `tests/unit/smjpeg.test.ts` (6 tests): header bytes with and without the text chunk, rate and duration truncation; a 20-row ms rounding table with half-way cases at 8000, 2000 and 48000 Hz and negative values; regrouping of irregular input chunks (4096 + 904 samples: rows 0/93, duration 113), a short first packet with a start offset, and a packet schedule; chunked writes at `maxWriteBytes` 5 with identical bytes; refusals (codecs with 234, 256 channels, parameters, framing, budget, time base, unaligned and short input, pre- and mid-stream abort) with exactly one abort and no commit; descriptor fields.
- `tests/differential/smjpeg.test.ts` (4 tests, about 10 s on 4 vCPUs):
  - the reference identity check (commit `946fcce0`, `--disable-x86asm`);
  - 324 byte-exact outputs: 1, 2 and 6 channels x 8000, 11025, 44100, 48000, 65536 and 96000 Hz x 1, 4097 and 10000 samples x `-c copy`, s16le encode and u8-to-s16le encode x with and without `-bitexact`;
  - 72 byte-exact outputs: 4 rate and layout pairs x 18 profiles (`asetnsamples=n=7|1000|4:p=0`, `asetnsamples=n=333:p=1`, `apad=pad_len`, `apad=whole_len`, chains, output `-ss`, `-t`, `-frames:a`, and their combinations, encoded and `-c copy`);
  - refusals: 5 codec cases (encode to s16be, u8, s24le; copy of s16be and u8 input) with native status `EINVAL` and EdgeFFmpeg 234 and no output; a tagged NIST SPHERE input (native writes `_TXT database_id = hello`, EdgeFFmpeg refuses); and no extension selection (native and EdgeFFmpeg both fail).

## Proposed contracts

| id | file | title | scope | platforms |
|---|---|---|---|---|
| `muxer.smjpeg.bytes` | `tests/differential/smjpeg.test.ts` | `matches native SMJPEG bytes for 3 layouts x 6 rates x 3 lengths x copy/encode x bitexact` | pcm_s16le header, sndD chunks and duration field, copy and encode | all |
| `muxer.smjpeg.framing` | `tests/differential/smjpeg.test.ts` | `matches native SMJPEG packet regrouping through asetnsamples and apad chains and output -ss, -t and -frames:a` | native packet boundaries and ms timestamps | all |
| `muxer.smjpeg.refusals` | `tests/differential/smjpeg.test.ts` | `refuses SMJPEG codecs other than pcm_s16le with the native status and tagged inputs before any output exists` | EINVAL codec refusals, metadata refusal, no extension | all |
