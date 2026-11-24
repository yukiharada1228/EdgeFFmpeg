# Audio filter registry

The bounded linear audio chain (`compileAudioFilterChain`, [audio filters](audio-filters.md)) is built from one descriptor per filter. A descriptor holds everything the chain and its avformat consumers need to know about the filter: parsing, planning, packet boundaries, sample-format negotiation, constraints, stateless and stream execution, capability flags, resource reservations and its own representative tokens. Neither the chain nor the consumers branch on filter names.

Adding a filter means adding one descriptor file and one registry line. Its tests, documentation and `NOTICE-<NAME>` are new files too; no shared file changes.

This is a structural refactor. For the seven pre-registry filters, accepted syntax, outputs, error classes and messages, ordering, resource accounting and public exports are unchanged, apart from the three corrections listed below. Everything else is additive: a native format-list negotiation model, the `transparent` and `nativeFormats` descriptor fields, the `negotiated` stream argument, the `flacInput` capability, native layout names for non-default container masks, and new chain members (`capabilities`, `has`, `reservations`, `plannedReservations`, `negotiatedSampleFormats`, `nativeFormatLists`).

## Layout

| File | Role |
|---|---|
| `packages/avfilter/src/audio/descriptor.ts` | The `AudioFilterDescriptor` contract, `AudioFilterCapabilities`, `AudioReservation`, `AudioFormatSet`, `AudioFilterError` and shared helpers (`defineAudioFilter`, `packed`, `isInteger`, `widths`, `sampleFormats`, `nativeSampleFormats`, `frameReservation`, `noReservation`). |
| `packages/avfilter/src/audio/<name>.ts` | One descriptor per filter: `anull`, `volume`, `asetrate`, `asetnsamples`, `aformat`, `apad`, `adelay`. |
| `packages/avfilter/src/audio/registry.ts` | One `export {<name>} from './<name>.js';` line per filter. |
| `packages/avfilter/src/audio/chain.ts` | `compileAudioFilterChain`. It looks each token up in the registry and runs generic loops over the descriptors, including the native negotiation model. |
| `packages/avfilter/src/index.ts` | Public barrel. It still exports every earlier name and type, and adds the descriptor, capability and reservation types. |
| `packages/avfilter/NOTICE-AUDIO-NEGOTIATION` | Provenance of the registry and of the negotiation model (libavfilter `avfiltergraph.c`, `formats.c`). |
| `packages/avformat/src/pcm-filter-memory.ts` | Translates the chain's planned reservations into the PCM memory plan's inputs. |
| `packages/avutil/src/channel-layout-name.ts` | `channelLayoutName(mask)`, native's name for a channel mask. The PCM path uses it for an input whose container mask is not the default, so constraints see that layout (provenance in `packages/avutil/NOTICE-CHANNEL-LAYOUT-NAME`). |
| `packages/avformat/src/flac-wave-filters.ts` | `processFlacAudioFilters` reserves the chain's reservations before any filter allocation. |

Stateful engines stay in their existing modules: `delay.ts`, `pad.ts` with `pad-checkpoint.ts`, and `reframe.ts` with `reframe-state.ts`. Descriptors import them. They were not moved, because tests import `pad-checkpoint.js` and `reframe-state.js` directly and the compatibility reports cite `pad.ts` and `reframe.ts`.

`AudioFilterStep` is derived from the registry: it is the union of every registered descriptor's step type. Registration order has no effect. A token matches the descriptor whose name is the text before its first `=` (or the whole token). Unknown names fail with `Unsupported audio filter: <token>`.

When the registry module loads, the chain throws `Invalid audio filter registration: <name>` unless:

- the export name equals the descriptor's `name`;
- the descriptor has exactly one of `apply` and `stream`. `process()` runs `stream` whenever it exists, so a second hook would make the step count as stateless while it keeps state;
- it has at least one `examples` token;
- it declares no `negotiate` or `nativeFormats`, unless it is one of the pre-registry approximations adelay, aformat and volume. That list is frozen in `chain.ts`.

Compiling then checks each step and throws a plain `Error` (on the CLI, `unsupported-filter`, before anything is opened):

- `Invalid audio filter format list: <name>`: an array `formats()` is empty, has duplicates or holds a non-native format;
- `Invalid audio filter format set: <name>`: `formats()` returns a string other than `'all'` from a descriptor other than adelay, aformat and volume. No merge model checks that vocabulary, so a new filter declares its native list as an array;
- `Invalid audio filter declaration: <name> generates output without count()`: without `count()`, the PCM range stops at the input count and would cut the generated tail silently.

`tests/unit/audio-filter-registry-contract.test.ts` loads the chain with scratch registrations to pin the load-time refusals.

## Descriptor contract

| Hook | Used by | Default when omitted |
|---|---|---|
| `name`, `parse(text)` | Compiling. `text` is the trimmed token, either `name` or `name=…`. `parse` returns a frozen step or throws `AudioFilterError`. | required |
| `examples` | The registry tests, which check every token against every consumer's contract. | required, non-empty |
| `capabilities(step)` | `chain.capabilities`, `chain.has()`, `audioFilterCapabilities(step)`, consumers | required: declare the six flags below; `flacInput` is optional and defaults to false |
| `outputRate(step)` | Count planning, `outputSampleRate`, `rateBoundary` (stops backward rate propagation), format validation | rate unchanged |
| `count(step, samples, rate, {configuredInput, channels})` | `planSamples`/`outputSamples`/`requiredBufferSamples`, `packetSections`, `plannedReservations`. Returns `{samples, buffers, packets?}` at the step's input rate. | count unchanged, no buffers; required with `generatesOutput` |
| `packetSpan(step)` | `outputPacketSamples` | span unchanged |
| `bufferedSamples(step)` | `maxBufferedSamples` | 0 |
| `precision(step)` | `maxBytesPerSample`, `outputSampleFormat` (the last non-null kind wins) | none; for an array set, the widest listed width with no kind |
| `formats(step)` | Negotiation. An array is the filter's native sample-format list (see [Sample-format negotiation](#sample-format-negotiation)). `'all'` merges the neighbouring sets. The other strings are the pre-registry vocabulary, accepted only from adelay, aformat and volume: `'planar'`/`'integer'` restrict the merged set, a sample format pins it. | `'all'` |
| `nativeFormats(step)` | Pre-registry only (volume, adelay): the native list a string `formats()` approximates, read by the negotiation model. Any other descriptor that declares it fails registration. | derived from `formats()` |
| `transparent` | The negotiation model only: output samples are input samples (copied, permuted, delayed, padded with silence), so the working format never changes values and the model does not compare it | implied by `'all'` |
| `negotiate(step, input, {outputHint, nextPinned, planarNeighbour})` | Pre-registry only (volume). `resolvedSampleFormat`, `negotiatedSampleFormats`, `requiresScalarRounding`, `rateBoundary`, per-step targets. Any other descriptor that declares it fails registration. | for an array, the native pick; the pinned format; the planar form for `'planar'`; otherwise the input |
| `constraint(step)` | `validateInputFormat`, per-frame checks in `apply()` and `process()`, and the configured-empty-input requirement. It sees `{sampleRate, channels, channelLayout}`; see [Constraints](#constraints). | no check |
| `apply(step, frame, target, options)` | `apply()` and stateless steps inside `process()`. `target` is the negotiated format; return a new frame in it. Exactly one of `apply` and `stream`. | `<name> requires stream processing` |
| `stream(step, frames, options, configured, negotiated)` | `process()`. `negotiated(frame.sampleFormat)` is the format the step works in and emits. Exactly one of `apply` and `stream`. | per-frame `apply` |
| `configure(step, format)` | The configured empty-input format passed to later steps. The chain then sets the negotiated sample format. | format unchanged |
| `reserve(step, {sampleRate, channels, sampleFormat, samples?, configuredInput?})` | `chain.reservations(input)` (FLAC helper) and `chain.plannedReservations(input, plan)` (PCM plan) | nothing reserved |

`count().packets` declares a step's packet-boundary effect: `reframe` regroups all samples into packets of that span, `leading` prepends a run and `trailing` appends one. `packetSections` applies it to sections and fails with `<name> packet sections disagree with its sample count` when the sections do not sum to the declared count, so a step that changes its count must declare its packet effect. `AudioFilterCountStage.packets` records the effect for `filteredPacketSchedule`, which applies `reframe` and `trailing` to the resampled schedule. There, a `leading` run fails with `unsupported-command` ("Leading filter output requires unimplemented resampled packet scheduling"), and so does any step whose `rateConversion` is false (`<name> with sample rate conversion is not implemented`). Both paths are currently unreachable, because `rateBoundary()` refuses those steps first.

## Capabilities

| Flag | Meaning | Consumer |
|---|---|---|
| `generatesOutput` | Emits packets beyond its input's, including from a configured empty input | PCM CLI padding sections, packet-time handling and `generatedOutput` (`avformat/src/index.ts`) |
| `reframes` | Output counts, boundaries, cross-frame state or timestamp-dependent samples: output time selection follows the filter instead of narrowing its input | `chain.reframes`: PCM CLI ranges (WAV, AIFF, AU, W64, raw) and the FLAC timed buffered path |
| `allocatesFrames` | Allocates new output frames: one frame-producing stage | PCM memory plan (`volumeNodes`) |
| `formatConstraint` | Explicit format constraint: automatic rate conversion is negotiated inside the chain | FLAC inserted-rate path and its placement checks |
| `rateConversion` | Accepts automatic sample-rate conversion | `rateBoundary` fails with `<name> with sample rate conversion is not implemented` |
| `timeSelection` | FLAC only: pinned evidence covers the step between FLAC input and output time selection | FLAC timed refusal (`flac-transform.ts`) |
| `flacInput` (optional, default false) | FLAC only: pinned evidence covers the step on FLAC input | FLAC refusal before decoding, `FLAC input to <name> requires additional Native evidence` (`flac-transform.ts`); the timed check runs first |
| `stateless` (derived from `apply`) | `apply()` handles the step | FLAC resampling placement checks |
| `changesRate` (derived from `outputRate`) | Fixes the output rate | FLAC resampling placement with `aformat` |

The chain derives three flags beyond what a descriptor declares:

- `reframes`: a stream step or a step with `generatesOutput` always reframes. That keeps cross-frame state correct on the PCM path with output `-ss`/`-t`/`-to`: the whole input is filtered and the selection is taken from the filter output, as native does. A stateless `apply()` whose samples depend on the frame timestamp cannot be detected, so it must declare `reframes: true` itself.
- `rateConversion`: a step whose `formats()` is an array never accepts automatic rate conversion, because the negotiation model has no rate boundary.
- `timeSelection`: false without `flacInput`, because FLAC time selection is evidence on FLAC input.

`timeSelection` is not consulted on PCM paths; there `reframes` decides.

| Filter | generatesOutput | reframes | allocatesFrames | formatConstraint | rateConversion | timeSelection | flacInput | stateless | changesRate |
|---|---|---|---|---|---|---|---|---|---|
| anull | – | – | – | – | yes | yes | yes | yes | – |
| volume | – | – | yes | – | yes | yes | yes | yes | – |
| asetrate | – | – | – | – | yes | – | yes | yes | yes |
| asetnsamples | – | yes | – | – | yes | yes | yes | – | – |
| aformat | – | – | with `f` | yes | yes | with any option | yes | yes | – |
| apad | yes | yes | yes | – | yes | yes | yes | – | – |
| adelay | yes | yes | yes | – | – | – | yes | – | – |

Each column reproduces the name lists that the consumers used before; untimed FLAC input ran every pre-registry chain, so each declares `flacInput`. `tests/unit/audio-filter-registry.test.ts` checks this against those former predicates.

## Sample-format negotiation

### Pre-registry vocabulary

The seven pre-registry filters keep their string sets and negotiation rules, so chains made only of them negotiate exactly as before. Volume pins packed `flt`/`dbl` or keeps packed integers, adelay takes the planar form of its input, and aformat pins its format. Those rules were verified against native for those filters and their neighbours only. That is why no other descriptor may use them: a new descriptor that returns `'planar'`, `'integer'` or a pinned string fails to compile, and one that declares `negotiate` or `nativeFormats` fails registration. Its arithmetic would otherwise run in a format no native comparison checked, for example a fixed volume kept at u8 beside an input-trimmed list that native merges to s16p.

### Native format lists

A new filter declares `formats()` as its native list, copied in source order from `FILTER_SAMPLEFMTS`, `FILTER_SINGLE_SAMPLEFMT` or `query_formats` in `upstream/ffmpeg/libavfilter`. Use a one-entry array for a pinned format: `['s32p']` for dcshift, `['flt']` for extrastereo. For `ff_planar_sample_fmts()`, use `['u8p','s16p','s32p','fltp','dblp','s64p']`. Keep `'all'` (the default) for filters that never change sample values (copies, reframing, padding, metadata).

When a chain contains an array set, the chain reproduces native negotiation for a linear graph (`libavfilter/avfiltergraph.c`, `formats.c`):

1. **Merging.** Format lists merge along links from left to right. A link whose lists share a format merges them into their intersection. Otherwise a converter is inserted and a new segment starts. The CLI's source format merges first, and the encoder format merges last. Volume merges as `{flt,fltp}`/`{dbl,dblp}`/`{u8,u8p,s16,s16p,s32,s32p}` and adelay as `{u8p,s16p,s32p,fltp,dblp}`; an `'all'` step passes every list through.
2. **Picking.** A segment fed by a converter picks the format with the lowest `get_fmt_score` against the previous segment's format. The list is taken in native enum order, and ties go to the later entry. When the converter is fed a single format, `swap_sample_fmts_on_filter` runs first.
3. **Default `negotiate` for an array.** If the arriving format is listed, the step uses it. Otherwise the list merges forwards with later lists (and the encoder format), and the pick follows rule 2. For aecho's `{s16p,s32p,fltp,dblp}` that gives `u8→s16p`, `s16→s16p`, `s32→s32p`, `flt→fltp`, `dbl→dblp`, matching native `-v debug` output. `aecho,volume=0.5` runs aecho in `fltp`, because volume's `{flt,fltp}` merges into its list. crystalizer's `{flt,fltp,dbl,dblp}` takes `dbl` for `f64le` output, because the encoder format merges.
4. **Guard.** For every chain input format, the chain simulates the full native graph twice: once with the source format merged first, and once with it merged last, which is what an input `-ss`/`-t` (an inserted `atrim`) does. Every step that is not transparent must work in the same sample type as the native pick in both shapes. Planar and packed forms of one sample type count as the same, so descriptors must compute identically in both layouts. Otherwise the chain fails with `<name> with <input> input requires unimplemented format negotiation`. This also catches pre-registry steps whose rules assume a later list merges or pins.
5. **Unimplemented formats.** A pick of `s64`/`s64p` fails with `<name> with <input> input negotiates s64p, which is not implemented`. An example is channelmap's planar list on double input, where `dblp` and `s64p` tie and the later entry wins.
6. **Channel conversion.** `outputConversion: true` in the compile options states that a channel conversion follows the chain. Native then cannot merge the encoder format into the last list. The PCM path passes it with `-ac`. The FLAC path passes it whenever `-ac` is given, and refuses native-list chains when `-ac` equals the input channel count (`FLAC -ac without channel conversion and native filter format lists require additional Native negotiation`).

Every refusal surfaces before any output is opened. Both CLI paths call `resolvedSampleFormat` before opening output, `apply()` negotiates before the first step, and `process()` negotiates up front for a configured input or at the first frame. `chain.negotiatedSampleFormats(input)` returns each step's format, and `chain.nativeFormatLists` tells whether the model is active. A stream step converts its own frames: call `convertAudioFrame(frame, negotiated(frame.sampleFormat), options)`.

`tests/differential/audio-format-negotiation.test.ts` checks the model against the pinned native build. Negotiation-only stand-ins declare the native lists of aecho, aderivative, aintegral, crystalizer, afade, asoftclip, channelmap, dcshift, adynamicsmooth, haas and extrastereo, registered only through the registry module. The test covers 271 chains: each list alone, each list on both sides of ten pre-registry neighbours, list pairs, and mixed triples. It runs them on u8/s16/s32/f32/f64 input, with and without an input trim, into u8/s16/s32/f32/f64 output and two `-ac 1` outputs. `ashowinfo` between steps reports native's working formats. Of the 18,970 cases, 18,038 match native in every non-transparent step; the other 932 refuse explicitly. Each list alone negotiates natively in every case, except channelmap on double input.

## Constraints

`constraint(step)` returns a check over `{sampleRate, channels, channelLayout}` at the step, after earlier `outputRate` steps, or `null`. Use it for every input that native would silently resample or remix. Examples are a stereo-only filter, a fixed 44100 Hz filter, or a remap whose map does not fit the channel count. Throw `AudioFilterError` with a message naming the filter.

The checks run in `validateInputFormat`, which both CLI paths call before opening output; in `apply()`; for a configured input; and for every frame in `process()`. A chain with a constraint and an unconfigured empty input fails with `<name> constraints require a configured empty input format`. `tests/unit/audio-filter-registry-extension.test.ts` shows a stereo, 44100 Hz-only scratch filter refused on the CLI for mono and for 8000 Hz input, with nothing opened, and running for stereo 44100 Hz.

`channelLayout` is the layout name of the stream:

- **Without a container mask, or with the default mask for the channel count** (`mono` FC, `stereo` FL+FR, `2.1` for three channels, and so on), the PCM path keeps its earlier names: `mono`, `stereo`, `unspecified` for three or more channels, or `<n> channels` when `-guess_layout_max` stops the guess.
- **With any other WAV/W64 `WAVEFORMATEXTENSIBLE` mask**, the decoded frames and the format passed to `validateInputFormat` carry native's name for the mask (`av_channel_layout_describe`, through `channelLayoutName` in `@edge-ffmpeg/avutil`). Examples are `2 channels (FL+FC)`, `2 channels (FL+USR18)`, `downmix` and `3.0(back)`. A check for `stereo` or `mono` therefore refuses such an input. A remap that requires the default layout refuses any name other than `mono`, `stereo` (two channels) or `unspecified` (three or more channels).
- **On the FLAC path** the check sees the decoder's layout (`resolveFlacLayout`).

Native has no matrix for most non-default masks and fails, with `Input channel layout '…' is not supported`. For the others it converts implicitly: it remixes FC+BC, treats DL+DR as stereo and treats any single channel as mono. Either way, a filter whose constraint names `stereo` or `mono` refuses, so it fails explicitly wherever native fails or converts. `tests/differential/audio-channel-mask.test.ts` pins this against the native build:

- every one of the 32 WAV mask bits, and every standard layout that fits in 32 bits, reads back natively under `channelLayoutName`'s name;
- the name table matches `ffmpeg -layouts`;
- `aformat=cl`, a stereo-only stand-in and a default-layout remap stand-in refuse 30 non-default-mask cases before output. In 12 of them native fails too; in 18, native converts or remaps.
- they run the 12 default-mask and unmasked cases. For `aformat=cl`, the output matches native byte for byte.

## Channel-preserving remaps

A filter that permutes or duplicates channels without changing the channel count or the layout (channelmap within its scoped forms) is a stateless `apply` that returns owned planes in the new order. Declare it like this:

- `formats()` is its native list.
- `transparent: true`, because samples are copied.
- A `constraint` refuses any map that does not fit the input's channel count or layout. `parse` cannot see the channels.

The extension test's `aswap` (channelmap `1|0`) runs on the CLI and refuses mono input before output.

## Memory: one declaration, two planners

`reserve()` is the only memory declaration. It returns `{frames, buffers, stateBytes}`:

- `frames`: output frames held across a downstream yield;
- `buffers`: per-channel sample buffers at the widest chain sample width, each held `copies` times;
- `stateBytes`: exact state bytes outside frames and buffers (delay rings, histories).

Every buffer and the state must each fit one frame allocation. The context carries the step's rate and negotiated input format. When the caller knows it, the context also carries the step's planned input sample count (`samples`, with `configuredInput`). Without `samples` the descriptor reserves for any input length.

- **FLAC helper.** `processFlacAudioFilters` iterates `chain.reservations(input)` lazily in step order, so an earlier step's limit error comes first. It reserves `frames × maxFrameBytes`, each buffer at `samples × channels × widest × copies`, and `stateBytes`, as one Core external-memory claim before any filter allocation. A buffer or state larger than one frame allocation fails with `FLAC filter buffer exceeds allocation limit`.
- **PCM plan.** `pcmFilterMemory` reads `chain.plannedReservations(input, plan)` with the same counts, rates and rate boundary as `planSamples()`. Each step's planned reservation sits next to the step's own `count()` buffers. `planPcmMemory` gives each frame-producing stage two frame slots, and each `count()` buffer two slots of at least the largest buffer. So a step contributes `max(allocatesFrames ? 1 : 0, ceil(frames / 2))` frame-producing stages. Its declared buffers and state count against its own `count()` slots, and only the excess becomes filter state. Filter state is taken out of the payload's resident budget before planning, as resampler state already is. Both checks below fail as `resource-budget` before any output is opened:
  - a buffer or state larger than `maxBufferBytes` fails with `Audio filter state exceeds the configured buffer budget`;
  - state plus one payload buffer beyond the remaining resident budget fails with `Audio filter state and one payload buffer exceed the resident-byte budget`.

For the seven pre-registry filters the PCM translation adds nothing. Their declared buffers and state fit their own `count()` slots, and their frame-producing stages equal their `allocatesFrames` count. apad's planned reservation is its exact tail packet, the same value as its `count()` buffer; without `samples` it keeps the former worst-case bound. adelay's ring, `sum(delay - minimum delay)` samples at the planar input width, fits the two slots of its flush buffer. The PCM resident plan is therefore unchanged. A new filter that declares state only in `reserve()` is still accounted on both paths.

## Contract limits

The recipe covers filters within these limits. A filter outside them needs a contract change in `descriptor.ts`/`chain.ts` first. That is a separate task, not a one-file addition.

- **One input, one output, constant channels and layout.** Reservations and counts pass the chain's input channel count to every step, and frames keep their layout. Channel-preserving remaps are expressible (above). `pan`, `amerge`, channelmap forms that change the count or layout, and anything that rewrites `channelLayout` are not.
- **No dropped samples.** `AudioPacketChange` can regroup, prepend and append but cannot drop samples (`atrim`, `asetpts`-style edits). `packetSections` and `filteredPacketSchedule` fail explicitly on an undeclared count change.
- **No rate conversion with native lists.** A step with an array `formats()` refuses automatic sample-rate conversion. `rateConversion` is derived false whatever it declares.
- **Layout-independent arithmetic.** Planar and packed forms of one sample type must give identical samples, because the negotiation guard compares sample types.
- **Unmasked names.** A default or absent mask keeps the names `unspecified` (three or more channels) and `<n> channels`. Native would say `2.1`, `5.1` and so on, so a constraint cannot require a named multichannel layout; see [Constraints](#constraints).
- **Constant options.** No expressions, timeline `enable`, or runtime commands.

## Intentional corrections

1. `processFlacAudioFilters` takes its reservation from the descriptors. The untimed FLAC path used to reserve nothing for adelay. It now reserves adelay's output frame (`maxFrameBytes`) plus its exact ring bytes, `sum(delay - minimum delay)` times the planar input width, including for a configured empty input. For every chain without adelay the reservation is byte-identical to before. Side effects, all on adelay chains only:
   - A ring larger than one frame allocation is refused before allocation with `RangeError` `FLAC filter buffer exceeds allocation limit`. Before, `delayAudio` raised `adelay delay buffer exceeds allocation limit`.
   - The reservation evaluates adelay's delays when the first frame (or the configured empty input) arrives, before any frame reaches a constraint check. For direct callers of the exported helper, the first error can therefore change. For example, `Unsupported adelay delay: x`, the buffer-limit message or `Memory budget exceeded` can now come before an `aformat … constraint requires an implicit conversion` error or a `Converted audio frame exceeds allocation limit` error from a later step. On the CLI, `flac-transform.ts` validates `aformat` constraints before filtering, and these errors all map to `execution-failed`, so only the message can change.
   - `tests/differential/flac-adelay.test.ts` pins the CLI behaviour. At the smallest completing resident budget, an equal-delay adelay costs exactly one allocating stateless step, and every ring adds exactly its bytes. One byte less fails with `Memory budget exceeded`, and nothing is committed.
2. `AudioFilterChain.apply()` now names the first stream-only step, for example `adelay requires stream processing` or `apad requires stream processing`. Before, it always said `asetnsamples requires stream processing`.
3. `aformat=cl=mono|stereo` refuses a WAV/W64 input whose extensible mask is not the default for its channel count, for example a two-channel FL+FC file or a one-channel FL file. The error is `aformat channel layout constraint requires an implicit conversion`, raised before output. The constraint now sees the mask's native name (see [Constraints](#constraints)). Before, it saw `mono`/`stereo` and ran. That was wrong in both possible ways:
   - where native fails (FL+FC, BL+BR, SL+SR and other masks without a matrix), the old code wrote output anyway;
   - where native treats the layout as mono or stereo (FL, LFE, DL+DR) or remixes it, the output stream's layout changes, but the old code kept the input mask in WAV and W64 headers.
   Inputs without a mask, or with the default mask, are unchanged. No existing test covered a non-default mask.

## Adding a filter

Each filter owns exactly these paths. The only shared edit is one line in the registry.

| Path | Content |
|---|---|
| `packages/avfilter/src/audio/<name>.ts` | the descriptor (new) |
| `packages/avfilter/src/audio/registry.ts` | `+1` line: `export {<name>} from './<name>.js';` |
| `packages/avfilter/NOTICE-<NAME>` | provenance (new; never edit the shared `packages/avfilter/NOTICE`) |
| `tests/unit/<name>.test.ts` | unit tests (new) |
| `tests/differential/<name>.test.ts` | native comparison (new) |
| `docs/contributing/<name>.md` | filter documentation (new) |
| `docs/contributing/wave1/<slug>.json` | the agent's machine-readable report (new), in wave 1 only, beside the filter documentation it owns |

1. **Create `packages/avfilter/src/audio/<name>.ts`.** Declare its step type and export one descriptor:

   ```ts
   import {convertAudioFrame} from '@edge-ffmpeg/swresample';
   import {AudioFilterError,defineAudioFilter,frameReservation} from './descriptor.js';
   export interface Audio<Name>Step {readonly name:'<name>'; /* parsed options */}
   export const <name>=defineAudioFilter<Audio<Name>Step>({
     name:'<name>',
     examples:['<name>','<name>=<typical options>'],
     parse(text){/* accept '<name>' and '<name>=…'; throw AudioFilterError for anything unsupported */return Object.freeze({name:'<name>'});},
     capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}), // flacInput omitted: FLAC input is refused
     formats:()=>['s16p','s32p','fltp','dblp'], // the native list, in source order
     apply(step,frame,target,options){const output=convertAudioFrame(frame,target,options);/* compute in place on the owned copy */return output;},
     reserve:()=>frameReservation
   });
   ```

   - **`examples`.** List representative accepted tokens covering each option family. The registry tests run every example through every consumer's contract, so they need no edit.
   - **`formats()`.** Return the native list as an array (see [Sample-format negotiation](#sample-format-negotiation)), including a one-entry array for a pinned format (`['s16p']`, never `'s16p'`). The chain picks the native format, merges it with neighbours and the encoder, and refuses explicitly where it cannot reproduce native. Keep `'all'` only for filters that never change sample values. `'planar'`, `'integer'` and pinned strings fail to compile, and `negotiate`/`nativeFormats` fail registration. Set `transparent: true` for copies, remaps and delays with a list. Add `precision` when the widest listed width overstates the working width.
   - **`apply` or `stream`, never both.** Use `apply` for a frame-by-frame transform. It receives the negotiated `target`; convert to it, never mutate the input, and return owned planes. Use `stream` for state that crosses frames. Convert each frame with `negotiated(frame.sampleFormat)`, and use `configured` for a configured empty input. A stream step always reframes. If `apply` reads `frame.pts`, declare `reframes: true`. Put a large engine in its own module next to `delay.ts`, `pad.ts` and `reframe.ts`.
   - **`constraint`.** Add one for every rate, channel-count or layout condition native would satisfy by converting implicitly. A stereo-only filter checks `channels === 2 && channelLayout === 'stereo'`, which also refuses a non-default WAV/W64 mask. A filter that must refuse any non-default mask accepts only `mono`, `stereo` or `unspecified` for one, two, or three or more channels. See [Constraints](#constraints).
   - **Counts.** Add `count` (plus `packets`, which must sum to the new count), `packetSpan` and `bufferedSamples` if the filter changes sample counts or packet boundaries. A tail generated after EOF needs `generatesOutput: true` and a `trailing` packet run in `count()`; `generatesOutput` without `count()` fails to compile. Add `outputRate` and `configure` if it fixes the output rate.
   - **`reserve()`.** Declare every allocation: output frames, retained sample buffers, and exact state (rings, histories, accumulators) in `stateBytes`. Use `samples` from the context when the size depends on the input length, and the worst case without it. Set `allocatesFrames` whenever `apply` or `stream` allocates output frames. Both planners read the reservation; you do not edit them.
   - **Flags.** Keep `rateConversion`, `timeSelection` and `formatConstraint` false, and omit `flacInput`. With a native list, `rateConversion` is forced false anyway, and `timeSelection` is false without `flacInput`. While they are false, `rateBoundary()` and both FLAC paths refuse the filter explicitly: the timed path with the packet-scheduling message, the untimed path with `FLAC input to <name> requires additional Native evidence`.
   - **Limits.** Stay within the [contract limits](#contract-limits). No Node built-ins. Keep explicit limits, bigint sample counts and timestamps, and observe `options.signal`.
2. **Register it with one line** in `packages/avfilter/src/audio/registry.ts`:

   ```ts
   export {<name>} from './<name>.js';
   ```

   The export name must be the FFmpeg filter name. Order is irrelevant, so concurrent additions merge as a union of lines: `.gitattributes` marks this file `merge=union`, which keeps both sides on a local merge, squash or rebase.
3. **Record provenance** in a new `packages/avfilter/NOTICE-<NAME>`, upper case: for example, `NOTICE-AECHO`. Never edit the shared `packages/avfilter/NOTICE`. Name the adapted upstream file (`libavfilter/af_<name>.c`) and the fixed commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`. Copy the copyright lines from that file, state `LGPL-2.1-or-later`, point to `LICENSES/LGPL-2.1-or-later.txt`, and describe what the adaptation changes. `NOTICE-AUDIO-NEGOTIATION` is an example.
4. **Add tests, all in new files.** No shared fixture or existing test file changes.
   - `tests/unit/<name>.test.ts` covers:
     - accepted and refused syntax, with exact messages;
     - planning: `planSamples`, `packetSections`, `plannedReservations`;
     - negotiation: `negotiatedSampleFormats` for every input format, `requiresScalarRounding`;
     - `constraint` refusals;
     - `apply`/`process` output against a direct transcription of the C loop;
     - ownership: inputs not mutated, outputs own storage;
     - allocation limits and cancellation.
   - `tests/differential/<name>.test.ts` compares CLI output byte for byte with the native build across source formats, channel counts, composed chains (including `asetnsamples` splits) and output `-ss`/`-t`/`-frames:a`. It asserts native's status for each explicit-failure case. The wave rules name the reference build and the platform gates for float-sensitive cases.
   - FLAC input is refused until the descriptor declares `flacInput: true`. Declare it only together with `tests/integration/flac-<name>.test.ts` and `tests/workers/flac-<name>.test.ts`, which compare FLAC input with native and need an environment that can build the FLAC codec. Otherwise leave it out and document FLAC input as refused.
   - `tests/unit/audio-filter-registry.test.ts`, `tests/unit/audio-filter-registry-extension.test.ts` and `tests/unit/audio-filter-registry-contract.test.ts` must pass unchanged. For each of your examples they check: registration, a single execution hook, capability shapes, the reframing, rate, tail and format-set rules, reservations against both planners, negotiation for every input format, and the rate, FLAC input and FLAC time-selection refusals.
5. **Document it** in `docs/contributing/<name>.md`: syntax, supported and refused forms, negotiation table, arithmetic profile, evidence counts, and the scoped test contracts (file, exact test title, scope) for the validation stage. Do not edit `compat/*.json`, `development-status.md` or the capability table in this file; the coordinator adds the row after the merge. In wave 1, also write the machine-readable report the wave template asks for to `docs/contributing/wave1/<slug>.json` and commit it with the branch. It is one of the filter's owned paths. Write it nowhere else: `compat/` is outside every filter's paths.
6. **Run** these, then `npm run typecheck`, `npm run lint` and `npm run boundaries`:

   ```sh
   npx vitest run tests/unit/audio-filter-registry.test.ts tests/unit/audio-filter-registry-extension.test.ts tests/unit/audio-filter-registry-contract.test.ts tests/unit/<name>.test.ts
   npx vitest run tests/differential/<name>.test.ts --maxWorkers=1
   ```

   Run `npm test` where the FLAC codec can be built.

You do not need to edit `chain.ts`, `descriptor.ts`, `index.ts`, the avformat consumers, the PCM or FLAC planners, or any existing test. They query only descriptors, capabilities, reservations and negotiated formats. `tests/unit/audio-filter-registry-extension.test.ts` proves this with scratch filters registered only through the registry module:

- a stream-only filter that declares no reframing still filters before output `-ss`;
- a timestamp-dependent stateless filter that declares `reframes` matches its unselected output;
- state declared only in `reserve()` is reserved on the PCM path or refused before output;
- an undeclared count change fails in `packetSections`;
- a string format set and a generated tail without `count()` fail to compile;
- the rate-conversion, FLAC input and FLAC time-selection refusals need no consumer edits;
- a native list negotiates like aecho, stream steps get their negotiated format, and the rate refusal is derived;
- lists merge with volume and with the encoder, and `outputConversion` blocks the encoder merge;
- unreproducible negotiations and s64p picks are refused before output;
- a stereo, 44100 Hz-only constraint fails before output and runs when it holds;
- a channel-preserving remap runs on the CLI;
- a non-default WAV mask reaches `constraint()` under its native name and is refused before output.

`tests/unit/audio-filter-registry-contract.test.ts` registers scratch descriptors with both execution hooks, with none, and with `negotiate` or `nativeFormats`. Each fails when the registry loads.

## Evidence

`tests/unit/audio-filter-registry.test.ts` covers:

- registry invariants for every registered example, including negotiation for every input format;
- planned reservations beside `count()` buffers for every example;
- the unchanged PCM plan for the existing filters: 2,976 configurations of formats, channel counts, sample counts, tails and rate boundaries, with the tightest buffer budget;
- single execution hooks, the tail and format-set rules, and the pre-registry-only negotiation hooks for every descriptor;
- the rate-conversion, FLAC input and FLAC time-selection refusals for every example;
- equality of every capability with the name predicates the consumers used before, across all filters and mixed chains;
- the `apply()` message correction;
- stage packet effects applied by `filteredPacketSchedule`, with the explicit `leading` and rate-conversion refusals;
- the planar-neighbour name in the fixed-volume refusal;
- the FLAC adelay reservation correction: frame plus rings, configured empty input, the budget limit, the per-buffer limit and step-order precedence.

`tests/differential/flac-adelay.test.ts` compares the untimed FLAC CLI path with the pinned build byte for byte. It runs:

- adelay alone and composed with asetnsamples, apad, volume and aformat;
- mono, stereo and three-channel input at 16 and 24 bits;
- s16le, s32le, WAV and framecrc output;
- mono/stereo channel conversion.

It also pins the CLI reservation of correction 1. The reservation test fails against the pre-registry implementation; the byte comparisons pass on both.

`tests/differential/audio-format-negotiation.test.ts` pins the negotiation model against the native build, as described above. `tests/differential/audio-channel-mask.test.ts` pins the mask names and the layout refusals (see [Constraints](#constraints)).

The existing unit, differential, integration and workers audio tests pass unchanged. During development, scratch harnesses compared the pre-registry implementation with the registry implementation:

- every public chain method on 3,149 chains under four output hints, with identical results and errors apart from correction 2;
- FLAC reservation traces and resampled packet schedules on 1,861 chains without adelay, also identical;
- the PCM plan inputs on 2,331,300 configurations of 3,492 chains: zero filter state, identical frame-producing stages, identical buffers, and no new check firing under the tightest buffer budget.

Those harnesses are not committed. The negotiation model is active only for chains with an array `formats()`; no pre-registry filter declares one, so pre-registry chains negotiate exactly as before.
