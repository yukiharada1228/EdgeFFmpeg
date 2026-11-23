# Filter enable timeline evaluator

`createFilterEnableTimeline(supported, options)` is a public avfilter kernel for
FFmpeg's enable expression state. Pass an explicit expression `numericProfile`;
configuration and callback references are snapshotted. `supported` describes the
filter's actual timeline capability. It does not make an unsupported filter
support bypass. No production CLI or graph registration is added by this API.

`command(expression)` compiles `t`, `n`, `w`, `h` and returns `{code:0}` or parse
error `-22`. Unsupported capability returns PATCHWELCOME (`-1163346256`). The
host bounds arguments to 4096 UTF-16 code units and rejects embedded NUL.
`enabled({seconds,number,width,height})` evaluates once and tests absolute value
against 0.5; NaN is disabled. Unknown PTS is supplied as NaN seconds. Expression
state persists between calls and resets after a successful replacement.

The caller supplies the Native evaluation stages and frame number. Legacy flip
activation evaluates at consumption and again immediately before its callback:
`filter_frame_to_filter` restores the earlier frame count before the second
stage. Both calls see the same `n` but stateful expressions advance twice. Other
activation paths may evaluate once. The kernel does not choose a scheduling
policy, count frames automatically, convert timestamp clocks or perform bypass.

A failed replacement after a valid expression is a recorded Native crash
boundary. The public API returns -22 and then throws an explicit invalid-state
error on evaluation. A later valid command restores usable state. This recovery
is a host API behavior and is not claimed equivalent to the crashing Native
process. An initial invalid expression leaves the default enabled state.
`dispose()` is idempotent, drops compiled state/callbacks and permanently rejects
commands and evaluations afterward. Include upstream allocations and expression
work in the job's resource policy; this API does not certify whole-heap/CPU limits.

Regenerate cached evidence with:

```sh
node tools/differential-runner/filter-enable/generate-host.mjs
```

The registered oracle builder checks the fixed upstream commit, clean source,
reference binaries, compiler/configuration and static library hashes. The oracle
calls actual buffer/filter/sink and process-command APIs. The 48-case / 384-step
corpus covers hflip, vflip and their chain on 3x2 gray frames, known/unknown PTS,
thresholds, time/frame/dimension expressions and st/ld state. Differential and
local workerd tests compare command replies and every output pixel, timestamp,
duration and dimension. The manifest hashes corpus, source and provenance. The
Native invalid replacement reproducer is separate from passing cases.

Full graph scheduling, inline enable options, timed/interactive CLI commands,
all timeline-capable filters, Linux Native and production Cloudflare validation
remain required work rather than permanently excluded features.
