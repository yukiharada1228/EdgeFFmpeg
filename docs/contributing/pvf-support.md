# PVF demuxer scope

`packages/containers/src/pvf.ts` adds the `pvf` (Portable Voice Format) demuxer to the container registry with one line in `registry.ts`. It is demux only, as in native FFmpeg, which has no pvf muxer. It exports `openPvf`, `pvfGetLine`, `pvfScanInts`, the `pvf` descriptor and their types. Its notice is `packages/containers/NOTICE-PVF`.

## Behaviour

- **Detection.** `head` tests the four bytes `PVF1`, and `confirm` reads the fifth byte, which must be `\n`, as `pvf_probe` compares five bytes. Precedence is 100, because no other format claims that head. There is no input extension. `PVF1\r\n` is therefore not detected, as native does not detect it either. With explicit `-f pvf`, the first five bytes are skipped unchecked, as `avio_skip(s->pb, 5)` does.
- **Header line.** A private port of `ff_get_line` reads one line into a 32-byte buffer: NUL, LF, CR or EOF ends it, at most 31 bytes are kept (the LF or CR terminator included while it fits), and the rest of the line is consumed. After a CR, a following LF is consumed, and any other byte is left for the data. The line is read in bounded reads of at most `maxReadBytes`, with the signal checked around each await, inside a 123-byte window after the magic (`headerBytes` 128).
- **Fields.** A port of the `sscanf("%d %d %d")` subset parses channels, rate and bits per sample with C-locale whitespace, an optional sign and decimal digits. A count other than 3 is `INVALIDDATA`. So are channels outside 1..512, a rate of 0 or less, and bits per sample outside 1..4194303 (`INT_MAX / FF_SANE_NB_CHANNELS`). These refusals carry native's exit status 183.
- **Codec.** As `ff_get_pcm_codec_id(bps, 0, 1, 0xFFFF)`: 8 is `pcm_s8`, 16 `pcm_s16be`, 24 `pcm_s24be` and 32 `pcm_s32be`. `block_align` is `bps*channels/8`. The data starts after the line and runs to EOF. Packets come from `openRawPcm`, so packet spans, seeks and timestamps match every other PCM input. The channel mask is unset (null), so the PCM path's default layout guess applies, as for native's unspecified layout.

## Explicit refusals (native succeeds or differs)

These fail with exit status 1 before any output exists:

- bits per sample 64 (`pcm_s64be` is not in the PCM codec set), and every value that is not 8, 16, 24 or 32. Native maps, for example, 12 to `pcm_s16be` with a 1-byte block align, 7 to `pcm_s8`, which then fails while demuxing, and 40 to no codec;
- a field outside the 32-bit `int` range. glibc converts such fields through `long` and truncates them, so, for example, `4294975296` becomes 8000 and an overflowing `long` becomes -1;
- a payload that is not a whole number of sample frames. Native emits a partial last packet;
- a header line that does not end within the first 128 bytes of the file.

Detection failure of a `PVF1\r\n` file uses the generic `Unsupported audio container signature` (exit 1), where native reports `INVALIDDATA` (183). Input `-ss` at or beyond EOF keeps the registry's generic refusal (`seekBeyondEnd` is unset), because native's behaviour there was not probed.

## Evidence

Linux x86_64 oracle `.build/reference/ffmpeg` (sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`), built from the pinned commit.

`tests/differential/pvf.test.ts` synthesizes every input and runs native at test time:

- 216 byte comparisons: bits per sample {8,16,24,32} × channels {1,2,3} × rates {8000,44100} × lengths {1,67,4100} frames, each compared as `-c:a copy -f framecrc`, `-f wav` (default `pcm_s16le`) and `-f s32le`.
- 5 copy framecrc timing profiles: input and output `-ss`, `-t` and `-frames:a`.
- A 34-line header matrix. 26 lines match native's framecrc bytes and exit status (0 or 183): extra spaces, tab and vertical tab separators, a leading `+`, `+`-joined fields, leading zeros, extra fields, CRLF, a bare CR, CR CR, a NUL terminator, long lines (trailing spaces, truncated trailing text, and fields pushed past 31 bytes), a missing terminator, a missing field, hex fields, a double sign, 0 and 513 channels, zero and negative rates, zero and too-large bits per sample, and an empty line. 8 lines are refused explicitly where native exits 0 (or 183 for an overflowing `long`): bits per sample 12, 64, 40 and 7, a 32-bit-wrapping rate, an overflowing field, a partial trailing frame and a line beyond the window. The test asserts which.
- 512 channels of `pcm_s8` (the maximum), compared as copy framecrc and `-f s8`.
- Explicit `-f pvf` on a 3-byte file (183) and on a file whose magic is wrong (decoded, as native does).

`tests/unit/pvf.test.ts` covers the `ff_get_line` port, the `sscanf` subset, header parsing for the four codecs, bounded read requests, the CR lookahead at EOF, refusals and their exit statuses, cancellation before and between reads, and the descriptor fields and detection reads.

## Unsupported

- `pcm_s64be`, bit depths other than 8, 16, 24 and 32, fields outside the 32-bit `int` range, partial trailing frames and header lines past byte 128, as listed above.
- Input seeks at or beyond EOF.
- Muxing (native has none).
- Channel counts other than 1, 2, 3 and 512 are not compared with native; decoded output was compared for 1 to 3 channels only.
