# Creative Voice (VOC) container scope

`packages/containers/src/voc.ts` registers `voc` (`export {voc} from './voc.js';` in `registry.ts`) for demux and mux, covering `demuxer.voc` and `muxer.voc`. It ports `libavformat/voc.c` (`ff_voc_magic`, `ff_voc_codec_tags`), `voc.h`, `vocdec.c`, `voc_packet.c` (`ff_voc_get_packet`) and `vocenc.c` at the pinned commit `946fcce0`. See `packages/containers/NOTICE-VOC`. The module also exports `openVoc`, `muxVoc`, `validateVocOutput`, `supportsVocCodec`, `vocProbeScore`, `vocBlockRate`, `vocFileHeader` and `vocFirstBlockHeader`. Nothing is added to the package barrel, and the tag table stays private.

## Syntax

```
ffmpeg -i in.voc ...                 # detected by magic (score-100 files only)
ffmpeg -f voc -i in.voc ...          # any header version check
ffmpeg -i in.wav [-c:a pcm_u8|pcm_s16le|pcm_alaw|pcm_mulaw|copy] out.voc
ffmpeg -i in.wav -f voc out.bin
```

## Demux

- **Header.** The 26-byte header is read in bounded reads (at most `maxReadBytes` each, the signal checked around every await). Bytes past EOF read as zero, as `avio_rl16` does. The header size word at byte 20 must be 26 (`avio_rl16 - 22 == 4`). Otherwise the input is refused with `unknown header size: <n>` and `AVERROR(ENOSYS)`. EdgeFFmpeg exits 218, the Linux value. The differential test maps the host's native status through `os.constants.errno.ENOSYS` (macOS gives 178). The version and check words are not validated, as in `voc_read_header`.
- **Blocks.** Every block header is read before any sample is returned. One accepted layout is mirrored:
  - an optional type-8 block (exactly 4 bytes: rate word, ignored codec byte, channels-1), only immediately before a type-1 block;
  - one voice block: type 1 (time constant, codec tag) or type 9 (RL32 rate, bits, channels, RL16 codec tag, 4 reserved bytes);
  - any number of type-2 continuation blocks;
  - a type-0 terminator, or EOF (native `avio_r8` reads 0 at EOF). Bytes after the terminator are ignored.
- **Rates.** Type 1 gives `1000000/(256-tc)`. With a preceding type-8 block it gives `256000000/(channels*(65536-sr))`, and the channel count is `byte+1`. That divisor is at most 2^24, so the type-8 rate is never 0 and the type-1 fallback in `ff_voc_get_packet` is unreachable. Type 9 gives its RL32 rate, which must be 1..INT_MAX. All arithmetic is integer division.
- **Codecs.** The tags are 0 `pcm_u8`, 4 `pcm_s16le`, 6 `pcm_alaw` and 7 `pcm_mulaw`. ADPCM tags 1, 2, 3 and 0x200 are refused as unimplemented. Other tags are refused with `unknown codec tag`, exit 1.
- **Packets.** Native packets are `min(block remaining, 2048)` bytes and never cross blocks. Only layouts with one uniform packet span are accepted. Every block except the last holds the same payload P, with either P ≤ 2048 (and the last block holds at most P) or P % 2048 == 0. P, the last payload and the span must all be multiples of the block alignment, so 2048-byte packets with 3 or 6 bytes per frame are refused. `packetSpan` returns `min(P, 2048)/blockAlign`, and Edge's chunks never cross blocks. Native packet timestamps are cumulative samples in 1/rate, which this matches.
- **Copy.** A type-1 block leaves `bits_per_coded_sample` at 0, and a type-9 block carries its own bit width. A VOC muxer writes that width into a type-9 header. `-c copy` is therefore refused (through `copyRefusal`) for type-1 input with a non-u8 codec, and for type-9 input whose bits differ from the codec's width (16 for s16le, 8 otherwise). Decoding these inputs is unaffected.
- **Refused (exit 1):** blocks of size 0 (native reads them to EOF); empty voice payloads; repeated type-1 or type-9 blocks, which would carry mid-stream codec or rate changes; type-8 blocks anywhere else, or of another size; types 3 to 7 and anything above 9; continuation blocks before the voice block; truncated blocks and block headers; files with no voice block; zero type-9 channels; input `-ss` > 0 (native seeks through `voc_read_seek`'s index); and files whose version check fails, when no `-f voc` is given.
- **Detection.** The head is `Crea`. `confirm` reads the 26 bytes `voc_probe` inspects and claims only the score-100 case: the 20-byte magic plus `~version + 0x1234 == check` in int arithmetic. Native scores a failed check at 10 and still detects such files; Edge refuses them undeclared (`Unsupported audio container signature`). With `-f voc` they open normally. The precedence is 100, an exact magic that no other head overlaps.
- **Metadata.** The demuxer exports none.

## Mux

- **Header.** The magic, the header size 26, version 0x0114 and check 0x111F (`~0x0114 + 0x1234`).
- **First packet.** The first packet's size comes from `framing`. Codec tags above 3 (s16le, alaw, mulaw) write a type-9 block: size+12, the rate, bits 16/8/8 (the PCM encoder's and the WAV/raw demuxers' `bits_per_coded_sample`), channels, the tag and 4 zero bytes. `pcm_u8` writes a type-1 block with the time constant `(256 - (1000000 + rate/2)/rate) & 255`. When multichannel, that block is preceded by a type-8 block with the word `(65536 - (256000000 + rate*ch/2)/(rate*ch)) & 0xffff`, tag 0 and ch-1.
- **Later packets.** Each later packet is a type-2 block with its 24-bit size. The trailer is a single 0 byte. With zero samples, the file is the header plus the terminator.
- **Packet boundaries.** `planPcmFraming(framing,'voc')` validates the boundaries before anything is written. `framePcmPackets` regroups the input to the native packet boundaries (decoder frames, `asetnsamples` frames, copy packets) without buffering a whole packet. Each block header is written at the first piece of its packet, when the packet's duration is known.
- **Codecs.** The default codec is `pcm_s16le`. `pcm_u8`, `pcm_s16le`, `pcm_alaw` and `pcm_mulaw` are written. Others are refused with `unsupported codec` and exit 234 (`EINVAL`) before any output exists, as native's `voc_write_header` does. `.voc` selects the muxer. `dropsMetadata` is set, because the muxer writes no tags.
- **Refused (exit 1):** more than 255 channels; `pcm_u8` multichannel with rate×channels above INT_MAX, which overflows int in `vocenc.c`; and packets above the 24-bit block size (native truncates the size field). The last of these is detected at the packet's first piece, and the output is aborted.

## Determinism and arithmetic profile

Integer block arithmetic and byte copies only, with no floating point. Every case runs on darwin and linux, and no case is linux-gated.

## Evidence

Linux x86_64 oracle `.build/reference/ffmpeg`, built in the sandbox from `946fcce0` with `--disable-x86asm`, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`. Compiler: `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`. The differential test reads `build-metadata.json` and asserts the commit and the flag, and never pins the binary digest.

`tests/differential/voc.test.ts` (3 tests, about 7 s):

- **Mux (180 whole-file byte comparisons).**
  - 4 codecs × 1/2 channels × 1/777/5000 samples, three ways each: `-c copy` from a native WAV in that codec, re-encoding from s16le WAV, and declared raw input with `-f voc`.
  - For 5000 samples, six more each: `asetnsamples=n=700:p=0` (asserted to differ from the default framing), `apad=pad_len=333`, `asetnsamples=n=300:p=0,apad=whole_len=6100`, output `-ss 0.05 -t 0.3`, and copy with `-frames:a 2` and with `-t 0.2`.
  - 5 rates (3000, 11025, 22050, 44100, 48000) × 1/2/3 channels × 4 codecs. These cover the time-constant wrap and the type-8 word.
- **Demux (264 comparisons).** 47 files:
  - native-muxed from raw at 11025 Hz and from WAV at 44100 Hz (4096-byte blocks demuxed as 2048-byte packets);
  - hand-built type-9 files with 300/300/300/200-frame blocks at 1/2/3 channels, and 4096/4096/5000-byte blocks;
  - single-block type-1 files, type-8 stereo plus type-1 files with a terminator and trailing bytes, a file with a failed version check (`-f voc`), type-8 rate word 0, and type-9 u8.
  
  Each file is compared through decoded framecrc, `-bitexact` WAV, and `asetnsamples=n=500:p=0` with `-t 0.1` framecrc. Copyable files are also compared through copy framecrc, raw copy and VOC copy. For the 6 type-1 non-u8 files, Edge's copy refusal is checked with no output created.
- **Refusals (12).**
  - Header sizes 0, 22, 25, 27 and 0x1a00: native exits with the host's ENOSYS status, Edge with 218.
  - `pcm_s24le`, `pcm_s8`, `pcm_s16be`, `pcm_f32le` and `pcm_u16le` mux: 234 on both sides, with no Edge output.
  - Native exits 0 for input `-ss` and for an undeclared score-10 file. Edge refuses both with exit 1 and no output.

`tests/unit/voc.test.ts` (7 tests) covers:

- block parsing with 1-byte bounded reads, the rate formulas, packet slicing and seeks;
- the uniform-span rule and every refusal;
- probe scores and detection;
- the header, first-block and continuation words, including the wraps;
- framing-driven muxing with chunked writes and an empty output;
- abort-once and cancellation;
- the descriptor fields and the seek refusal.

The registry tests `tests/unit/container-registry.test.ts` and `container-registry-extension.test.ts` pass unchanged.

## Proposed contracts

| id | file | title | scope | platforms |
|---|---|---|---|---|
| `voc.bitexact-mux` | `tests/differential/voc.test.ts` | matches native VOC mux bytes from WAV and raw input for 4 codecs x 2 layouts with copy, re-encode, packet regrouping and output time limits | 180 whole-file mux comparisons | all |
| `voc.demux` | `tests/differential/voc.test.ts` | matches native VOC demux of native-muxed and hand-built files through copy and decoded framecrc, WAV and raw | 264 demux comparisons over 47 files | all |
| `voc.refusals` | `tests/differential/voc.test.ts` | refuses VOC inputs and outputs with the native exit status before any output exists | ENOSYS header sizes, 234 codec refusals, Edge-only seek and score-10 refusals | all |

## Unsupported

- ADPCM codecs (tags 1, 2, 3, 0x200) and unknown tags.
- Block layouts without one uniform packet span: size-0 blocks, empty voice blocks, mid-stream codec or rate changes, and block types 3 to 7.
- Input `-ss`, and undeclared detection of files whose version check fails.
- `-c copy` of type-1 non-u8 input, or of type-9 input with a non-native bit width.
- More than 255 output channels, `pcm_u8` multichannel rate×channels above INT_MAX, and packets above the 24-bit block size.
- FLAC input to the voc muxer, which the FLAC output dispatcher does not route.
- Unknown-length or pipe output.
- Workers-runtime tests and macOS arm64 comparisons. All evidence here is from Linux x86_64.
