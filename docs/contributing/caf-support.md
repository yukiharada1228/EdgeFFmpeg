# Apple Core Audio Format (CAF) muxer scope

`packages/containers/src/caf.ts` registers `caf` (`export {caf} from './caf.js';` in `registry.ts`) as a mux-only descriptor. It ports `libavformat/cafenc.c`, the PCM and G.711 rows of `ff_codec_caf_tags` (`caf.c`) and `mov_channel_layout`/`ff_mov_write_chan` (`isom.c`) at the pinned commit `946fcce0`. See `packages/containers/NOTICE-CAF`. The module also exports `muxCaf`, `validateCafOutput`, `supportsCafCodec` and `cafChannelLayout`. Nothing is added to the package barrel; the codec and layout tables stay private. `demuxer.caf` is a follow-up on the same module.

## Syntax

- `-f caf out.bin`, or any output path ending in `.caf` (case-insensitive), selects the muxer.
- Without `-c`, the codec is `pcm_s16be` (native `audio_codec`).
- `-c:a <codec>` with any supported codec below, or `-c:a copy` from an input whose codec is supported.
- `-bitexact` drops the `info` chunk. No format-specific output options exist.

## Output layout

Every multi-byte field is big-endian except the format ID, which `avio_wl32` writes as its four characters.

| Bytes | Content |
|---|---|
| 8 | `caff`, `mFileVersion` 1, `mFileFlags` 0 |
| 12 + 32 | `desc`: the sample rate as an IEEE double, format ID (`lpcm`, `alaw` or `ulaw`), `codec_flags`, bytes per packet = `block_align` (channels × bytes per sample), frames per packet 1, channels, `av_get_bits_per_sample` |
| 12 + 12 | `chan`, written only for a native-order layout (`stream.layoutMask` not null): `mChannelLayoutTag` from the first matching `mov_channel_layout` row with bitmap 0, or else tag `0x10000` with the mask truncated to 32 bits as the bitmap; then 0 channel descriptions |
| 12 + 25 | `info`, written only without `-bitexact`: one entry, `encoder\0Lavf63.1.102\0` |
| 12 + 4 | `data`: size = payload + 4 (what the trailer seeks back to write), edit count 0 |
| … | the payload, unchanged |

`codec_flags` is 0 for integer BE, s8 and G.711, 1 for float BE, 2 for integer LE and 3 for float LE. PCM has `samples_per_packet` 1 and a nonzero `block_align`, so the trailer writes no `pakt` chunk and the bytes never depend on packet boundaries. The header is at most 129 bytes (`scratchBytes`).

Layouts: the PCM path's `layoutMask` is the input's container mask, or else the default layout for the channel count when the layout is guessed (`-guess_layout_max` at least the channel count, the default). It is null for an unknown layout (`-guess_layout_max` below the channel count, or a channel count with no default layout), which native leaves `AV_CHANNEL_ORDER_UNSPEC`, so no `chan` chunk is written. Probed tags: mono `0x00640001`, stereo `0x00650002`, 2.1 `0x00850003`, 5.1 `0x00790006`; 6.1 (`0x70F`) and FL+FR+BL (`0x13`) use the bitmap. Table order matters: stereo is 101 (not 102), quad 132 (not 108), 5.0/5.1 back and side share 117/121.

## Supported and refused

- **Written:** `pcm_s8`, `pcm_s16le/be`, `pcm_s24le/be`, `pcm_s32le/be`, `pcm_f32le/be`, `pcm_f64le/be`, `pcm_alaw`, `pcm_mulaw`, by re-encoding or `-c copy`, 1 to 65535 channels, integer rates 1 to 2^31-1.
- **Refused with native's status:** `pcm_u8`, `pcm_u16*`, `pcm_u24*` and `pcm_u32*` have no `ff_codec_caf_tags` entry. `caf_write_init` fails with `AVERROR_INVALIDDATA` (exit 183, not errno-based); EdgeFFmpeg throws `containerRefusal('CAF muxer does not support <codec>', 183)` before any output exists. Native leaves an empty output file.
- **Refused as unimplemented:** inputs whose demuxer exports metadata (`info.metadata`; `dropsMetadata` is not set, since `caf_write_header` writes `s->metadata`), so `-metadata` tags and inputs flagged with `info.metadata` never reach the `info` chunk (the WAV `LIST`/`INFO`, AIFF `NAME`/`ANNO` and AU annotation tags of the pre-registry demuxers are not flagged: see Known divergence); a layout mask whose bit count differs from the channel count; a data size beyond 2^63-1.
- **Not reachable:** non-PCM codecs (ADPCM, AAC, ALAC, Opus, …, which would need `pakt`/`kuki`), FLAC input (the FLAC output dispatcher does not route registered muxers), unknown-length or pipe output (native writes `data` size -1 there), and CAF input.

## Determinism and arithmetic profile

Integer fields only; the rate double is exact for every integer rate. The payload is the PCM path's encoder output or the copied packets. No platform-dependent arithmetic, so every comparison runs on darwin and linux; no case is linux-gated. Float-to-integer conversions are outside this module; the differential tests pass `-cpuflags 0` to both sides.

## Evidence

Sandbox Linux x86_64 oracle `.build/reference/ffmpeg`, built from the pinned commit with `--disable-x86asm` (checked from `build-metadata.json` at test time), sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`, `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`. The sha is recorded here only; the tests never pin it.

`tests/differential/caf.test.ts` (4 tests, about 9 s, 1066 whole-file byte comparisons):

- **Encode.** 624: 13 codecs × channels 1-8 (guessed layouts, including 6.1 on the bitmap path) × rates 8000/44100/96000 × with and without `-bitexact`, from raw s16le input.
- **Copy and unknown layouts.** 325: 13 raw codecs × channels 1, 2, 3, 6, 8 × three rates with `-c copy`, plus `-guess_layout_max 0` (no `chan`) by copy and by re-encode to `pcm_s24le`.
- **Layouts.** 117: WAVE_FORMAT_EXTENSIBLE inputs with 21 masks (the 12 PCM-path layouts, 2_1, 2_2, 7.1(wide), DVD 5 and 6, 3.1, 4.1, and the unnamed 0x13 and 0xC) × copy, `pcm_s16be`, `pcm_f32le`, `pcm_mulaw` and the default codec without `-bitexact`; plus 12 raw inputs with guessed layouts of 9, 10, 12, 14, 16 and 24 channels × copy and `pcm_s32be` (9 has no default layout and no `chan`; 16 and 24 truncate a mask above 32 bits into the bitmap).
- **Refusals.** `pcm_u8`, `pcm_u16le`, `pcm_u24le`, `pcm_u32be` and a `pcm_u8` stream copy: native and EdgeFFmpeg both exit 183, and no EdgeFFmpeg output exists.

`tests/unit/caf.test.ts` (7 tests): desc fields per codec at three rates, the layout table and bitmap fallback (including a mask above 32 bits), chunk order and sizes for chan and info, data size limits and parameter refusals, chunked writes at budgets 1, 5, 13 and 4096, abort-once and cancellation, and the descriptor fields. The registry tests `tests/unit/container-registry.test.ts` and `container-registry-extension.test.ts` pass unchanged.

### Known divergence (audit, shared)

The pre-registry `wav`, `aiff` and `au` demuxers do not set `info.metadata` for their tags. Native exports them as global metadata and `caf_write_header` writes them in the `info` chunk, so a tagged WAV, AIFF or AU input into `-f caf` exits 0 without native's tags (probed on macOS arm64 against the darwin reference build `1b86106f…ab92`, copy and re-encode). The same inputs into the existing `wav`, `aiff` and `au` muxers already differ in the same way. Once those demuxers flag their tags (a shared edit), the PCM path refuses such inputs for CAF with no change here.

FATE `lavf-caf` is not reproduced: it passes `-metadata title=lavftest`, which this scope refuses.

## Proposed contracts

| id | file | test title | scope | platforms |
|---|---|---|---|---|
| `muxer.caf.encode` | `tests/differential/caf.test.ts` | `matches native CAF bytes for 13 codecs x 1-8 guessed channels x 3 rates, with and without -bitexact` | caf mux, re-encode, guessed layouts, info chunk | all |
| `muxer.caf.copy` | `tests/differential/caf.test.ts` | `matches native CAF stream copy for 13 raw codecs x 1, 2, 3, 6 and 8 channels x 3 rates, and unknown layouts without a chan chunk` | caf mux, stream copy, unknown layouts | all |
| `muxer.caf.layouts` | `tests/differential/caf.test.ts` | `matches native CAF chan chunks for WAV channel masks: the 12 PCM-path layouts, other mov_channel_layout rows and the bitmap fallback, and guessed layouts up to 24 channels` | chan tags, bitmap and >8-channel guessed layouts | all |
| `muxer.caf.refusals` | `tests/differential/caf.test.ts` | `refuses unsigned PCM codecs for CAF with native status 183 before any output exists` | unsigned codec refusal | all |
