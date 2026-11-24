# Berkeley/IRCAM/CARL container scope

`packages/containers/src/ircam.ts` registers `ircam` (`export {ircam} from './ircam.js';` in `registry.ts`) for demux and mux. It ports `libavformat/ircam.c`, `ircamdec.c` and `ircamenc.c`, the packet span of `pcm.c` and `av_q2intfloat` from `libavutil/rational.c`, at the pinned commit `946fcce0`. See `packages/containers/NOTICE-IRCAM`. The module also exports `openIrcam`, `muxIrcam`, `validateIrcamOutput`, `supportsIrcamCodec`, `ircamRate`, `ircamRateBits` and `ircamPacketSpan`. Nothing is added to the package barrel. The tag tables stay private.

## Demux

- **Header.** The 16-byte header is read in bounded reads of at most `maxReadBytes`, with the signal checked around every await. Bytes past EOF read as zero, as `avio_rl32` does. PCM starts at byte 1024 and runs to EOF. A file shorter than 1024 bytes has zero samples. Packets come from `openRawPcm`, so seeks, packet budgets and timestamps behave as for every other PCM input.
- **Magic.** All seven magics of native's table are accepted. The magic is read little-endian. Then rate, channels and tag are read LE for 0x64A30200, 0x64A30400, 0x0001A364 and 0x0003A364, and BE for 0x64A30100, 0x64A30300 and 0x0002A364.
- **Tags.** alaw 0x10001, mulaw 0x20001, s8 1, s16 2, s24 3, s32 0x40004, f32 4, f64 8. The field endianness selects the `le` or `be` codec. `ff_codec_get_id`'s `ff_toupper4` second pass cannot match any of these tags, so it is not ported.
- **Rate.** The rate is `lrintf` of the float32 field: round half to even, so 22050.5 gives 22050 and 22051.5 gives 22052. Results of 0 (for example 0.5) are refused as native does.
- **Refusals with native exit statuses, in native order:**
  - an unknown magic, zero channels or a zero rate: `INVALIDDATA` (183);
  - more than 512 channels (`FF_SANE_NB_CHANNELS`): `ENOSYS` (218). `AVERROR(ENOSYS)` exits with `-ENOSYS & 255`, which depends on the host's errno table: 218 on Linux, 178 from the macOS arm64 reference (ENOSYS is 78 there). EdgeFFmpeg always uses the Linux value, and the differential test maps the host's status through `os.constants.errno.ENOSYS` (integration fix);
  - an unknown tag (`unknown tag <hex>`): 183.
- **Refused as unimplemented (exit 1):**
  - non-finite rates, and rates that round to 2^31 or more, or below -2^31. `lrintf` overflow differs between x86_64 and arm64.
  - negative rates. Native accepts them and then fails in the decoder or muxer.
  - channel counts of 2^31 or more. Native's int conversion turns them negative.
  - a trailing partial sample frame.
- **Detection** mirrors `ircam_probe` exactly, at precedence 100:
  - the head `64 A3 0x 00` with x from 1 to 4 matches on its own;
  - the head `00 0x A3 64` with x from 1 to 3 matches when the 32-bit words at bytes 4 and 8 are both nonzero. `confirm` reads only those 12 bytes.
  - Magic 0x64A30400 has no probe head and needs `-f ircam`. Native also scores the `.sf`/`.ircam` extension at 1, but any other demuxer with a positive probe score wins over that, so whether the extension works depends on the payload. The extension fallback is therefore not mirrored, and undeclared 0x64A30400 input is refused as an unsupported signature.
- **Packet span.** The packet span is `ff_pcm_default_packet_size`: `rate/10`, clipped to `[1, INT_MAX/block_align]`, then floored to a power of two. Seeks to or beyond EOF are refused as unimplemented (`seekBeyondEnd` is not set).
- **Metadata.** The demuxer exports no metadata.

## Mux

- **Header.** The 1024-byte header is the magic 0x0001A364 LE, the `av_q2intfloat(rate/1)` word, then channels and the LE tag, padded with zeros. `av_rescale` rounds half away from zero, so 16777217 Hz writes 0x4B800001 (a float32 cast would round to even). The header goes out in `maxWriteBytes` chunks. The payload then goes to `muxRawPcm` through a wrapping writer, so the output is aborted at most once on any failure.
- **Codecs and selection.** The default codec is `pcm_s16le`. Only the eight LE-table codecs are written. `pcm_s16be` and the other BE codecs, `pcm_u8`, `pcm_u16*`, `pcm_u24*` and `pcm_u32*` are refused with `IRCAM muxer does not support <codec>` and exit 234 (`EINVAL`), before any output exists. Native creates an empty output file in that case. `.sf` and `.ircam` select the muxer.
- **Metadata.** `dropsMetadata` is set, because `ircam_write_header` writes no tags.

## Evidence

Linux x86_64 oracle `.build/reference/ffmpeg`, built from the pinned commit, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`.

`tests/differential/ircam.test.ts` (6 tests):

- **Mux.** 480 whole-file byte comparisons with native `-bitexact -f ircam`: 8 codecs × channels {1,2,5} × rates {8000, 22050, 44100, 96000, 16777217} × lengths {0, 1, 67, 4097}. A further 96 Edge demux comparisons of native files against native's `-c:a copy -f <raw>` output.
- **Demux.** Synthesized headers for all 7 magics × 8 tags (both LE and BE variants) × channels {1,2,5}, each compared three ways: copy framecrc, `-cpuflags 0` WAV decode and raw copy (504 comparisons). Seven more compare undeclared detection of `.bin` files, where native returns 183 for 0x64A30400, and seven compare `-f ircam` copy framecrc.
- **Timing.** 32 framecrc comparisons: 4 codecs × 4 seek, duration and frame-limit profiles × copy or a fixed volume/asetnsamples/asetrate chain.
- **Float rate.** 21 rates × 2 magics (LE and BE): ties, fractions, 2^24, 2^25+4, 2147483520 and non-representable values. The whole framecrc, including `#sample_rate`, is compared.
- **Refusals.** The native exit status of 8 inputs (unknown LE and BE tag, 0 and 513 channels, rate 0.5 and 0, an unknown magic, an 8-byte file) and of 7 mux codecs (`pcm_s16be`, `pcm_u8`, `pcm_u16le`, `pcm_f32be`, `pcm_s24be`, `pcm_s32be`, `pcm_f64be`; all 234). In every case no Edge output exists.
- **FATE lavf-ircam.** `asynth1.sw` is generated by compiling the upstream `tests/audiogen.c` at test time. The Edge output's md5 and size match `tests/ref/lavf/ircam`, and the Adler-32 of its decode matches the reference `CRC=0x3a1da17e`. `-metadata title=lavftest -qscale 10` is dropped from the Edge command, because the ircam muxer writes no metadata. The test also checks that native with those options produces the same md5.

`tests/unit/ircam.test.ts` (7 tests) covers:

- the magic and endianness table, both tag tables, bounded 1-byte header reads and seeks;
- `lrintf` and `av_q2intfloat` vectors, and the platform-dependent refusals;
- native-order refusals with exit statuses;
- probe heads and the 12-byte confirm, with no extension detection;
- the header layout, chunked writes, abort-once and cancellation;
- the descriptor fields and packet-span vectors.

The registry tests `tests/unit/container-registry.test.ts` and `container-registry-extension.test.ts` pass unchanged.

## Unsupported

- Detection of 0x64A30400 or other unprobed input by the `.sf`/`.ircam` extension.
- Non-finite, out-of-range or negative float rates, and channel counts of 2^31 or more.
- Input seeks at or beyond EOF.
- BE, unsigned and non-PCM output codecs.
- FLAC input to the ircam muxer, which the FLAC output dispatcher does not route.
- Unknown-length or pipe output.
- Workers-runtime tests and macOS arm64 comparisons. All evidence here is from Linux x86_64.
