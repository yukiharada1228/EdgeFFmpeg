# Scoped FLAC demux fixtures

Pinned upstream: FFmpeg 9.0.2, commit 946fcce07b6dcd0331c8cc609192aeff5e1924f8.
`clean.json` preserves eight finite Native clean streams and packet observations
from the private investigation's native-cases/native-packet-cases captures.
`metadata.json` preserves Native comment, multiple-comment-block, chapter and
mixed-picture-order captures, with original source/reference hashes. Every input
has a SHA-256 checked by the targeted integration test. The manifest hashes the
preserved JSON files. No runtime/test imports of private modules are needed.

Scope: default sample timebase, 1024-byte parser calls, ordered duplicate tags,
comment chapters, provisional channel mask, ordered encoded attached pictures.
SEEKTABLE and CUESHEET payloads stay explicitly unhandled. Full Native timestamp,
position, AVIO, seek/wrap/nofillin/igndts, diagnostics, decode and exit policy
parity are not asserted. No capability certification or CLI routing is provided.
Image pixels are never decoded. Caller closes the handle, even after audio EOF.
Provider backing buffers and JS object/string overhead remain outside Core byte
accounting; metadata scratch and payload copies use Core allocation.
