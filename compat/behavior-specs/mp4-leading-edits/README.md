# Leading and empty MP4 edits

Reproduce using the pinned local Native reference:

```sh
node tools/differential-runner/mp4-leading-edits/generate.mjs
```

The generator verifies binary/source hashes, copies three self-owned H264 inputs
and freezes78 probes:18 leading delays,18 all-empty edits,18 inconsistent declared
counts recovered from body length,18 genuinely zero-entry bodies and6 delayed
multitrack sources. Thirty-six jobs exercise first/later/both/reverse/duplicate/
automatic mapping. Delays include1ms and300000seconds; media/movie clocks differ
and Native emits version1 entries when needed.

True zero-entry conversion changes the actual ELST body and relocates ancestor
box lengths and STCO/CO64 offsets. Merely writing entry_count=0 while retaining
entries is a different malformed case: default Native MOV recovers the count
from atom length. The oracle stores both cases separately.

Stream start ticks and original-file microseconds are compared with FFprobe.
Normalization uses the original file origin before mapping; a selected later
stream keeps its relative delay when an earlier stream is unselected. Copy
outputs compare stream fields, packet clocks/flags and encoded payload hashes,
not container bytes. H264 raw/framecrc comparisons include zero output limits,
spatial conversion and both arithmetic profiles on Node and local workerd/R2.

All-empty input has no readable packet. During H264 transcoding, Native fails
to initialize the output format; candidate failure existence is compared. Candidate preserves the prior
transactional output, while Native can truncate an OS file. Exit183 versus1
and these effects are not claimed equivalent.

Multiple media intervals, non-unit rates, arbitrary malformed inputs, complete
metadata/error conformance and measured production resources remain open.
