# Per-filter timed command queue

`createFilterCommandQueue(nodes, {maxCommands,maxBytes})` is a public avfilter
kernel for resolved destination indices, with 1–128 nodes and explicit positive
safe-integer budgets. It does not resolve graph names, select a scheduler or
implement command handlers. Those integrations remain required work.

`enqueue(destinations, {name,argument,time,flags})` snapshots scalar headers and
copies a bounded index list. Names/arguments are immutable strings, limited to
4096 UTF-16 code units each without NUL. `flags` defaults to zero and must fit
signed32. Destination indices must be unique and valid, in Native registration
order. ONE (bit 1) selects the first destination; FAST and other bits are retained
without an immediate-command FAST fallback. An empty selection succeeds.

Insertion uses Native double comparisons: equal times preserve registration
order. A NaN timestamp inserts before existing entries and blocks processing at
that head; a later finite insertion can precede it. Infinity, negative infinity
and negative zero are preserved. Do not normalize these values into another
ordering policy. Retained queue state is unchanged when fanout exceeds a host budget. Native partial allocation-failure behavior is not claimed.

`process(node, seconds, execute)` calls the synchronous handler for due entries
and removes each after the call. Integer handler status codes are ignored as
Native does. A thrown host exception propagates after removing that entry;
remaining entries stay available for explicit cleanup or further processing.
Reentrant queue mutation/process/dispose, including from input getters or a
handler, is rejected; immutable
snapshots may be read. Handlers must not return asynchronous work.

The caller supplies input-link time in double seconds and the correct processing
stage. For unknown AV_NOPTS_VALUE, the reference command path compares
`Number(-(1n<<63n)) * (Number(tb.num)/Number(tb.den))`, unlike enable expressions'
NaN time variable. EOF does not automatically execute or remove future commands.
A source context with no incoming frames retains its commands until graph free.

`usage` gives frozen counts without enumerating entries. `snapshot` gives fresh
frozen per-node arrays and command objects. `dispose()` clears retained commands,
is idempotent and permanently rejects later enqueue/process calls. Budgets charge
`32 + 2*(name.length + argument.length)` per destination: a declared
storage policy, not actual JavaScript/native/Wasm allocation measurements or
whole-isolate/CPU certification. Account for caller, snapshots, handlers and
runtime overhead separately.

Regenerate evidence with:

```sh
node tools/differential-runner/filter-command-queue/generate-host.mjs
```

The registered builder verifies clean fixed upstream, reference binaries, static
libraries, private headers and source hashes. The oracle calls actual Native
graph queue/frame/close APIs and reads the real per-context queue after each
operation. The 64-case / 2752-operation corpus compares every retained command,
argument, IEEE double time bit pattern and flag on Node and local workerd, with
two clocks, equal/nonchronological/NaN/infinite times, missing PTS, signed flags,
ONE destinations and registration after EOF. Manifest hashes protect complete
traces and provenance. Linux Native, production Cloudflare, target-name routing,
all handlers and full CLI scheduling remain unverified requirements.
