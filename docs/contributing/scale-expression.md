# Scale expression state

`createScaleExpressionState(options)` is exported by `@edge-ffmpeg/avfilter`.
It evaluates bounded single-input width/height expressions and tracks stored
expression text and output link geometry. It does not allocate image planes or
execute a graph. Expressions are capped at 4,096 UTF-16 code units and use the
public AVExpr compiler with the selected numeric profile. Input dimensions and
subsampling properties are validated and options are snapshotted.

`command(name, expression)` supports `w`/`width` and `h`/`height`. It returns a
Native-style status. Failed replacement restores expression text; Native partial
numeric link changes can remain observable in `snapshot`. Do not infer valid
output allocation geometry from an unsuccessful command. Snapshots are frozen.
`resolvedDimensions` exposes raw expression results before negative-factor and
forced aspect adjustment. Zero fallback, negative dimensions, SAR reset,
forced aspect and divisibility follow the pinned reference conversion order.

With `evalMode: 'frame'`, the scheduler supplies `evaluateFrame(number, seconds,
changed?)`. It controls Native frame numbering and property-change notifications.
NaN seconds represent unknown timestamps; infinite seconds and invalid frame
numbers are rejected. Expressions without n/t skip reevaluation unless properties
change. `updateInput(width, height, sar?)` changes metadata only; `reconfigure()`
evaluates it explicitly. Complete graph reinitialization remains caller-owned.
Reference-input variables explicitly throw an unimplemented error. Native casts
and unsupported-command codes use the selected numeric profile; recorded Native
comparison evidence here is Darwin arm64. This API does not certify undefined
C floating-to-integer overflow behavior across all platforms.

`dispose()` drops compiled evaluators and rejects future evaluation/commands.
Last snapshots remain readable. `scaleExpressionVariables` is an immutable list.

Regenerate the canonical init-mode corpus with:

```sh
node tools/differential-runner/scale-expression/generate-host.mjs
```

The shared pinned builder records source/library/binary/compiler provenance and
checks clean upstream. 484 cases / 2,840 command operations compare complete
status/expression/link state on Node and local workerd. The fixture streams bodies
under 64 KiB and accepts at most 16 cases with at most 16 commands each. The formal frame-mode corpus is regenerated with:

```sh
node tools/differential-runner/scale-expression/generate-frame-host.mjs
```

It feeds real frames and runtime commands into Native scale, then projects results
to geometry and command replies: 224 cases / 1,792 operations across 14 formats,
eight expression pairs and known/unknown PTS. All projected fields match the
public API in Node/local workerd. Pixel outputs and full actor/CLI graph evidence
remain separate from these public expression-state contracts.
This does not certify full scale flags, reference inputs, pixel arithmetic,
scheduler, CLI delivery, actual Cloudflare execution or full FFmpeg compatibility.
