# IFF (MAUD) demuxer scope

`packages/containers/src/iff.ts` ports the MAUD audio path of `libavformat/iff.c`. It is registered as the demux-only container `iff` (`export {iff} from './iff.js';` in `registry.ts`). Native FFmpeg 9.0.2 has no iff muxer, so `-f iff` is an input format only. The module exports `openIff`, `probeIff`, `iffPacketSpan` and its types. See `packages/containers/NOTICE-IFF`.

## Syntax

```
ffmpeg -i in.maud ...            # detected: FORM at byte 0, MAUD at byte 8
ffmpeg -f iff -i in.bin ...      # forced
```

## Scope

- **Detection.** The head is the four bytes `FORM`, so it overlaps aiff (precedence 30). The probe therefore has precedence 26, which runs before aiff and after nsp (24). Its confirmation reads 12 bytes in reads of at most `maxReadBytes` and requires `MAUD` at byte 8. On a file shorter than 12 bytes it resolves false without reading, as native's zero-padded probe buffer fails. An AIFF or AIFC file, a bare 4-byte `FORM` and every other FORM type (8SVX, 16SV, ILBM...) fail the confirmation and stay with aiff, so `container-registry.test.ts` is unchanged. The `MAUD` check is disjoint from nsp's `DS16` check.
- **Chunk walk.** After the 12-byte FORM header (the FORM size is ignored, as native ignores it), chunks are walked to the physical EOF, as `iff_read_header`'s `while(!avio_feof(pb))` does. Only chunk headers (id plus RB32 size) and the fields used are read. Each chunk is skipped with its odd-size pad byte.
  - `MHDR` (size of at least 32): bits RB16 at +4, rate numerator RB32 at +8, denominator RB16 at +12, channels RB16 at +16 and compression RB16 at +18. The first 20 bytes are read. The rate is `floor(num / den)`. A later MHDR replaces every field, including channels set by CHAN.
  - `MDAT`: the body range. A later MDAT replaces the earlier one, as `body_pos`/`body_end` are reassigned.
  - `CHAN` (size of at least 4, after an MHDR): its RB32 value below 6 gives mono, otherwise stereo.
  - `ANNO`, `TEXT`, `AUTH`, `(c) ` and `NAME` (even when empty) set `info.metadata`. The PCM path then refuses WAV and AIFF output and accepts raw, framecrc and W64, which drop it.
- **Codecs** (`maud_bits`, `maud_compression`): 8/0 `pcm_u8`, 16/0 `pcm_s16be`, 8/2 `pcm_alaw`, 8/3 `pcm_mulaw`. Decoding goes through the existing PCM and G.711 table codecs. The channel mask is null: native sets mono and stereo explicitly and leaves 3 or more channels unspecified, and the CLI guesses the same default layouts (3 channels print `2.1`; tested).
- **Packets.** Native `block_align` is `channels * bits` (bits, not bytes), so `iff_read_packet` reads `min(body_end - pos, 1024 * block_align)` bytes, which is 8192 samples for every codec and layout. `demux.packetSpan` returns 8192. Data comes from `openRawPcm` over the MDAT range, so packets, seeks and timestamps match the other PCM inputs. An odd MDAT that ends the file without its pad byte, and an empty MDAT, are accepted, as native accepts them (tested).
- **Bounded reads.** Every read is at most `maxReadBytes`, and the signal is checked around every await. The MDAT payload and skipped chunks are never read while parsing. `demux.headerBytes` is 32.

## Refusals

Native exit statuses (EdgeFFmpeg uses the same, through `containerRefusal`; neither is errno based):

| Input | Native | EdgeFFmpeg |
|---|---|---|
| MHDR shorter than 32 bytes, rate denominator 0, channels 0 | 183 (`AVERROR_INVALIDDATA`) | 183 |
| CHAN shorter than 4 bytes, or before any MHDR | 183 | 183 |
| no MHDR | 183 | 183 |
| any other bits/compression pair (16/2, 24/0, 8/4...) | 176 (`AVERROR_PATCHWELCOME`) | 176 |

Explicit refusals where native succeeds or the module does not mirror it (`unsupported`, no output is created):

- Every FORM type other than MAUD: 8SVX and 16SV (planar `pcm_s8_planar`/`pcm_s16be_planar` and the 8SVX Fibonacci/exponential codecs; native decodes 8SVX with compression 1, exit 0), ILBM, ANIM, PBM, ACBM, DEEP, RGB8 and RGBN. A non-FORM head and FRM8/DSD.
- Chunks inside a MAUD form that native interprets for other paths: VHDR, ABIT, BODY, DBOD, DSD, DST, CAMG, CMAP, BMHD, ANHD, DPAN, DPEL, DGBL, DLOC, TVDC, SXHD, FVER, DIIN, PROP and COMT.
- A chunk (MDAT or any other) whose body runs past EOF, and a trailing partial chunk header of 1 to 7 bytes.
- A trailing partial sample frame in MDAT (native emits a short last packet).
- A MAUD form without MDAT (native emits an empty stream from offset 0).
- A rate of 0 (num < den) or above 2^31-1, and more than 512 channels.
- Input `-ss` greater than zero (native seeks through `AVFMT_GENERIC_INDEX`, not mirrored).
- Input shorter than the 12-byte FORM header.

## Determinism and arithmetic

Byte copies and integer header arithmetic only (`floor(num / den)`, chunk offsets in bigint). Decoding uses the existing integer PCM and G.711 table codecs. Nothing is platform dependent, so every comparison runs on darwin and linux; there are no linux-gated cases.

## Evidence

Native oracle: `.build/reference/ffmpeg` built in the sandbox on Linux x86_64 from pinned commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8 with `--disable-x86asm` (sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`). The differential file reads `build-metadata.json` and asserts the commit and flag; it pins no binary digest.

- `tests/differential/iff.test.ts` (5 tests, about 6 s). Inputs are synthesized in the test, and native runs at test time.
  - 4 codecs x 1/2/3 channels x 4 variants (22050/1, 44100/3 = 14700, 32000/7 = 4571 with chunks after MDAT, CHAN override), each 2 x 8192 + 77 samples behind an extra chunk: copy framecrc (with the 8192/8192/77 rows checked), decoded framecrc, WAV and raw copy, byte for byte: 192 comparisons.
  - Output `-ss`/`-t`, `-t`, `-ss`, `-frames:a 2` and no options, for u8 and s16be stereo, as copy and as a fixed-volume decode, detected and with `-f iff` over a `.bin` path: 20 comparisons.
  - NAME, ANNO and AUTH chunks: native writes WAV and AIFF (exit 0), EdgeFFmpeg refuses both with no output (6); s16be raw copy, copy framecrc and W64 match native (9): 15 comparisons.
  - Refusals: 9 native statuses matched (176 x 3, 183 x 6) and 8 cases where native exits 0 and EdgeFFmpeg refuses with no output (8SVX compression 1 and 0, forced 16SV, VHDR in MAUD, MDAT beyond EOF, partial frame, no MDAT, input `-ss`): 17 comparisons.
  - Layouts: an odd MDAT without its pad byte, an odd padded MDAT followed by a chunk, an empty MDAT, repeated MHDR and MDAT, a 64-byte MHDR (mulaw) and an empty NAME, each as copy framecrc, decoded framecrc and raw copy: 18 comparisons.
- `tests/unit/iff.test.ts` (7 tests): the chunk walk and its exact read requests under a 7-byte budget, the codec table and 176 refusals, MHDR arithmetic and 183 refusals, CHAN overrides in chunk order, metadata flags, repeated MDAT, every explicit refusal, probe precedence against aiff (AIFF, AIFC and a bare 4-byte FORM detect as aiff), probe read requests, abort before and during opening, and the descriptor fields.

## Proposed contracts

| id | file | title | modes | platforms |
|---|---|---|---|---|
| `iff.demux-outputs` | `tests/differential/iff.test.ts` | `matches native IFF MAUD demux for 4 codecs x 3 layouts through copy and decoded framecrc, WAV and raw output` | semantic, bit-exact, bit-exact-pcm | all |
| `iff.timing` | `tests/differential/iff.test.ts` | `matches native IFF MAUD timing with output seeks, durations and frame limits, detected without -f or an extension` | semantic, bit-exact | all |
| `iff.metadata` | `tests/differential/iff.test.ts` | `refuses IFF NAME metadata for WAV and AIFF output and matches native raw, framecrc and W64 output` | semantic, bit-exact, diagnostic | all |
| `iff.refusals` | `tests/differential/iff.test.ts` | `refuses IFF inputs with the native exit status or explicitly before any output exists` | semantic, diagnostic | all |
| `iff.layouts` | `tests/differential/iff.test.ts` | `matches native IFF MAUD edge layouts: odd MDAT without its pad byte, empty MDAT, repeated MHDR and MDAT, empty NAME for raw` | semantic, bit-exact | all |

## Unsupported

- 8SVX, 16SV, ILBM/ANIM video, DSD/DST (FRM8) and every non-MAUD FORM type.
- Chunks or MDAT past EOF, partial chunk headers and partial trailing frames.
- MAUD without MDAT, zero or oversized rates, more than 512 channels.
- Input `-ss`.
- An iff muxer, which native does not have.
