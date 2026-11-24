# channelmap

`channelmap` (`packages/avfilter/src/audio/channelmap.ts`) permutes and duplicates channels within the input's default layout. It is a stateless `apply` registered through the [audio filter registry](audio-filter-registry.md), adapted from `libavfilter/af_channelmap.c` at FFmpeg commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8` (provenance in `packages/avfilter/NOTICE-CHANNELMAP`).

The registry contract keeps the channel count and layout constant, so only maps whose native output layout equals the input layout are implemented. Every other map fails explicitly before any output is opened.

## Syntax

`channelmap=<map>[:<channel_layout>]`, or keyed: `channelmap=map=<map>:channel_layout=<layout>`. A positional option cannot follow a keyed one.

The parse mode follows `channelmap_init`. Without a `-` in the map, the mode is indices when the first character is a digit, otherwise names. With a `-`, the first character picks an index or name input, and the character after the first `-` picks an index or name output. Entries are separated by `|`, and a trailing `|` is tolerated.

| Form | Example (stereo) | Output layout natively | Implemented when |
|---|---|---|---|
| indices | `1\|0`, `0\|0`, `2\|0\|1` (three channels) | default layout for the entry count | entry count equals the input channel count |
| names | `FR\|FL`, `FL\|FL` | default layout for the entry count | entry count equals the input count; each name is in the input layout |
| index pairs | `0-1\|1-0` | default layout for the entry count | outputs are a permutation of the input indices |
| index-to-name, name-to-name pairs | `0-FR\|1-FL`, `FL-FR\|FR-FL` | the layout of the output names' mask | that mask equals the input's default mask |
| name-to-index pairs | `FL-1\|FR-0` | default layout for the entry count | as for index pairs |
| `channel_layout` only | `channel_layout=stereo` | the named layout (identity map) | it names the input layout |

Inputs may repeat (duplication). An explicit `channel_layout` must be the name of a default layout (`mono`, `stereo`, `2.1`, `4.0`, `5.0`, `5.1`, …) and must equal the input layout.

The input layout must be the default for its channel count: `mono`, `stereo`, or `unspecified` for three or more channels (native guesses `2.1`, `4.0`, …). Channel names resolve against that default layout, so three-channel input takes `FL`, `FR` and `LFE`.

## Refused

Parse-time errors carry native's init message where native fails too:

- `Failed to parse channel map`: an empty token, a malformed index (`1x`), an unknown name (`XX`), a pair without `-`, or a mode mismatch (`0|1-0`);
- `Output channel layout is not set and cannot be guessed from the maps.` (`channelmap` alone);
- `Output channel layout <layout> does not match the number of channels mapped <n>.`;
- `Mapping <i> assigns channel #<k> twice in output layout '<layout>'.`;
- `Output channel #<k> not available from output layout '<layout>'` and `Output channel '<name>' not available from output layout '<layout>'`.

Native accepts these, but they are not implemented here:

- `Unsupported channelmap channel index: <token>`: an index with a sign or leading whitespace, which `sscanf` reads;
- `Unsupported channelmap channel name: <token>`: `USR<n>`, `AMBI<n>`, `UNK` and `UNSD`;
- `Unsupported channelmap channel_layout: <value>`: anything other than a default layout name, for example `FL+FR`, `downmix` or `0x3`;
- `Unsupported channelmap option: <option>`, and `Quoted or escaped channelmap options are not implemented`;
- `channelmap supports at most 64 mappings`.

Constraint errors are raised before output by `validateInputFormat` on both CLI paths, and per frame by `apply()`/`process()`:

- `channelmap output layout <out> differs from input layout <in>, which is not implemented`: any count or layout change. Examples are `map=0` on stereo (native downmixes to mono), `0|0` on mono, `0|1` on three channels, and `FL-FC|FR-FL` on stereo (native converts to FL+FC).
- `Input channel #<k> not available from input layout '<in>'` and `Input channel '<name>' not available from input layout '<in>'`. Examples are `0|2` on stereo and `FC-FL|FL-FR` on stereo; native fails too.
- `channelmap requires the default channel layout for its input channel count`: a WAV/W64 input with a non-default `WAVEFORMATEXTENSIBLE` mask, or an unguessed `<n> channels` layout.

Double input: native's planar list gives `dbl → s64p` (`dblp` and `s64p` tie, and the later entry wins). Native then converts through `s64p`, which is invalid and platform-dependent. The chain refuses this with `channelmap with dbl input negotiates s64p, which is not implemented`. Double samples reach channelmap only through an explicit planar double format, such as `aformat=f=dblp,channelmap=…`. There native keeps `dblp` and only copies. That route matches native byte for byte and is pinned by the differential test.

FLAC input is refused before decoding (`FLAC input to channelmap requires additional Native evidence`): the descriptor does not declare `flacInput`.

## Negotiation and arithmetic

`formats()` is `ff_planar_sample_fmts()`, `['u8p','s16p','s32p','fltp','dblp','s64p']`, with `transparent: true`.

| Input | Working format |
|---|---|
| u8 / s16 / s32 / flt | u8p / s16p / s32p / fltp |
| a planar format other than s64p | itself |
| dbl | refused (s64p) |

There is no arithmetic. Each output plane is a copy of one input plane after conversion to the planar form. `channelmap_filter_frame` reassigns plane pointers. Here, a plane used twice is copied into a plane that no output reads, so output planes never alias each other or the input. Nothing is allocated beyond the converted frame (`reserve()` is one frame, and `allocatesFrames` is true). Counts, packet boundaries and timestamps are unchanged.

## Evidence

- `tests/differential/channelmap.test.ts` runs against `.build/reference/ffmpeg` (Linux x86_64):
  - **raw bytes:** 3,064 comparisons. For u8, s16, s32 and f32 with one, two and three channels, every input tuple (each permutation and duplication) is run in index and name form. For every output permutation it is also run in all four pair forms. Each channel count adds a trailing-separator form, keyed and positional `channel_layout` forms, and a `channel_layout`-only form.
  - **headers and chains:** 110 comparisons. For each format and channel count: framecrc, including `#channel_layout_name`; WAV and W64 headers and bytes; `asetnsamples` before and after; two chained channelmaps; `apad` before; and output `-ss`/`-t` and `-frames:a`. Two more run explicit `dblp` on f64 input.
  - **refusals:** 10 explicit-refusal cases with native's exit status (0 where native converts implicitly, 234 where native fails). Each asserts our message and that no output file exists. Two non-default WAV masks (FL+FC and DL+DR) are refused while native converts, and the default mask runs and matches native.
- `tests/unit/channelmap.test.ts` (9 tests) covers parse-mode selection, the accepted forms, every syntax refusal with its exact message, negotiation for every input format, `requiresScalarRounding`, the constraint refusals (including masked layout names), `planSamples`/`packetSections`/`plannedReservations`/`pcmFilterMemory`, output against a transcription of `channelmap_filter_frame` for nine sample formats with frame-split invariance through `process()`, plane ownership and aliasing, the frame allocation limit and cancellation.
- The registry suites (`audio-filter-registry*.test.ts`) pass unchanged with the four examples.

Copies only, so there are no float-sensitive cases. The spec notes macOS and Linux were identical for s16 three-channel `map=2|0|1` and f32 `1|0`.

## Scoped test contracts

| File | Test | Scope |
|---|---|---|
| `tests/differential/channelmap.test.ts` | matches native raw bytes for every permutation and duplication in each accepted syntax, u8/s16/s32/f32 with 1-3 channels | accepted map syntax, raw output |
| `tests/differential/channelmap.test.ts` | matches native framecrc, WAV and W64 headers and bytes, composed chains and output time selection | headers, layout names, chains, time selection, explicit dblp |
| `tests/differential/channelmap.test.ts` | refuses out-of-scope maps, double input and non-default WAV masks before output, with native status recorded | explicit refusals |
| `tests/unit/channelmap.test.ts` | matches a transcription of channelmap_filter_frame for every planar and packed input format, with frame-split invariance | plane mapping |
| `tests/unit/channelmap.test.ts` | refuses native init failures and unimplemented syntax with exact messages | parser |
| `tests/unit/channelmap.test.ts` | returns owned, non-aliasing planes and leaves the input untouched | ownership |

## Unsupported

- Maps that change the channel count or layout, which need a contract change in `descriptor.ts`/`chain.ts` (see [contract limits](audio-filter-registry.md#contract-limits)).
- Non-default input masks, and unguessed layouts.
- `channel_layout` values other than default layout names.
- Signed or whitespace-led indices, and `USR`/`AMBI`/`UNK`/`UNSD` channel ids.
- Double packed input (native s64p), and FLAC input.
