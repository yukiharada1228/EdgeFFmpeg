# Video filter registry

Every video filter path is built from one descriptor per operator. A descriptor holds its parsers, its negotiable formats, its geometry, its plan-time validation, its frame functions, its registry examples and one support flag per execution path. The parsers, the three format negotiators, the planners, the five executors, the actor and timed-executor allowlists and the graph clock all read the descriptor. None of them branch on operator names.

Adding an operator takes one new module, one import line and one array line in `registry.ts`. Other changes are needed only when the operator needs a new runtime service (see [Limits](#limits)).

This is a structural refactor. Accepted syntax, outputs, error classes and messages, ordering, resource accounting and public exports are unchanged, apart from the corrections listed in [Intentional corrections](#intentional-corrections).

## Layout

| File | Role |
|---|---|
| `packages/avfilter/src/video-ops/descriptor.ts` | The `VideoOperatorDescriptor` contract and its supporting types: `VideoExecutionPath`, `VideoOperatorRole`, the role step contracts (`VideoJoinStep`, `VideoRetimeStep`) and `ActorFrameContext`. Also `VideoFilterParseError`, `defineVideoOperator` and `singlePad`. |
| `packages/avfilter/src/video-ops/formats.ts` | The single negotiation table: `negotiationOrder`, the pixel-format traits, loss scoring, `chooseFormat` and the union-find merge. The linear, frame-graph and timed negotiators used to keep three copies of it. |
| `packages/avfilter/src/video-ops/<name>.ts` | One descriptor per operator: `null`, `format`, `scale`, `hflip`, `vflip`, `transpose`, `negate`, `split`, `nullsink`, `hstack`, `vstack`, `crop`, `setsar`, `setdar`, `setpts`. |
| `packages/avfilter/src/video-ops/options.ts`, `stack-options.ts`, `aspect-options.ts` | Option parsers shared by several descriptors: `bareStep` for option-free filters, `timelinePads` for the activation `enable=` timeline, `filterBoolean`, hstack/vstack, and setsar/setdar. |
| `packages/avfilter/src/video-ops/registry.ts` | `videoOperators` (one import line and one array line per operator), `videoOperator`, `supportsVideoPath`, `requireVideoPath` and `validateVideoOperator`. |
| `packages/avfilter/NOTICE-VIDEO-OPS` | Provenance of the code that moved into `video-ops/`. Each later operator adds its own `packages/avfilter/NOTICE-<NAME>`. |
| `packages/avfilter/src/index.ts` | The public barrel. It still exports every earlier name and type, and adds the registry functions and descriptor types. |
| `tests/unit/video-operator-registry.test.ts` | The registry test. It derives everything from the registrations, so adding an operator needs no edit to it (see [Registry test](#registry-test)). |

Pixel kernels stay in their existing modules (`video-flip.ts`, `video-transpose.ts`, `video-negate.ts`, `video-stack.ts`), and so do the runtime services `activation/crop.ts`, `activation/dynamic-scale.ts` and `setpts/state.ts`. Descriptors import them. The kernels are public API, and tests import them directly.

The step types come from the registry. `StaticVideoStep` is the union of every descriptor's scoped-parser step, and `TimedVideoStep` is the union of every activation-parser step. `ParsedVideoStep`, the frame-graph `GraphVideoStep` and the activation `GraphVideoStep` (exported as `TimedVideoGraphStep`) are built from these unions, so registering a descriptor extends them. `VideoFilterStage.operation` is typed as `VideoOperatorName`.

## Execution paths

| Path | Entry points | Parser | Unknown name | Registered but not flagged |
|---|---|---|---|---|
| `linear` | `compileVideoFilterChain`: simple `-vf` for rawvideo and for H.264/MP4 framecrc | `parseVideoFilterToken`, which only accepts operators flagged `linear` | `VideoFilterError: Unsupported video filter` | The parser raises the same message. The compile step checks the flag again (`Video filter <name> is not implemented for linear chains`). |
| `graph` | `compileVideoFilterGraph`, `compileMultiInputVideoFilterGraph`, the frame-graph `negotiateVideoTopology`, the avformat complex-video planner and `videoGraphClocks` | frame-graph `resolveVideoFilter`: any operator with a scoped `parse` | `Unsupported video filter` | `Unsupported video filter` if the operator has no scoped parser. Otherwise `Video filter <name> is not implemented for graph execution`. |
| `stream` | `createReplayVideoExecution`: the multi-input CLI | the frame-graph parser, plus a `stream` flag check after the `graph` check | `Unsupported video filter` | As for `graph`, then `Video filter <name> is not implemented for stream execution` |
| `actor` | `createFrameActors`, `createActorMultiInputDriver`, and the `activation`, `read-frames`, `queued`, `scheduled` and default `producer` schedulers of `createTimedVideoBackend` | activation `resolveVideoFilter`: `parseTimed`, falling back to `parse` | `Unsupported video filter` | `Actor operators not implemented` |
| `timed` | avformat `createTimedGraphExecution`: the spool DAG executor behind the timed backend's `pull` scheduler | the plan from `planTimedVideoGraph` | `Unsupported video filter` from the planner. A forged plan gets `Timed executor operator remains unimplemented: <name>`. | `Actor operators not implemented` from the planner when the operator is flagged for neither `actor` nor `timed`. Otherwise the executor raises `Timed executor operator remains unimplemented: <name>`. |

`planTimedVideoGraph` plans for both the `actor` and the `timed` paths, and each executor then checks its own flag. Every executor resolves its descriptors once, before planning or I/O. A step whose descriptor does not flag the executor's path is rejected; it is never passed through unchanged.

## Support matrix

| Operator | Role | linear | graph | stream | actor | timed |
|---|---|---|---|---|---|---|
| null | identity | yes | yes | yes | yes | yes |
| format | identity | yes | yes | yes | yes | yes |
| scale | resize | yes | yes | yes | yes (`eval`, expressions) | yes (constant sizes) |
| hflip, vflip | frame | yes | yes | yes | yes (`enable=`) | yes |
| transpose | frame | yes | yes | yes | yes | yes |
| negate | frame | yes | yes | yes | – | – |
| split | fanout | – | yes | yes | yes | yes |
| nullsink | sink | – | yes | yes | yes | yes |
| hstack, vstack | join | – | yes | yes | yes | yes |
| crop | frame | – | – | – | yes | – |
| setsar, setdar | frame | – | – | – | yes | – |
| setpts | retime | – | – | – | yes | yes |

These flags reproduce the former name allowlists exactly, and the registry test pins them. The timed executor still refuses inline `enable=` and expression-sized `scale` before it checks flags (`Inline dynamic filter expressions currently require activation execution`). Operators added in later waves get their rows here when the coordinator merges them; operator branches do not edit this table.

## Roles

A path never infers behaviour from a name. It maps the descriptor's role to one branch:

| Role | linear | graph / stream | actor | timed |
|---|---|---|---|---|
| `identity` | negotiation only, no stage | input forwarded | 1:1 filter callback, frame unchanged | input forwarded |
| `fanout` | not allowed | input forwarded to every output | split callback | spool readers per output |
| `sink` | not allowed | no output | nullsink callback | drained |
| `resize` | resize stage (`geometry`) | converter (`geometry`) | dynamic scale | converter |
| `frame` | operation stage (`frame`, `bypass`, `validate`, `stageFields`) | `frame` unless `bypass` | `actorFrame`, or `frame` unless `bypass` | `frame` unless `bypass` |
| `join` | not allowed | timestamp sync, then `combine` | sync engine, then `combine` | timed synchronization, then `combine` |
| `retime` | not allowed | not allowed | PTS transform (`VideoRetimeStep`) | setpts stream |

## Descriptor contract

| Member | Used by | When omitted |
|---|---|---|
| `name`, `role`, `paths` | everything | required |
| `examples` | the registry test, which runs each example on every flagged path and checks the rejection on every other path. Each example is a filtergraph fragment whose first filter takes the only input and whose last filter gives the only output, valid on an 8x8 gray source. | required, at least one |
| `parse(token)` | the linear parser, the frame-graph resolver and the activation fallback. Returns `FilterPads` with a frozen configuration. | no scoped syntax |
| `parseTimed(token)` | the activation resolver (`enable=`, expressions, crop/aspect/setpts options) | `parse` |
| `formats(step)` | all three negotiators. It returns the candidates shared by every pad, in preference order: a non-empty, duplicate-free list of `negotiationOrder` entries. It may depend on the step. | every negotiable format |
| `geometry(step, inputs)` | linear stage size, frame-graph negotiation and timed negotiation, always with the negotiated input shapes (format, width, height). Size-dependent refusals throw here. On the linear path they are wrapped in `VideoFilterError`. | input size |
| `timedGeometry(step, context)` | timed negotiation: the size, the sample aspect ratio and an optional replacement step (setdar stores the frame aspect it resolved) | `geometry`, keeping the input aspect |
| `validate(format, step)` | linear plan (wrapped in `VideoFilterError`), frame-graph accounting and timed negotiation, so every path, with the negotiated input format | no check |
| `bypass(step, width, height)` | every frame path (transpose `passthrough`) | never bypassed |
| `frame(frame, step, options)` | linear, graph, stream, timed, and actor when there is no `actorFrame`. It must return owned tight planes within `options.maxFrameBytes`, observe `options.signal`, and repeat any size check made in `geometry`. | – |
| `combine(frames, step, options)` | join roles | – |
| `join` | the join clock and synchronization rule on the graph, stream, actor and timed paths, resolved by `videoJoinPlan` (`packages/avfilter/src/video-join.ts`) at plan time, before any output. Every input has framesync `sync=1` and `before=EXT_STOP`, and the output time base is the `av_gcd_q` of the input time bases. `rate: 'common'` is the vf_stack rule: the output frame rate is the inputs' shared declared rate, or 1/0 when any differs (hstack, vstack, xstack). `rate: 'base'` is the rule of the framesync filters whose `config_output` sets `ol->frame_rate = il->frame_rate` (maskedmerge, maskedmin, maskedmax, maskedclamp, maskedthreshold, threshold, xmedian, limitdiff, midequalizer, hysteresis, mix): the output frame rate is input 0's. `props: 'none'` (the default) is an output from `ff_get_video_buffer` (vf_stack, xmedian, mix): no duration and no decoder time base, so `-enc_time_base demux` fails as natively. `props: 'base'` is `av_frame_copy_props` from input 0's synchronized frame (maskedmerge, maskedmin, maskedmax, maskedclamp, maskedthreshold, threshold, limitdiff, midequalizer, hysteresis): output frames keep its duration value unrescaled, its interlacing and its decoder time base; it needs `rate: 'base'`. `after(step, inputs)` gives `in[i].after` per input pad after the filter's own options (framesync `shortest`, `eof_action`, vf_mix `duration`); mixed `stop` and `infinity` modes are refused at plan time, and options native resolves to `EXT_NULL` (`repeatlast=0`, `eof_action=pass`) or another `ts_sync_mode` must be refused by the parser. Evidence: `tests/differential/video-join-rate.test.ts`. | `{rate: 'common', props: 'none'}`, with `after` `stop` on every pad under `step.shortest` and `infinity` otherwise |
| `stageFields(step)` | extra public fields of `VideoFilterStage` (transpose `direction`, negate `negate`) | none |
| `actorFrame(frame, step, context)` | the activation callback, with node services: the consumed event, the configured output, the current link geometries, timeline re-evaluation and crop state | `frame` and `bypass` |
| `timeline` | the activation `enable=` timeline accepts commands | `false` |
| `geometryCommands` | the activation `w`/`h`/`x`/`y` commands. `resize` nodes use dynamic scale and other nodes use crop state. | `false` |
| `stripsFrameRate(step)` | the timed planner and actor clocks (setpts `strip_fps`) | `false` |
| `stateful(step)` | `planTimedVideoGraph().statefulNodes` | `false`; `enable=` always marks the node |

## Registry validation

`registry.ts` validates every descriptor when the module loads. A violation throws `Invalid video operator descriptor <name>: <reason>`. A bad descriptor therefore makes every import of `@edge-ffmpeg/avfilter` fail, and every test with it. The rules are:

- **Names.** A name matches `[A-Za-z0-9_]{1,64}`, is unique, and is not one of the timed planner's pseudo nodes (`source`, `sink`, `trim`). Lookups use a `Map`, so `constructor` or `__proto__` never resolve to an operator.
- **Paths.** The paths are distinct members of `videoExecutionPaths` and allowed for the role (see [Roles](#roles)).
- **Parsers.** Scoped paths need `parse`; `actor` and `timed` need `parseTimed` or `parse`.
- **Role members.**
  - A `frame` flag needs `frame`, or `actorFrame` on `actor` only.
  - A `join` needs `combine` and `geometry`.
  - A `resize` needs `geometry`.
- **Stream needs graph.** `stream` also requires `graph`, because replay streams compile with the frame-graph planner.
- **Members outside their role.** These would run on some paths and not on others, so they are rejected:
  - `geometry` and `timedGeometry` need role `resize`, `frame` or `join`.
  - `validate`, `bypass`, `frame`, `stageFields` and `actorFrame` need role `frame`.
  - `combine` needs role `join`.
  - `join` needs role `join`, a `rate` of `common` or `base`, a `props` of `none` or `base` (`base` only with rate `base`), and `after`, when present, must be a function.
- **Examples.** `examples` is a non-empty array of non-empty strings.

## Registry test

`tests/unit/video-operator-registry.test.ts` reads `videoOperators` and each descriptor. Adding an operator needs no edit to it:

- **Registration.** Names are unique and compared without regard to order. Each descriptor is frozen, passes `validateVideoOperator`, has examples, and answers `supportsVideoPath` and `requireVideoPath` for every path. A `legacy` table, one line per operator, pins the flags of the fifteen operators that predate the registry; later operators are never added to it.
- **Flagged paths.** Every example runs on every flagged path through that path's public entry point, with two frames from an 8x8 gray source and scalar arithmetic. Each path's output must equal the first flagged path's output: tight rows, format, size and timestamps in seconds. This catches a path that silently passes a step through. The test also checks that `formats(step)` satisfies the contract for every parsed example step.
- **Unflagged paths.** Every registered operator that does not flag a path is rejected on it with the message derived in [Execution paths](#execution-paths). On `linear` the test uses the bare name, `null,<name>` and `<name>,null`; elsewhere it uses the examples. Unknown names (`bogus`, `constructor`, `__proto__`, `source`, `sink`, `trim`) are rejected on every path. A forged timed plan reaches the timed executor's own check.
- **Helper filters in examples.** In the rejection checks, the expected error must come from the operator under test, so an example may combine it only with filters flagged on every path except `linear`: `null`, `format`, `scale`, `hflip`, `vflip`, `transpose`, `split`, `nullsink`, `hstack` and `vstack`.

Mutating any executor to pass frame operators through, removing the timed negotiator's `validate` call, or making the timed executor check the wrong flag makes this test fail.

## Intentional corrections

1. **negate in the timed planner.** `planTimedVideoGraph` rejects operators flagged for neither `actor` nor `timed` with `Actor operators not implemented`, before any output is opened. Today that is only `negate`. Before, it returned a plan for `negate` that no timed executor could run. That plan also negotiated every format, including nv12, because the timed negotiator's private table did not restrict negate. The timed backend still reports the same `Actor operators not implemented` diagnostic.
2. **One format table.** The timed negotiator uses the shared table, so `negate` candidates are restricted there too, as they already were in the linear and frame-graph negotiators.
3. **Validation in the timed negotiator.** The timed negotiator now runs `validate` with the negotiated input format, as the linear and frame-graph planners already did. No registered operator that reaches it today has `validate`, so no result changes.
4. **No silent pass-through.** Executors and planners reject steps their path does not flag, and the frame-graph negotiator rejects them too. With today's registry, parsing already rejects every such step on the linear, graph and stream paths, so these checks change no observable result. They replace the former silent pass-through of steps that had no branch.

## Evidence

Behaviour preservation was checked beyond the suites with an old-versus-new harness. The harness loads the pre-refactor commit 9fd9ae3 and the refactored tree side by side and compares every result and error:

| Surface | Cases compared |
|---|---|
| The three parsers, over 73 tokens | 219 |
| Linear chains: steps, stages, accounting and output pixels | 1496 |
| Frame graphs: negotiation, accounting, outputs and topology | 495 |
| Timed plans | 460 |
| Activation actor runs | 69 |
| Replay streams | 60 |
| Timed graph executor runs: outputs, terminal events and errors | 168 |

Everything matched except the planned `negate` rejection. The harness was re-run on the final tree with the same counts.

Nine prototype operators were registered in a scratch copy of the final tree. Each was one module plus one import line and one array line, added by a script the way a branch would add them. They covered:

- an identity (`copy`);
- a plane swap (`swapuv`);
- two size changes: a field extraction and a 2x/3x upscale (`field`, `epx`);
- step-dependent formats (`shuffleplanes`);
- a `validate` refusal (`chromashift` on yuva420p);
- a `geometry` refusal that depends on the negotiated format (odd plane heights, as `il` needs);
- a linear/graph/stream-only operator;
- a linear-only operator.

The unchanged registry test passed with them (8 tests), and so did a 5-test probe of refusals and geometry on every path. The typecheck and lint were clean. `validate` and `geometry` refusals surfaced on all five paths, and the three negotiators chose the same formats for step-dependent `formats`.

Three mutations were then made in that copy:

- the replay stream passing `frame` operators through;
- the activation actor passing `frame` operators through;
- the timed executor checking the `actor` flag instead of `timed`.

The unchanged registry test failed on each of them.

The video suites against the pinned native reference are recorded in the validation stage, together with the test contracts.

## Adding a video operator

Each operator owns these files and touches nothing else:

| File | Content |
|---|---|
| `packages/avfilter/src/video-ops/<name>.ts` | the descriptor |
| `packages/avfilter/src/video-<name>.ts` | optional: a large kernel, as `negate` does with `video-negate.ts` |
| `packages/avfilter/NOTICE-<NAME>` | provenance |
| `packages/avfilter/src/video-ops/registry.ts` | **+1 import line, +1 array line** |
| `tests/unit/video-<name>.test.ts` | unit tests |
| `tests/differential/video-<name>.test.ts` | differential tests against `.build/reference/ffmpeg` |
| `docs/contributing/<name>.md` | the operator's documentation |

If your task lists different file names, use those. For example, `copy` uses `video-copy-filter` for its tests and docs and `NOTICE-VIDEO-COPY`, because `video-copy-ts` files already exist. Each operator owns its own `packages/avfilter/NOTICE-<NAME>`. Never append to the shared `NOTICE`.

Do not edit `tests/unit/video-operator-registry.test.ts`, `packages/avfilter/src/index.ts`, the shared `packages/avfilter/NOTICE`, the support matrix above, or the `compat/*.json` and `development-status.md` evidence files.

1. **Write the descriptor.** Declare the step type and export one `<name>Operator`. A geometry-preserving per-frame operator needs `parse`, `formats`, `frame` and `examples`:

   ```ts
   // SPDX-License-Identifier: LGPL-2.1-or-later
   // Adapted from pinned FFmpeg libavfilter/vf_<name>.c. See ../../NOTICE-<NAME>.
   import {filterOptions} from '../video-syntax.js';
   import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
   import {negotiationOrder} from './formats.js';
   export type <Name>Step={readonly name:'<name>';/* parsed options */};
   /** Native query_formats intersected with the negotiation table, in table order. */
   const formats=Object.freeze(negotiationOrder.filter(format=>[/* native list */].includes(format)));
   export const <name>Operator=defineVideoOperator<<Name>Step>({name:'<name>',role:'frame',paths:['linear','graph','stream'],examples:['<name>','<name>=<option>=<value>,hflip'],
    parse(token){
     for(const option of filterOptions(token.options,[/* native shorthand order */])){/* accept each declared option, else: */throw new VideoFilterParseError('Unsupported <name> option');}
     return singlePad(Object.freeze({name:'<name>'}));
    },
    formats:()=>formats,
    frame:(frame,step,options)=>{/* owned tight planes, bounded by options.maxFrameBytes, options.signal checked per row */return frame;}});
   ```

   Then add only the hooks the operator needs:
   - **Option-free filters.** Use `parse:token=>singlePad(bareStep('<name>',token))` from `./options.js`. It refuses every option, including `enable=`.
   - **Identity operators.** Use `role:'identity'` with no `frame` (for example `copy`). Omit `formats` when every table format is accepted.
   - **Formats that depend on options.** `formats(step)` may compute the list from the step, as shuffleplanes does. If no format qualifies, throw from `parse` or `formats` rather than returning an empty list.
   - **Format-dependent refusals.** Put them in `validate(format, step)`, for example chromashift refusing yuva420p. Every path calls it with the negotiated input format.
   - **Size changes and size-dependent refusals.** Put them in `geometry(step,[input])`, for example field, epx, odd heights or width-1 planes. Repeat the check in `frame`, because the actor path can deliver reconfigured frames. With no `timedGeometry`, timed plans keep the input sample aspect ratio. Add `timedGeometry` only when the native filter changes it.
   - **Native semantics.** Keep native option semantics. Reject every unimplemented option, value, `enable=` and runtime command explicitly; never ignore one. Runtime commands are refused automatically unless the descriptor sets `timeline` or `geometryCommands`. Never mirror native reads of uninitialized or out-of-bounds memory; refuse those cases in `geometry` or `validate`.
   - **Examples.** Run on an 8x8 gray source with two frames. Choose options that are valid there, and combine the operator only with the helper filters listed in [Registry test](#registry-test).
2. **Register it.** In `packages/avfilter/src/video-ops/registry.ts`, add `import {<name>Operator} from './<name>.js';` as a new line after the last operator import. Add ` <name>Operator,` as a new line before `] as const);`. Do not reflow other lines. Order does not matter.
3. **Choose the paths from evidence.** Flag a path only when differential tests against `.build/reference/ffmpeg` pass on it:
   - `linear`: `compileVideoFilterChain` and `-vf`.
   - `graph`: `compileVideoFilterGraph` and `-filter_complex`.
   - `stream`: `createReplayVideoExecution`. It requires `graph`.
   - `actor` and `timed`: the timed backend.

   A stateless `frame` operator needs no extra code for `actor` or `timed`: both call `frame`. Use `actorFrame` only for node services (`enable=`, configured padding, crop state or the output aspect). If actor or timed tests are not ready, flag `linear`, `graph` and `stream` only. The registry test then checks the actor and timed rejections automatically.
4. **Record provenance.** Write `packages/avfilter/NOTICE-<NAME>` following `packages/containers/NOTICE-W64`:
   - a title line;
   - which upstream functions the module follows (for example `libavfilter/vf_<name>.c` `filter_frame`, `query_formats`);
   - `Fixed FFmpeg commit:946fcce07b6dcd0331c8cc609192aeff5e1924f8`;
   - the upstream copyright lines and `LGPL-2.1-or-later`;
   - a pointer to `../../LICENSES/LGPL-2.1-or-later.txt`;
   - a sentence saying it is a scoped adaptation.
5. **Test.**
   - **Unit tests:** parsing and refusals, `maxFrameBytes`, malformed strides, `AbortSignal`, and that the input frame is not mutated.
   - **Differential tests:** run native at test time and compare rawvideo and framecrc bytes on every flagged path, using inputs in the operator's own formats. Run any implicit conversion with `-cpuflags 0`. Use structured patterns as well as noise.
   - **Rejection tests:** an explicit test of the rejection on each unflagged path is welcome. The registry test already derives one.
6. **Document it.** Write `docs/contributing/<name>.md`: the syntax, supported and refused forms, formats, paths, the determinism and arithmetic profile, evidence counts, and the scoped test contracts (file, exact test title, scope).
7. **Run the checks:**

   ```sh
   npx vitest run tests/unit/video-<name>.test.ts tests/unit/video-operator-registry.test.ts
   npx vitest run tests/differential/video-<name>.test.ts --maxWorkers=1
   npm run typecheck && npm run lint && npm run boundaries
   ```

## Hooks for the planned operators

Each planned operator fits the contract as one module plus the two registry lines. No other shared file changes.

| Operator | Role | Hooks beyond `parse`, `examples` and `paths` |
|---|---|---|
| copy | identity | none: `bareStep`, no `formats` (every table format), no `frame` |
| swapuv | frame | `formats` (planar YUV in table order), `frame` |
| limiter | frame | `formats`, `frame`. `parse` throws for min > max, before any output. |
| pixelize | frame | `formats`, `frame` |
| shuffleplanes | frame | `formats(step)` computed from the maps (throw if none qualifies), `frame` |
| chromashift | frame | `formats`, `validate` (refuses yuva420p), `frame` (repeats the check) |
| erosion, dilation, deflate, inflate | frame | `formats`, `geometry` (refuses width-1 planes of the negotiated format, keeps the size), `frame` (repeats the check) |
| il | frame | `geometry` (refuses odd processed plane heights), `frame` |
| field | frame | `geometry` (height `(h + top) / 2`; refuses `bottom` when `h == 1`, and when `h % 4 == 2` with vertically subsampled chroma in the negotiated format), `frame`. The default timed aspect is kept. See [Limits](#limits) for H.264 framecrc. |
| fillborders | frame | `formats`, `geometry` (border and `margins` width refusals), `frame` |
| epx | frame | `formats` (packed RGBA), `geometry` (`n` times the size), `frame` bounded by `maxFrameBytes` |

None of them needs `actorFrame`, `timedGeometry`, `timeline`, `geometryCommands`, `stripsFrameRate` or `stateful`. Their `enable=` options and runtime commands are refused.

## Merging parallel additions

`registry.ts` keeps one import line and one array line per operator, each array line ending with a comma. Branches that each add one operator therefore touch disjoint lines, or adjacent lines at the end of the import block and the array.

The coordinator resolves conflicts in this file by keeping both sides: every import on its own line, and every array entry on its own line with a trailing comma. The repository's `.gitattributes` marks `packages/avfilter/src/video-ops/registry.ts` (and the audio and container registries) `merge=union`, so a local `git merge`, `git merge --squash` or `git rebase` keeps both sides automatically. Hosted merge buttons may not honour it; merge locally. After the merges, `npm run typecheck` and `tests/unit/video-operator-registry.test.ts` confirm the union: a lost import is a type error, and a duplicate entry fails registry validation.

## Limits

- **Sample aspect ratio on H.264/MP4 framecrc.** `packages/avformat/src/mp4-h264.ts` derives the header's sample aspect ratio from `VideoFilterStage`. It special-cases `operation==='transpose'` and treats any other size change as a scale. A linear-path operator whose size change keeps the aspect ratio unscaled (field halves the height and keeps the aspect ratio) therefore reports a different aspect on H.264 input than native does. Uniform scaling such as epx is unaffected. Until that module reads the aspect ratio from the descriptor, size-changing operators should prove the H.264 framecrc header on that path, or not rely on it.
- **Geometry commands.** They reach `resize` nodes through dynamic scale and every other answering node through crop state. A new operator that answers `w`/`h` commands needs its own runtime service in `activation/actors.ts`.
- **Format-list checks.** The frame-graph and timed negotiators do not re-check `formats(step)` output, because `format=` lists keep their former diagnostics there. An empty or invalid list fails during negotiation with `Unsupported branch converter` instead of the linear path's `Invalid video format candidates`. The registry test checks the contract for every example.
