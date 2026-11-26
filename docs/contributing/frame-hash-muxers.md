# Frame hash muxers (framemd5, framehash)

Output-only per-packet digest muxers, ported from `libavformat/hashenc.c` (`framehash_init`, `framehash_write_header`, `framehash_write_packet`) and `libavformat/framehash.c` (`ff_framehash_write_header`) at the pinned commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`. Module: `packages/containers/src/hash/frame-hash-mux.ts`, registered by two lines in `packages/containers/src/registry.ts` (`export {framehash} ...`, `export {framemd5} ...`). Digests reuse `packages/containers/src/hash/digests.ts`; packet regrouping reuses `planPcmFraming`/`framePcmPackets` from `packages/containers/src/pcm-framing.ts` (PREP-FRAMING). Notice: `packages/containers/NOTICE-FRAMEHASH`.

## Syntax and output

```
ffmpeg [input options] -i <input> [-c:a <pcm codec>|copy] [-af ...] [-ss/-t/-frames:a] [-bitexact|-fflags +bitexact] -f framemd5|framehash <output>
```

| `-f` | `#hash:` | Digest per packet |
|---|---|---|
| `framemd5` | `MD5` | MD5 (HASH_OPT default `md5`) |
| `framehash` | `SHA256` | SHA-256 (HASH_OPT default `sha256`) |

```
#format: frame checksums
#version: 2
#hash: MD5
#software: Lavf63.1.102            (omitted with -bitexact / -fflags +bitexact)
#tb 0: 1/<rate>
#media_type 0: audio
#codec_id 0: <pcm codec>
#sample_rate 0: <rate>
#channel_layout_name 0: <layout>
#stream#, dts,        pts, duration,     size, hash
0, %10d, %10d, %8d, %8d, <lower-case hex>
```

- One row per native packet; no flags column (unlike framecrc), no `#extradata` line and no `, S=` side-data suffix (PCM carries neither).
- Rows come from `ContainerMuxOptions.framing` through `framePcmPackets`, the same boundaries framecrc prints; each packet is hashed incrementally from bounded input views, so no whole packet is buffered. dts = pts = `startPts + emitted`; size = duration × blockAlign.
- Text is written in chunks of at most `maxWriteBytes`; any failure (invalid parameters, framing, packets, timestamps outside int64, cancellation, write failure) aborts the output and never commits.
- Descriptor: `mux` only, `label` = the `-f` name, `defaultCodec:'pcm_s16le'`, `supports:()=>true` (all 20 PCM codecs) and `-c copy`, `dropsMetadata:true` (native writes no tags), `scratchBytes:640`, no extensions (native has none), no `options`.

## Supported and refused forms

Supported: every implemented PCM codec as `-c:a`, `-c copy` from wav and raw inputs, the default codec, `-bitexact` (input or output) and `-fflags +bitexact`, `asetnsamples`/`apad` chains (including `packet_size` and `whole_len`), output `-ss`, `-t`, `-frames:a`, input `-ss`, guessed layouts, unguessed layouts (`-guess_layout_max 0`, printed `N channels`) and named container masks.

Refused before any output exists:

- An unnamed container mask (the PCM path's `channelLayout` is `''`, e.g. WAVE_FORMAT_EXTENSIBLE mask `0x30` on 2 channels, which native prints as `2 channels (BL+BR)`): `Unknown channel mask for framemd5|framehash output`, exit 1, as framecrc.
- `-hash <name>` and `-format_version <n>`: the CLI parser refuses both first (`invalid-arguments`, `Unsupported option: -hash|-format_version`). `validate` also refuses any format option (`The <muxer> muxer <option> option is not implemented`), so enabling the CLI entries alone would not silently ignore a value. Native accepts both (`#hash: SHA256`, `#hash: CRC32`, `#version: 1` were probed).
- `atrim` chains: EdgeFFmpeg has no atrim filter (`unsupported-filter`); native accepts them. This is outside the muxer.

## Determinism and arithmetic profile

Integer text formatting, MD5/SHA-256 and bigint timestamps only; no floating point in the muxer, so every comparison runs on darwin and linux. Float codecs (`pcm_f32*`, `pcm_f64*`) are produced by the existing integer-exact encoders from s16 input. No linux-gated cases.

## Evidence (sandbox reference build, linux x64)

`tests/differential/frame-hash-muxers.test.ts` (4 tests, about 7 s on 4 vCPUs), native run at test time, byte-exact text comparison:

1. 756 comparisons: {raw s16le, bitexact wav} × channels {1,2,6} × rates {8000,44100,48000} × (20 PCM codecs + copy) × 2 muxers, 2500 samples (a partial final packet), default (non-bitexact) header.
2. 52 comparisons over 26 profiles × 2 muxers: `-bitexact`, `-fflags +bitexact`, input `-bitexact`, `asetnsamples=n=300:p=0`, `asetnsamples=n=777` (padded) to `pcm_s32be`, `apad` (pad_len, pad_len+packet_size, whole_len to `pcm_u8`), two asetnsamples/apad chains (one with `-t`), output `-ss`, `-t`, `-ss`+`-t` to `pcm_f32le`, `-frames:a` (with and without asetnsamples), input `-ss` with `-t`, raw copy with `-t`, wav copy, wav copy with `-ss -t -bitexact`, wav decode, wav apad, raw `-c copy` of u8, s24be, f32le, f64be and mulaw.
3. 26 comparisons and 6 refusals: guessed layouts at 3/4/5/7/8 channels, `-guess_layout_max 0` at the same counts (`N channels`), WAV masks `2.1`, `5.1(side)` and `quad`; refusal of unnamed masks `0x30` (2 ch) and `0x13` (3 ch) and `0x3f000` (6 ch), with native's description asserted.
4. 10 refusals: `-hash sha256`, `-hash crc32`, `-format_version 1` and two atrim chains per muxer, each accepted by native (exit 0) and refused by EdgeFFmpeg with no output file.

`tests/unit/frame-hash-mux.test.ts` (6 tests): descriptor fields and registry lookup; exact header text with the reference, EdgeFFmpeg and bitexact software lines; rows and digests (checked against node:crypto) for span + firstPacketSamples + startPts across four chunkings and write budgets 1, 7 and 4096; sections and packet schedules; every refusal (options, empty layout, parameters, framing, sections, time base, stream index, non-contiguous, unaligned, short input, int64 overflow) with abort and no commit; cancellation before and during writing, failed writes and failed aborts.

Sandbox reference: `.build/reference/ffmpeg` sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c` (unpinned sandbox build, `--disable-x86asm`, commit 946fcce0), `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`, Node v24.22.3.

## Proposed contracts

| id | file | name | modes | platforms |
|---|---|---|---|---|
| `muxer.framehash-family.pcm` | `tests/differential/frame-hash-muxers.test.ts` | `matches native framemd5 and framehash text for wav and raw inputs at every channel count rate and PCM codec and stream copy` | semantic, bit-exact | all |
| `muxer.framehash-family.profiles` | same | `matches native frame hash text with bitexact flags, regrouping filter chains, output time and frame limits and copy` | semantic, bit-exact | all |
| `muxer.framehash-family.layouts` | same | `matches native guessed, unguessed and named container layouts and refuses an unnamed container mask before any output exists` | semantic, bit-exact | all |
| `muxer.framehash-family.option-refusal` | same | `refuses -hash, -format_version and atrim chains before any output exists while native accepts them` | semantic | all |

## Unsupported

- `-hash` and `-format_version` values (CLI parser refusal; `packages/cli` is not owned here). With a CLI entry, `md5`, `sha160`, `sha224`, `sha256`, `crc32` and `adler32` could be served from `digests.ts`, and `-format_version 1` only drops the side-data suffix, which PCM never has.
- Unnamed container masks (as framecrc).
- `atrim` (no filter module).
- Video, FLAC input (the FLAC output dispatcher does not iterate the registry), multiple streams, extradata and side data.

## Side effect

The registry's generic output listing now reads `WAV, AIFF, AU, W64, framecrc, crc, framehash, framemd5, hash, IRCAM, md5, RSO, SoX, streamhash` (unordered muxers by name). `tests/unit/hash-digests.test.ts` and the container registry tests pass unchanged.
