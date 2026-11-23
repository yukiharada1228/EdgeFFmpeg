# FLAC time windows with pointwise filters

`cases.json` records 36 real executions of the pinned Native FFmpeg 9.0.2
reference (`946fcce07b6dcd0331c8cc609192aeff5e1924f8`). The executable SHA-256
is `1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92`.
The fixture also records the independently pinned decoder Wasm SHA-256.

The matrix combines the existing 16-bit and 24-bit stereo ramp FLAC inputs
from `flac-decode-cli` and the 16-bit stereo `baseline/raw` input from
`flac-max-time`, each with known and unknown STREAMINFO total samples,
with six command configurations. All three source inputs contain 257 samples
at 8 kHz (the `ramp-5` source ID does not mean five samples):

| Case | Time selection | Filter | Output |
| --- | --- | --- | --- |
| output-window | output `-ss 0.0001875 -t 0.0083125` | `volume=0.5` | s16le |
| output-to | output `-ss 0.004125 -to 0.0161875` | `anull,volume=0.25` | WAV |
| input-duration | input `-t 0.0101875` | `volume=2:precision=fixed` | framecrc |
| input-to-output-start | input `-to 0.0141875`, output `-ss 0.0031875` | `anull` | s16le |
| past-eof | output `-ss 1 -t 0.002` | `volume=0.5` | WAV |
| zero-duration | output `-t 0` | `anull` | framecrc |

All commands explicitly use `-cpuflags 0`, `-map 0:a`, and
`-map_metadata -1`. There is no input seek, rate conversion, channel remix,
padding, frame regrouping, or non-pointwise filter in this corpus. Fractional
boundaries deliberately exercise rounding at the 8 kHz input sample rate.
The past-EOF and zero-duration outputs retain the actual Native container or
framecrc headers; zero output samples do not imply an empty output file.

Each row retains exact input bytes and SHA-256, canonical argv using
`/in.flac` and `/out`, Native exit status, stdout, stderr, and output bytes
and SHA-256. Temporary host paths in stdout/stderr are normalized to
`<fixture>`; output bytes are never normalized or synthesized. Unknown totals
are derived solely by clearing the STREAMINFO total-samples field before
Native execution. All 36 executions exited successfully. The output-to cases contain 384 bytes
of PCM inside 462-byte WAV files, and input-to-output-start produces 352
bytes of raw PCM; these are nonempty time-window checks.

Run `node tools/differential-runner/flac-timed-filters/generate.mjs` from the
repository root. The generator validates executable and Wasm pins and checks
existing rows against the planned argv, exact inputs, and output hashes.
Completed rows are reused without executing Native again. The initial capture
used 24 Native calls; a subsequent expansion used 12, for 36 total. Both
verification passes reused completed rows with zero Native calls. The per-invocation
hard cap is 40 calls, calls are sequential and bounded to 10 seconds and 1 MiB
captured process output. This evidence does not by itself claim that every
runtime backend already passes these cases; acceptance tests make that check.

There are **36 captured executions, four unique exact input hashes, and 24
unique input-plus-argv combinations**. The 12 added `16-2-ramp-257` rows use
exactly the same input bytes as the corresponding `16-2-ramp-5` rows. They
are retained as actual repeated captures, not counted as additional unique
coverage. The exact input hashes are:

| Input | SHA-256 |
| --- | --- |
| 16-bit known total (both source IDs) | `5b31876ba2b64759633b1a53d52bcf45bae04eaa30e7a225bffafe0bd2887bda` |
| 16-bit unknown total (both source IDs) | `533979427e33ad1dd5dd6f114ef66c32d12b49e58c01c7ab6f6ff459b988e515` |
| 24-bit known total | `f86801e5c8bdd8cc41ef88f2473fbdb0a2c21182f998baa3bfe8a2bd49a66382` |
| 24-bit unknown total | `d188ecc5b723ae2572dc3ebf4462345710c873cf7e0d46c8716dd2344098257b` |

## Public backend acceptance

This corpus covers time selection combined with chains containing only `anull`
and constant `volume`, without an explicit output rate.
The scalar rounding requirement remains enforced. Scoped timed output-rate
conversion was subsequently added with separate [evidence](../flac-timed-rate/README.md).
Singleton `aformat=sample_fmts=…` at unchanged rates was subsequently added
with separate [evidence](../flac-timed-aformat/README.md). Finite buffering
filters at unchanged rates now have separate
[evidence](../flac-timed-buffered/README.md). Buffering with changing rates and
timed `asetrate` still reject; input demux seeking remains unsupported.

`tests/integration/flac-timed-filters.test.ts` compares all captured outputs and
one actual Node launcher execution. `tests/workers/flac-timed-filters.test.ts`
runs the same captures through actual local R2/workerd without Node compatibility,
plus five rejection controls and three transactional failure controls. Existing
unsupported filter syntax retains its existing parser diagnostics; no Native
error-message equivalence is asserted for those controls.
