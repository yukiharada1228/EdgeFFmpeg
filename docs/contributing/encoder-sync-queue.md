# Video encoder synchronization queue

`createVideoEncoderSyncQueue<T>` from `@edge-ffmpeg/avformat` provides the video
frame portion of the fixed reference's `fftools/sync_queue.c`. It coordinates
1–32 streams, limiting stream timestamps, frame limits, EOF propagation and
buffer-duration heartbeats. It is an output scheduling kernel. Audio sample
splitting/alignment and full CLI/demux/encoder task scheduling remain separate
work; the video-specific name does not declare those final features excluded.

Construct the queue with one limiting flag per stream and explicit `bufferUs`,
`maxFrames` and `maxBytes`. Configuration is snapshotted. Frame count and byte
limits apply across all retained queue frames. Counts cover caller-declared
payload sizes, not arbitrary payload object graphs, consumers, codec temporary
buffers or whole JavaScript/Wasm/isolate memory. The caller must provide accurate
sizes and separately account for upstream allocations before sending.

A `VideoEncoderSyncFrame<T>` holds an opaque payload, signed64 PTS (or null),
signed64 duration, positive signed32 rational timebase, byte count and release
callback. A successful `send(stream, frame)` returning zero transfers ownership.
Finished streams return EOF (-541478725) without adopting or releasing the frame.
Validation or budget failures also leave ownership with the caller. Headers,
timebase and release function are snapshotted on acceptance; payload storage is
transferred, not cloned. Callers must not modify transferred payloads. A stream's
timebase can change only after its queued frames have drained.

`limit(stream, max)` sets a uint64 frame limit, including zero. `send(stream,
null)` signals producer EOF. Finishing a limiting stream can finish other streams
once their heads reach its final timestamp. `receive()` selects an available
stream in index order; `receive(stream)` selects one stream. A nonnegative code
identifies a received frame; `again` means unavailable and EOF means terminal
under the synchronization policy. A successful receive transfers its frame to
the caller, who must release it exactly once. Head advancement during a receive
may invoke the reference overflow-heartbeat behavior. Timestamp rescaling and
signed/unsigned wrapping follow the recorded Native profile in the validated
corpus. This is not an assertion of every undefined C overflow behavior.

Synchronization EOF can leave frames retained behind its termination boundary.
Always call `dispose()` on success, failure and early output closure. Disposal
attempts every retained release, drops queue-owned references and clears counts.
Release failures are retained in `cleanupErrors` and the same AggregateError on
repeated disposal. Received frames are outside queue ownership. An EOF alone
must not authorize publication: upstream read/processing failures and receiver
cleanup remain part of the enclosing job's error barrier.

`snapshot()` exposes deeply frozen diagnostic copies: stream timebases, heads,
limits, sent counts, pending counts, global head/finished state and retained
payload bytes. It does not expose mutable queue storage. Snapshots remain
available after disposal; mutating caller headers or release methods after a
send cannot redirect queue cleanup or accounting.

The cached host oracle has 110 cases / 21,575 complete operations for 1/2/3/4/8/32
streams, mixed clocks, unknown/backward timestamps, zero/dynamic/unlimited frame
limits, drained timebase changes, EOF and heartbeats. It executes actual pinned
sync_queue.c functions. Complete JSONL traces are archived with gzip under
`compat/behavior-specs/video-encoder-sync`; case SHA-256 values compare every
frame/result and state field, not a selected summary. Node tests verify archived
trace lines against those digests before comparing the public API. Local workerd
computes the same full trace digests in small batches without loading the large
reference archive. These are cached host-profile comparisons, not fresh Native
execution on every test run, Linux evidence or production Workers certification.

Regenerate with:

```sh
node tools/differential-runner/video-encoder-sync/generate-host.mjs
```

The builder validates the locked commit, clean tracked upstream source, included
C source, reference build, libraries, compiler and oracle hashes. Manifest hashes
cover the corpus, archive, digests, provenance and oracle. The compiler/host are
recorded; the toolchain is not claimed reproducibly pinned. See the package
NOTICE and `LICENSES/LGPL-2.1-or-later.txt` for source attribution.
