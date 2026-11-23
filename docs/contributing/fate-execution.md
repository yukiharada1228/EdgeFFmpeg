# Reviewed FATE execution

Run `npm run reference:build` first, then `npm run fate:run`.
The registered profiles are `fate-unknown_layout-pcm` (md5 helper),
`fate-filter-asetrate` and both `fate-filter-asetnsamples-{pad,nopad}` cases
(framecrc helper), from the pinned upstream Make definitions. This is distinct from `npm run fate:inventory`,
which only lists explicit CMD definitions and never claims execution.

The runner verifies the upstream commit, tracked-source state, reference binary
hashes/configure flags, and reviewed profile dependencies. It invokes upstream
Make to build the original audiogen input and checks its byte count and SHA-256
against their reviewed profile JSON files. No external samples are downloaded.

The original native target runs through upstream Make and `fate-run.sh`, with
`GEN=no` (never update expected results), `KEEP=1`, CPU flags `all`, one thread
and hardware acceleration `none`. Its report and committed bytes must match the upstream expected MD5 or complete framecrc text. The runner then projects the reviewed CMD
to virtual paths and runs EdgeFFmpeg with its Node adapter. Complete output bytes and the respective upstream expected result must agree. Unsupported helper syntax,
changed arguments, stale inputs or changed dependencies fail explicitly.

The md5 helper is implemented by hashing the committed file on the host. The
native helper's terminal/statistics, thread, hardware and automatic-conversion
controls are recorded adaptations rather than claims of CLI support. The
selected PCM16-to-PCM16 case requires no conversion. This does not demonstrate
those controls for other formats or filters.

Each invocation writes a fresh directory under `.build/fate-execution/` with
native and Edge output, logs, result and provenance JSON. The current pointer is
`compat/reports/fate-execution.json`. `npm run compat:report` requires a fresh
successful invocation, validates its source/reference/profile provenance, and
counts executed reviewed definitions separately from unexecuted inventory.
CI uploads the execution directories with the development evidence.

Only these four reviewed cases execute. General Make expansion, other helpers,
external FATE sample locks, full FATE coverage and production Workers execution
remain incomplete. Passing these cases does not certify general PCM compatibility.


`compat/fate/profiles.json` registers every required profile. The md5 helper
hashes committed output on the host; the framecrc helper adds `-bitexact -f
framecrc` and compares every byte of the upstream reference. Per-case execution
directories preserve input, native output, expected reference, Edge output,
logs and result metadata. Missing or duplicate required profiles cannot pass
the combined report. No shell interpretation of CMD strings is performed by
the Edge adapter; reviewed variable/path projection must preserve all options.
