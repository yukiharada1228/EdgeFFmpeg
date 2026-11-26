# Computerized Speech Lab NSP (nsp) demuxer scope

`packages/containers/src/nsp.ts` ports `nsp_probe` and `nsp_read_header` from `libavformat/nspdec.c` and registers a demux-only `nsp` descriptor (one line in `packages/containers/src/registry.ts`). Native has no NSP muxer, so `-f nsp` output is refused like any other demux-only format. The module exports `openNsp`, `probeNsp`, `NspError` and the `nsp` descriptor; it is not re-exported from the package barrel, and tests import it by path.

## Syntax

- Undeclared: `-i in.nsp` (detected by magic).
- Declared: `-f nsp -i in.nsp`. `-ar`/`-ac` on the input are refused, as for every non-raw format.
- Outputs: any registered PCM muxer through decode (`framecrc`, raw PCM, `w64`, `wav`, `aiff`, `au`), with output `-ss`/`-t`.

## Detection

`nsp_probe` requires `'FORM'` at byte 0 and `'DS16'` at byte 4. The head `'FORM'` overlaps aiff (precedence 30) and the planned iff (26), so nsp uses precedence **24** and runs first. Its `confirm` reads the 8 bytes native inspects plus the form type at byte 8 (at most 12 bytes, in bounded reads) and resolves false for an input shorter than 8 bytes, for AIFF/AIFC (their byte 4 is a size field), for an IFF `MAUD` form, for a bare 4-byte `FORM`, and for a `FORMDS16` head whose bytes 8..11 hold a form type that another native probe also scores 100: `AIFF`/`AIFC` (`aiff_probe` only needs the RB32 at byte 4 to be at least 4, which `DS16` is), the iff types `8SVX`, `16SV`, `MAUD`, `PBM `, `ACBM`, `DEEP`, `ILBM`, `RGB8`, `ANIM` and `RGBN`, and `WVQA`, `RLV2`, `RLV3` and `MOVE`. Native's probe tie detects nothing there (183, tested), and `-f nsp` reads such files in both; those then fall through to the later probes unchanged (a bare `FORM` is still claimed by the pre-registry aiff head). Native also matches the `.nsp` extension, but it has a `read_probe`, so no `demux.extensions` are declared.

## Header walk

`openNsp` skips 12 bytes and walks chunks `{RB32 id, RL32 size}` with bounded reads (at most `maxReadBytes` each, signal checked around every await). It never reads the payload while opening.

- `HEDR`/`HDR8`: a size below 32 is refused with native's `AVERROR_INVALIDDATA` status 183. Otherwise the rate is the RL32 at offset 20 of the body, and the walk continues `size` bytes after the body start. A later header replaces an earlier rate.
- `NOTE`: `avio_get_str(pb,size,...)` consumes bytes up to and including the first NUL, or `size` bytes, or up to EOF; then `size&1` more bytes. The bytes after the first NUL are therefore re-parsed as chunks (probed natively). Any NOTE sets native's global `Comment`, so `info.metadata` is true. The scan reads windows of at most 1024 bytes (`headerBytes`). A size above `INT_MAX` (native reads nothing) is refused as not implemented.
- `SDA_`, `SD_A`: mono. `SD_2`..`SD_8`: mono, with native's `Unsupported chunk!` warning (recorded in `info.warnings`). `SDAB`: stereo. The audio chunk's size is ignored: s16le data starts right after its 8-byte header and runs to EOF.
- Any other id is not skipped: native reads the next chunk header 8 bytes later, whatever the size.

The stream is `pcm_s16le`, `blockAlign` 2 x channels, `channelMask:null` (native leaves the order unspecified; the shared PCM path guesses mono or stereo). The packet span is the default `pcmPacketSpan(rate)`.

## Refusals

All refusals happen before any output exists.

| Input | Native | EdgeFFmpeg |
|---|---|---|
| Walk reaches EOF without an audio chunk (including a NOTE or HEDR that overruns EOF, a bare 8-byte head) | zero-channel stream, `AVERROR(EINVAL)` | `containerRefusal`, 234 (Linux EINVAL value) |
| Rate 0 (no HEDR) or above `INT_MAX` (negative int) | decoder `Invalid sample rate`, `AVERROR(EINVAL)` | `containerRefusal`, 234 |
| `HEDR`/`HDR8` size below 32 | 183 | 183 |
| Trailing partial sample frame | decodes a short packet, exit 0 | refused, exit 1 |
| Zero-sample data (audio chunk header at EOF) | exit 0, framecrc prints the 1/90000 stream time base | refused, exit 1 |
| Audio chunk id with a truncated size field | zero-sample stream | refused, exit 1 |
| `-c copy` | no pts info: copy timestamps in 1/90000 | `info.copyRefusal` (PREP-COPY), exit 1; decoding unaffected |
| Input `-ss` > 0 | accepted | refused, exit 1 |
| NOTE present, output `wav`/`aiff`/`au` | wav writes `LIST/INFO ICMT`, aiff `ANNO`; au writes no Comment | refused by the shared metadata policy (au does not set `dropsMetadata`) |

The native statuses for EINVAL are asserted against `256 - os.constants.errno.EINVAL` on the host; EdgeFFmpeg always uses the Linux value 234.

## Determinism and arithmetic profile

Byte copies and integer header arithmetic only (32-bit chunk fields, bigint offsets); decoding uses the existing PCM codecs. Nothing is platform-dependent, so every comparison runs on darwin and linux. No float path and no linux-gated case.

## Evidence

Linux x86_64 sandbox build of the reference `.build/reference/ffmpeg` (FFmpeg 9.0.2, commit 946fcce0, `--disable-x86asm`; sha256 `ac302e4d39cbc513f34e19f154ee9be432729ef980566d034b5706e17eef893c`; `cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0`), Node 24.22.3. Inputs are synthesized in the tests; native runs at test time (one process per input writes all its outputs), and no digest is committed.

- `tests/differential/nsp.test.ts` (3 tests, about 5 s):
  - `matches native framecrc, WAV, AIFF, AU, W64 and raw output with output -ss/-t for mono and stereo HEDR/HDR8 files, NOTE, unknown and SD_2 chunks`: 72 files (`SDA_`, `SD_A`, `SD_2` mono and `SDAB` stereo x 8000/16000/44100 Hz x HEDR/HDR8 x plain/unknown-chunk/NOTE), 504 byte-for-byte outputs (framecrc decode, s16le, framecrc with output `-ss 0.0125 -t 0.05`, s16le with `-t 0.0301`, w64, plus wav, aiff and au without NOTE), native's `Unsupported chunk!` warning for `SD_2`, native `ICMT`/`ANNO` tags for the 24 NOTE files and 72 metadata refusals (wav/aiff/au) with no output file.
  - `refuses -c copy (native copy timestamps use 1/90000) and input -ss before any output, and matches native refusal statuses`: native copy prints `#tb 0: 1/90000` and 3 copy outputs are refused; the zero-sample case (native 1/90000 header) and input `-ss` are refused; 7 malformed inputs, each detected and with `-f nsp` (14 native status comparisons: no data chunk, bare head, NOTE overrunning EOF, rate 0, negative rate -> EINVAL; short HEDR -> 183; partial frame -> native 0, refused).
  - `leaves FORM DS16 heads undetected where another native probe ties nsp_probe at 100, and matches native -f nsp on them` (added by the wave-2 audit and run on macOS arm64 against the darwin reference build `1b86106f…ab92`; its linux-x64 run is CI's): 16 tied form types with native's 183 asserted, each refused undeclared with no output and byte-exact with `-f nsp` decoded framecrc, plus 3 near misses (`AIFX`, `MAUX`, `EVOM`) detected and byte-exact in both: 19 comparisons, 16 refusals.
- `tests/unit/nsp.test.ts` (7 tests): the chunk walk with HEDR/HDR8 and all audio ids, the unknown-chunk and NOTE quirks, bounded read requests and totals, the 12-byte probe, its tie list and its precedence against AIFF/AIFC, MAUD and a 4-byte FORM, every refusal and its status, abort, the descriptor fields and backend refusals before output creation.

## Unsupported

- Stream copy (`-c copy`), input `-ss`, zero-sample data, partial trailing frames, truncated audio chunk headers and NOTE sizes above `INT_MAX`: refused explicitly.
- NOTE inputs to wav, aiff and au outputs: refused by the shared policy (au is refused although native au writes no `Comment`; changing that needs a shared `dropsMetadata`-per-key decision, not proposed here).
- Workers, R2 and FLAC paths were not exercised; no workers or integration test was added.

## Proposed contracts

| id | file | title | scope | platforms |
|---|---|---|---|---|
| `demuxer.nsp.decode` | `tests/differential/nsp.test.ts` | `matches native framecrc, WAV, AIFF, AU, W64 and raw output with output -ss/-t for mono and stereo HEDR/HDR8 files, NOTE, unknown and SD_2 chunks` | decode to every PCM muxer, output time selection, chunk-walk quirks, metadata refusal | all |
| `demuxer.nsp.probe-ties` | `tests/differential/nsp.test.ts` | `leaves FORM DS16 heads undetected where another native probe ties nsp_probe at 100, and matches native -f nsp on them` | undeclared probe ties refused, `-f nsp` byte-exact | all |
| `demuxer.nsp.refusals` | `tests/differential/nsp.test.ts` | `refuses -c copy (native copy timestamps use 1/90000) and input -ss before any output, and matches native refusal statuses` | copy and seek refusals, native exit statuses | all |
