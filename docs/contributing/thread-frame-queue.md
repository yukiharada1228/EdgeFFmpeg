# Bounded frame FIFO

`createThreadFrameQueue<T>` from `@edge-ffmpeg/avutil` provides an owned FIFO
shared by 1–33 streams. It preserves cross-stream arrival order, per-stream
send/receive finish bits and choke behavior from the fixed FFmpeg reference's
`fftools/thread_queue.c`. It does not create threads or run native FFmpeg.

Construct it with positive safe-integer `maxFrames` and `maxBytes` limits and an
optional positive `maxWaiters` limit (default 64). These limits are independent:
zero-byte terminal messages still consume frame slots. `snapshot()` exposes
frozen copies of queue stream indices, finish bits, choke state and retained
payload byte count. This byte count covers queue-owned leases, not receiver-owned
leases, blocked send arguments, provider buffers, JavaScript/Wasm heap overhead
or a whole job's resident memory. Reserve upstream payload space before reading
or decoding, and budget the other stages separately.

A `ThreadFrameLease<T>` contains `value`, `bytes` and `release()`. A send returning
zero transfers that lease to the queue. `trySend` returns `blocked` when capacity
is unavailable; `send` parks cooperatively and takes an optional AbortSignal.
Before acceptance, the caller still owns the lease and must keep its fields and
payload stable until the operation settles. Cancellation, rejection and nonzero
statuses do not release or adopt the caller's lease. The queue snapshots accepted
accounting fields and the release function; it does not clone payload storage.
After acceptance, callers must not mutate the transferred payload.

`tryReceive()` returns a lease, `again`, a stream EOF marker, or global EOF.
`receive()` waits through `again`. A received lease belongs to its receiver and
must be released exactly once, even after queue disposal. Send finish drains
queued data before emitting one EOF marker for that stream. Receive finish
causes queued frames for that stream to be discarded when receiving; a later
send reports EOF once and then invalid-operation status. Global EOF follows all
stream finish markers. An empty queue can still wait if an unfinished stream
exists. Status values use FFmpeg's EOF (-541478725) and EINVAL (-22); temporary
unavailability is represented by `again` across host errno profiles.

Choking pauses receive without dropping queued leases. `sendFinish()` unchokes
the queue, matching Native behavior. Waits are bounded independently of frame
capacity and wake on state changes, cancellation, faults or disposal.
`dispose()` discards every queue-owned lease, attempts all release callbacks and
wakes pending operations. Release errors remain visible through `cleanupErrors`
and a stable AggregateError on disposal. A discard failure is sticky for later
operations. Disposal does not settle consumer work or upstream providers; the
caller must await their own operations and cleanup before publishing outputs.

Reference evidence is in `compat/behavior-specs/thread-frame-queue`: 120 Native
traces / 15,416 steps across 1/2/3/8/33 streams and capacities 1/2/4. Unit tests
cover ownership, cancellation, waiters, cleanup faults and accepted-field
snapshots; Node differential and local workerd tests compare the public API with
the same cached host traces. The single-thread oracle executes actual pinned
thread_queue.c functions, reporting a full send as `blocked` instead of entering
a blocking call. It does not validate pthread interleavings, complete CLI/task
scheduling, Linux execution, production Workers or whole-heap/CPU constraints.

Regenerate host evidence with:

```sh
node tools/differential-runner/thread-frame-queue/generate-host.mjs
```

The builder validates the locked commit, included upstream source, reference
binary/configuration, libraries and oracle hashes. Fixture provenance records
the actual compiler and host; it does not claim a reproducibly pinned toolchain.
Cached-result tests verify fixture/source hashes and do not require a native
binary at runtime. See `packages/avutil/NOTICE` and the LGPL license text.
