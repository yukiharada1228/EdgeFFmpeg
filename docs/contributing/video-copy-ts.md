# Rawvideo timestamp preservation

The finite rawvideo paths accept global `-copyts`, `-nocopyts`, `-start_at_zero`
and `-nostart_at_zero`. The last applicable boolean setting wins. As in the
pinned CLI, suffixes on these global options are ignored; they do not scope a
setting to a media type or stream. Option names and their original suffix text
remain in the parsed command.

`-copyts` preserves physical packet timestamps rather than subtracting input seek
time. Output seeking still trims/shifts the output clock. Forced input decoder
cadence remains independent: accurate input trim applies after the decoder has
assigned its clock. A positive physical seek beyond EOF can retain a final packet
that initializes a forced-rate decoder, even if later trim produces no frames.
The adapter reads/decodes one bounded initialization packet in that case, checking
input identity before publishing output metadata.

Automatic CFR selects Native VSCFR where the original command has a direct
single-stream source with no explicit input timestamp offset, or where copyts
requires it. This suppresses initial frame duplication under Native's conditions.
Explicit CFR remains explicit. A private output-origin marker survives ordinary
CLI normalization; no extra filter nodes or user-visible options are introduced.
Zero-frame output still obtains correct tentative decoder/filter parameters.

The reference corpus contains10,592 gray rawvideo jobs:448 timestamp-flag/order
cases,4,320 seek/duration/frame-limit cases,640 global-suffix/invalid-argument
cases and5,184 default-sync/raw/framecrc cases. Complete output bytes are stored
as base64, with source/build/flags/binary verification during regeneration.
All cases compare through public Node and local workerd/R2 APIs. Four changed-input
scenarios check discarded-frame initialization failure without output publication
or leftover temporary objects. Invalid Native cases compare success/failure
projection only, not exact Native exit codes or diagnostics.

```sh
node tools/differential-runner/video-copy-ts/generate.mjs
npx vitest run tests/differential/video-copy-ts.test.ts tests/workers/video-copy-ts.test.ts --maxWorkers=1
```

Declared rawvideo inputs have zero/unset container origins, so start_at_zero and
its inverse do not shift these inputs. This does not implement nonzero container
start metadata, audio/compressed timestamp modes, arbitrary filter/protocol seek
semantics, production Cloudflare certification, full CPU/heap enforcement or
checkpoint/restart. It does not zero arbitrary timestamps created by filters.
Existing pixel-format capabilities are unchanged; this new flag corpus uses gray
inputs. Broader format/rate/graph coverage remains a separate compatibility task.
