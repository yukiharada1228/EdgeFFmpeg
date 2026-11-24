# Audio Visual Research (AVR) demuxer scope

`packages/containers/src/avr.ts` ports `libavformat/avr.c` (`avr_probe`, `avr_read_header`), the integer branch of `ff_get_pcm_codec_id` in `libavformat/utils.c`, and relies on the shared raw PCM packet path for `pcm.c`'s `ff_pcm_read_packet`/`ff_pcm_read_seek`. It registers the demux-only `avr` descriptor with one line in `packages/containers/src/registry.ts`. Native has no AVR muxer, so there is no `-f avr` output. The module exports `openAvr`, `avrPcmCodec`, `AvrError` and `avr`; it is reached through the registry (`containerFormat('avr')`), not the package barrel.

## Demux

- Detection: undeclared input whose first four bytes are `2BIT` (probe precedence 100, head only, no confirm). `-f avr` selects it explicitly.
- The 128-byte header is read in pieces of at most `maxReadBytes`, with the signal checked around each read. A file shorter than 128 bytes is refused (`Truncated AVR header`).
- Fields, in native's order: `chan` (u16be at 12) is 0 for mono or 0xFFFF for stereo; any other value is refused with native's `AVERROR_PATCHWELCOME` status 176. `bps` (u16be at 14), `sign` (u16be at 16) and the 24-bit rate at 23. A zero rate is refused with `AVERROR_INVALIDDATA` status 183.
- Codec: `ff_get_pcm_codec_id(bps, 0, 1, sign)`. Bytes are `(bps + 7) >> 3`, and the sample is signed when bit `bytes - 1` of `sign` is set. This gives s8/u8, s16be/u16be, s24be/u24be and s32be/u32be. A bps that native maps to `AV_CODEC_ID_NONE` (0, above 64, 33 to 56 bits signed, 33 to 64 bits unsigned) is refused with status 176, as native refuses it.
- Data starts at byte 128 and runs to EOF. Packets come from `openRawPcm`, so the PCM packet span, seeks, `-t` and `-frames:a` follow the other PCM inputs. The channel mask is unset (null), as native sets only the channel count.

## Refused although native accepts

These fail with `AvrError` (exit 1) before any output is opened:

- a bps that is not a multiple of 8 (for example 12, which native demuxes as s16be with a 1-byte `block_align`, or 4, which native maps to u8 with a zero `block_align` and then fails while demuxing);
- bps 64 with the sign bit set (native `pcm_s64be`, which is not in the `PcmCodec` union);
- a data size that is not a whole number of sample frames (native emits a short final packet);
- `-f avr` on a file whose first four bytes are not `2BIT`. `avr_read_header` skips the magic unchecked, but `openAvr` throws `AvrError` (`Expected AVR signature`) while reading the header. No unit or differential test covers this case, so its exit status and the absence of output are unverified (wave 1 integration audit).

The specification asked for bps 12 to be refused "with native exit status". Native exits 0 for bps 12, so the port cannot match that status. It refuses explicitly instead, and the differential test asserts that native accepts the file.

## Evidence

Linux x86_64 oracle built in the sandbox (`.build/reference/ffmpeg`, sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`):

- `tests/differential/avr.test.ts`
  - 96 test-built files: bps {8, 16, 24, 32} x sign {0, 0xFFFF, the width's sign bit alone, every bit but that one} x mono/stereo x {8000, 22050, 96000} Hz, with odd frame counts of 1023, 2207 and 9601. Each is compared byte for byte with native for `-c:a copy -bitexact -f framecrc`, both autodetected and with `-f avr`, and for `-cpuflags 0 -f s16le` decode: 288 comparisons. Native scores AVR files at only 25, so the test first checks that native's framecrc header shows the expected codec, rate and layout before it claims autodetection parity. All 96 files passed this check.
  - Four files (u8 mono, s16be stereo, s24be mono with a 4 mask, u32be stereo at 22050 Hz): `-bitexact -f wav` decode, and framecrc for input `-ss`, output `-ss`/`-t`, input `-ss` with output `-t` and `-frames:a 2`, with copy and with pcm_s16le, each autodetected and with `-f avr`: 72 comparisons.
  - Native refusals: chan 2, rate 0, bps 0, 40, 65 and unsigned 64, autodetected and with `-f avr`. Edge exit statuses equal native's (176 or 183), and no output is created: 12 comparisons. Four unported inputs (bps 12, 4, signed 64 and a partial trailing frame) are shown to be accepted by native, and Edge refuses them before output.
- `tests/unit/avr.test.ts`: the codec-id port over every width and sign mask, unmapped and unported widths, header parsing with 5-byte reads and no payload reads, packet offsets and seeks, refusal order, statuses and classes, abort before, during and after the header, and the descriptor fields, freezing and four-byte detection.
- `tests/unit/container-registry.test.ts` and `tests/unit/container-registry-extension.test.ts` pass unchanged.

## Unsupported

AVR output (native has none), bps values that are not whole bytes, pcm_s64be, partial trailing frames, files shorter than the 128-byte header, the loop, MIDI, replay-speed and name fields (native ignores them too), Workers-runtime verification, and FLAC input. The routine's native comparisons ran on the sandbox's Linux x86_64 reference. In the wave 1 integration, the same tests also passed against the pinned macOS arm64 reference (local run) and on Linux CI run 45402980700. CI used its own Linux build of the reference.
