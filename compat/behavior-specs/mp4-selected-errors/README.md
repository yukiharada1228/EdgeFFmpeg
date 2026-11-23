# Selected-stream MP4 failure statuses

Regenerate with `node tools/differential-runner/mp4-selected-errors/generate.mjs`.
9owned two-audio inputs retain a valid later stream while the first stream has
explicit frequency0 and MDHD timescale1. Rewrites update descriptor/box sizes
and affected chunk offsets.54auto/first/later/both/reverse/duplicate jobs include
27successful copies and27Native EINVAL process exits234. All cases remain in
the fixture;negative inputs are not filtered.

Node and local workerd/R2 compare exact fresh/frozen statuses. Successful
outputs compare ASC,stream/packet metadata and encoded payload hashes through
the calibrated fixed-libavformat probe. Failed selected-stream jobs report the
canonical sample rate not set reason and preserve Node prior outputs / publish
no R2 output. Selecting valid later streams succeeds despite a bad unselected
stream. Three R2 cancellation/write/planning-budget cleanup controls remain.

Full Native stderr formatting and OS side-effect protocol are not certified.
Container byte identity is not claimed. Source/generator/probe/artifact/input
hashes and all case/job counts are validated by the helper. The independent
Native regeneration receipt is recorded before promotion.
