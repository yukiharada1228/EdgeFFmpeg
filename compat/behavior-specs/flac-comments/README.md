# Finite Native Vorbis comment evidence

Preserved Native ffprobe n9.0.2 output from pinned FFmpeg commit
946fcce07b6dcd0331c8cc609192aeff5e1924f8. Each fixture retains complete
small FLAC input, payload, input SHA-256, invocation, output and reference
executable hash. Original generators were generate-comment-native.mjs and
generate-comment-blocks-native.mjs; original source/generator hashes are retained
in the JSON. No runtime imports of private build artifacts are used.

File SHA-256:
- native-comments.json: 792586af2ecf862e3239a3af7ea7e8af2f6f77cce8d7592503af1574d28a2301
- native-comment-blocks.json: 2b9d2af090520b4c271ed74760fce41a4e5446d919a1c42996ac2e0b0077c35f

Scope: 18 plain Native cases, plus explicitly deferred chapter/picture/channel
mask cases, and four multiple-block dictionary cases. Ordered tagEntries preserve
canonical duplicate keys that a JavaScript tags object cannot represent.
Strings and dictionary state have separate finite limits; they are not charged
as Core byte buffers. Range reads allocate scratch through the caller's Core
allocator, skip vendors without reading them, and retain invalid UTF8 as source
ranges. Plain payload parsing borrows invalid UTF8 views from the caller: keep
that input immutable for the lifetime of its result. Provider read buffers remain
provider-accounted. No diagnostic, full demux, or full conformance claim.
