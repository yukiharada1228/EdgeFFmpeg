# Timed frame synchronization API

`createTimedSynchronization` from `@edge-ffmpeg/avfilter` consumes 2–32 source
factories. Each receives an AbortSignal and produces explicit frame events
`{kind:'frame', value}` followed by `{kind:'end', status:'eof'|'error', pts, error?}`.
The timestamp callback returns the value's timestamp or null. `retain` must obtain
owned payload storage before the producer can reuse it and return its accounted
byte count and a release callback. Output frames borrow those retained values
until the next read; consumers must copy anything they keep longer.

The stream keeps raw Native output status PTS separate from the effective output
link PTS and acknowledges unknown input status PTS using the last known input
link timestamp. Unknown internal frame timestamps remain AV_NOPTS; a stack
consumer applies its own Native output rescaling. Backward/repeated PTS are
supported. The shortest mode follows Native framesync state transitions.

Native joins can emit EOF after receiving input errors. The explicit event API
preserves that output status and records input errors separately. Always await
`assertSuccess()` before finalizing output, or consume `frameEvents()` to natural
exhaustion: that view throws on observed input failure. `completion` resolves
with eof, error, cancelled or closed and retains primary/secondary errors.
Intentional early output limits need an explicit completion policy in the caller;
a closed stream does not satisfy the default natural-EOF success check.

Source opening is delayed until the first read. The stream and its frame view
are single-use, reject concurrent reads, close acquired but unstarted iterators,
and serialize source return after pending reads. Sources must cooperate with
the signal; an uncooperative promise cannot be forcibly interrupted. First stop
requests retain their reason when later cleanup fails. Cleanup completes before
successful terminal publication.

`maxResidentBytes` bounds retained payload bytes reported by the ownership
callback. Up to two retained frames per input are held; an explicit
`maxPendingFrames` must allow that bound. The default operation limit is one
million steps; `maxOperatorSteps`, `checkpointEvery` and `checkpoint` configure
bounded work and cooperative yields. These counters do not certify total heap,
backing-store allocation or actual Worker CPU consumption.

The permanent corpus has 13,404 sampled Native rows, including 2–32 inputs,
explicit EOF/error acknowledgement, unknown/backward timestamps and signed64
sentinel/overflow boundaries. Darwin arm64 and Linux x86-64 results agreed on
these rows. Artifact, source, library and corpus hashes are recorded beside the
fixtures. Node and local workerd tests use the public API; this does not certify
production Workers or complete FFmpeg/CLI compatibility.

`node tools/differential-runner/timed-frame-sync/generate-host.mjs` regenerates
host results using the pinned reference and declared C oracles. It rejects dirty
upstream sources and refuses to replace shared rows if the recorded Linux
profile differs. The Linux regeneration driver still needs promotion from the
development workspace. Cached profile evidence is distinguished from a fresh
Native execution in each test run.

The core adapts pinned FFmpeg framesync.c and mathematics.c. See
`packages/avfilter/NOTICE` and `LICENSES/LGPL-2.1-or-later.txt`.
The API is not yet connected to CLI graph planning, replay or muxer publication.
EOF acknowledgement alone must not be treated as whole-job success when composing
stages; the caller must also retain errors observed by upstream stages.

The public `createTimedSynchronizationStep<T>` API exposes the same sampled
frame/status behavior to activation schedulers without awaiting a source. Its
synchronous `poll(pull, wanted)` callback returns an input event or `undefined`
when no event is available. The result is a borrowed frame tuple, an explicit
terminal event, or `{kind: 'blocked', request: [...]}`. A blocked result requests
all missing inputs when output demand or partial input progress requires it;
otherwise it leaves them idle. Queued/current leases remain owned by the step.

Frame values stay borrowed until the next poll or disposal. Callers must provide
accurate retained byte counts and a release callback, then call `dispose()` on
all paths. `dispose()` attempts every retained release and returns the complete
cleanup-error list; repeated calls preserve the outcome. `assertSuccess()` may
succeed only after terminal synchronization and disposal, with no processing,
observed input or cleanup errors. Native join EOF may hide an upstream EIO in
its status code, so the EOF event alone must never authorize publication.
Intentional output-limit closure is a separate policy for the enclosing runtime.

This API checks signed64 link timestamps, declared clocks, retained payload and
operator-step limits. The byte counter does not measure all JavaScript/Wasm heap
or backing-store overhead. The existing 13,404-row cached Native corpus validates
sampled frames, raw/effective EOF and input acknowledgment on Node/local workerd.
Graph actor scheduling and production Workers resource behavior remain separate
verification requirements.
