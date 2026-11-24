# Container registry

The finite PCM backend (`createMediaBackend`, [PCM support](pcm-support.md)) routes every input and output container through one descriptor per format. A descriptor holds what the backend needs to know about the format: its `-f` name, magic probe and its precedence, input and output extensions, the open (demux) function and its packet span, header bytes for the memory plan, the default and supported output codecs, output validation before the output is created, the mux function, per-format output options and its name in listings. Neither `packages/containers/src/detect.ts` nor the PCM path in `packages/avformat/src/index.ts` names a format.

Adding a PCM-style container takes one format module and one registry line. Its tests, its documentation and its `NOTICE-<FORMAT>` are new files too; no shared file changes. The recipe is in [Adding a PCM-style container](#adding-a-pcm-style-container).

This is a structural refactor. For the 25 pre-registry formats (`wav`, `aiff`, `au`, `w64`, `framecrc` and the 20 raw PCM formats), the following are unchanged: accepted names and extensions, probe order and the bytes each probe reads, default codecs, error classes, messages and their order, the memory plan's header and scratch sizes, outputs and public exports. Everything else is additive:

- the registry API and descriptor types exported by `@edge-ffmpeg/containers`;
- an optional fourth `url` argument to `detectAudioContainer`, used only by input-extension detection;
- input-extension detection, per-format output options, the native-status `refuse` hook, the input-metadata refusal (`info.metadata`, `mux.dropsMetadata`) and the input seek passed to `demux.open`, which no pre-registry format uses or is affected by.

`detectAudioContainer`'s return type is now derived from the registry (`DetectableContainerName`), so it grows as formats are added. With the pre-registry formats it is exactly `'wav'|'aiff'|'au'|'w64'`. `packages/avformat/src/memory-plan.ts` and `output-policy.ts` never branched on format names and are unchanged.

## Layout

| File | Role |
|---|---|
| `packages/containers/src/registry-descriptor.ts` | The contract: `ContainerDescriptor`, `ContainerDemuxer`, `ContainerMuxer`, `ContainerProbe`, `ContainerOutputStream` and the stream, open and mux option types, plus `defineContainer` and `containerRefusal`. |
| `packages/containers/src/registry.ts` | One `export {<name>} from './<module>.js';` line per format, in alphabetical order of the export name, as in the audio filter registry. The raw PCM family is one `export *` line. |
| `packages/containers/src/registry-table.ts` | Validates every export when the module loads, and serves lookups: `containerFormat(name)`, `containerFormats`, `containerProbes`, `outputContainerFor(url)`, `inputContainerFor(url)`, `containerOutputOptions` and `containerOutputListing`. |
| `packages/containers/src/detect.ts` | `detectAudioContainer` runs the registered probes in precedence order, then falls back to input extensions. |
| `packages/containers/src/formats/*.ts` | Descriptors of the pre-registry formats (`wav`, `aiff`, `au`, `w64`, `framecrc`, `raw-pcm`). They wrap the unchanged implementation modules `wav.ts`, `wav-mux.ts`, `aiff.ts`, `au.ts`, `w64.ts`, `framecrc.ts` and `raw-pcm.ts`. |
| `packages/containers/src/<name>.ts` | A new format's implementation, with its descriptor exported from the same module. |
| `packages/containers/NOTICE-<FORMAT>` | Each ported format owns its notice (for example `NOTICE-W64`). |
| `packages/avformat/src/index.ts` | The PCM path reads only descriptor fields. |

Registration order has no effect. Lookups are by name, extensions cannot overlap, probes sort by precedence and then by name, and the supported-output listing sorts by `mux.order` and then by name.

## What the backend reads

Each row is a per-format branch that `avformat/src/index.ts` used to hard-code, with the hook that now replaces it.

| Former branch | Descriptor field |
|---|---|
| Accepted input `-f` names | `demux` present |
| Raw PCM input: `-ar`/`-ac` allowed, `-guess_layout_max` drops the default mask, a failed first read reported after output checks | `headerless: true` |
| `detectAudioContainer` magic chain | `demux.probe` |
| Input-opening chain (`openWav`/`openAiff`/`openAu`/`openW64`/`openRawPcm`) | `demux.open` |
| Input `-ss` at or beyond EOF allowed for AIFF and AU only | `demux.seekBeyondEnd` |
| Input packet span (AIFF `4096/blockAlign`, otherwise `pcmPacketSpan(rate)`) | `demux.packetSpan` |
| `inputHeaderBytes` (128, raw 0) | `demux.headerBytes` |
| Accepted output `-f` names | `mux` present |
| Output extension chain (`.au/.snd`, `.wav`, `.w64`, `.aif/.aiff/.aifc`) | `mux.extensions` |
| Default codec (raw format codec, `pcm_s16be` for AIFF/AU, else `pcm_s16le`) | `mux.defaultCodec` |
| Codec refusals (`<label> muxer does not support <codec>`, `Raw PCM mux format must match the selected codec`) | `mux.supports`, `mux.label`, `mux.refuse` |
| `validateAuOutput`/`validateW64Output`/`validateAiffOutput` and the framecrc layout refusal | `mux.validate` |
| `outputScratchBytes` (framecrc 512, w64 168, wav/aiff/au 128, raw 0) | `mux.scratchBytes` |
| Mux dispatch | `mux.write` |
| `Output requires WAV, AIFF, AU, W64, framecrc or an explicit raw PCM format` | `mux.label`, `mux.order`, `headerless` |

The pre-registry values are the ones in the table. `tests/unit/container-registry.test.ts` checks every one against the former predicates, copied verbatim from `index.ts` at 9fd9ae3.

## Pipeline order

A descriptor hook runs at a fixed point of the PCM path. Refusals therefore surface in the same order for every format.

1. **Input options.** `-f <name>` must name a descriptor with `demux`; otherwise the command fails with `Unsupported input format: <name>`. `-ar`/`-ac` without a `headerless` format fail with `Input rate/channel declarations currently require a raw PCM format`.
2. **Output options.** Generic options are parsed. A name in `containerOutputOptions` (declared by any registered muxer) is held for step 3. Any other option fails with `Unsupported output option: <name>`.
3. **Output format.** The format is `-f`, or else the first `mux.extensions` match of the lower-cased output path. If it has no `mux`, the command fails with ``Output requires ${containerOutputListing} or an explicit raw PCM format``. An option held in step 2 that this muxer does not declare in `mux.options` fails with `Unsupported output option: <name>`. Without `-c`, the codec is `mux.defaultCodec`.
4. Filters compile, and the codec must be PCM or `copy`.
5. **Input.** The input is opened. A `headerless` input gets the read probe. An undeclared input is detected (see [Detection](#detection)). Then `demux.open(source, {maxReadBytes, signal, declared, seek})` runs.
6. The seek-at-EOF refusal runs unless `demux.seekBeyondEnd`. Then the codec check: when `mux.supports(codec)` is false, the command throws `mux.refuse(codec)`, or by default `unsupported-command` `<label> muxer does not support <codec>`. Then, when `info.metadata` is true and the muxer does not set `dropsMetadata`, the command fails with `Input metadata for the <label> muxer is not implemented`.
7. The output policy (`-y`/`-n`/existing output) and the deferred raw read failure.
8. Packet span (`demux.packetSpan(info)`, default `pcmPacketSpan(rate)`), time ranges, filter planning, and the memory plan with `demux.headerBytes` and `mux.scratchBytes`.
9. The filter input check, then `mux.validate(stream)`.
10. The output is created (`openWrite`), and `mux.write(output, stream, packets, {maxWriteBytes, signal, framing})` runs.

Steps 1 to 9 run before any output exists. Put every refusal that native would raise in `write_header` into `supports`/`refuse` or `validate`, never into `write`.

## Descriptor contract

`defineContainer({...})` freezes the descriptor, its `demux`, `mux`, `probe` and lists, and returns it with its literal type, so the registry can derive `ContainerName` and `DetectableContainerName`.

| Field | Meaning |
|---|---|
| `name` | The native `-f` name (`AVInputFormat`/`AVOutputFormat` `name`), `[a-z0-9_]{1,32}`. It must equal the registry export name. |
| `headerless` | Raw PCM only: the format is never detected, takes the input declarations, defers a failed first read, and is listed as "an explicit raw PCM format". |
| `demux.probe.precedence` | The probe order, ascending; ties sort by name. The pre-registry values are w64 10, au 20, aiff 30 and wav 40. |
| `demux.probe.head(bytes)` | Test on the first four bytes. Only a format whose head matches may read further. |
| `demux.probe.confirm(input, maxReadBytes, signal)` | Optional bounded deeper check after a head match, as w64 reads its 40-byte GUID header. |
| `demux.extensions` | Lower-case input extensions (`'.rso'`) that select the format when no probe matches. Use them only for a native demuxer without `read_probe`. |
| `demux.headerBytes` | Header bytes held while the input is open (`inputHeaderBytes`). |
| `demux.open(source, {maxReadBytes, signal, declared, seek})` | Returns `{info, packets(startSample, maxPacketBytes)}`. `info` has at least `codec`, `channels`, `sampleRate`, `channelMask`, `blockAlign` and `durationSamples`. `declared` (`sampleRate`, `channels`, `guessLayout`) matters only to headerless formats. `seek` is input `-ss` in microseconds (`0n` when absent), so `open` can refuse a seek whose native semantics the module does not mirror. |
| `info.metadata` | Set it to `true` when the native demuxer exports global metadata (tags, comments) for this input. Nothing carries tags to a muxer, so such an input is refused unless the muxer sets `dropsMetadata`. |
| `demux.packetSpan(info)` | The native packet span in samples. It drives time selection, packet schedules and framecrc regrouping. Default `pcmPacketSpan(rate)`; AIFF returns `floor(4096 / blockAlign)`. |
| `demux.seekBeyondEnd` | Input `-ss` at or beyond EOF selects nothing, as native does. Set it only where tests show native's behaviour; otherwise the seek is refused as unimplemented. |
| `mux.label`, `mux.order` | The name in refusals and in the supported-output listing, and its listing position. Leave `order` out: unordered muxers follow the five pre-registry ones by name. |
| `mux.extensions` | Lower-case output extensions that select the format without `-f`. |
| `mux.defaultCodec` | The codec when no `-c` is given. `supports(defaultCodec)` must be true. |
| `mux.supports(codec)`, `mux.refuse(codec)` | The encodings the muxer writes, and optionally the native-status error for others, for example `containerRefusal(message, 234)` for `EINVAL`. |
| `mux.options` | Output options only this format accepts, for example `['-hash']`. Their values reach `validate` and `write` as `stream.options`, in command order. |
| `mux.scratchBytes` | Header and trailer bytes held while writing (`outputScratchBytes`). |
| `mux.dropsMetadata` | The native muxer writes no input metadata, so inputs with `info.metadata` are accepted. Set on raw PCM, framecrc and w64, not on wav, aiff and au, which write tags. Set it only after checking the native muxer source. |
| `mux.validate(stream)` | Every refusal that needs no output: geometry, size fields and option values. |
| `mux.write(output, stream, packets, {maxWriteBytes, signal, framing})` | Writes all bytes in chunks of at most `maxWriteBytes`, then commits the output, or aborts it once on any failure. |

`ContainerOutputStream` has these fields:

- `codec`, `channels`, `sampleRate`.
- `samples`: the exact sample count. Every muxer writes sequentially with known sizes and never seeks.
- `bitexact`.
- `options`.
- `channelMask`: the source mask, or null after `-ac` conversion. AIFF, AU and raw use it.
- `layoutMask`: the source mask, or else the default layout when the layout is guessed or converted. WAV and W64 use it.
- `channelLayout`: the native layout name, or `''` when the mask has none. framecrc refuses `''`.

`framing` gives the selected range's packet boundaries (span, first packet, schedule or sections), which framecrc uses to regroup packets.

The registry table checks every export when it loads, and fails with `Invalid container registration: <name>` when any of these is broken:

- the export key equals `name`;
- the descriptor has `demux` or `mux`;
- the byte counts are non-negative safe integers;
- hooks are functions and flags are booleans;
- extensions match `^\.[a-z0-9_]{1,16}$` (so none is a suffix of another);
- option names match `^-[a-z0-9_]{1,32}$`;
- a headerless format has no probe or input extensions;
- the default codec is supported.

An extension claimed twice on the same side fails with `Duplicated container extension <ext>`.

## Detection

`detectAudioContainer(input, maxReadBytes, signal, url)` reads the first four bytes in bounded reads. A file shorter than four bytes fails with `Invalid audio container probe`. Then the probes run in precedence order:

1. A format whose `head(bytes)` matches, and whose `confirm` (if any) resolves true, wins. A format whose head does not match never reads more, so adding a probe does not change the bytes read for other formats. The pre-registry reads stay four bytes, plus 40 for a lowercase `riff` head.
2. If no probe matches and `url` is given, the format with a matching `demux.extensions` entry wins.
3. Otherwise the call fails with `Unsupported audio container signature`.

Precedence matters only when heads overlap. An exact magic that no other format's head can match uses 100. A head that overlaps another format's, such as a `RIFF` form type other than `WAVE`, needs a precedence below the format it overlaps (wav 40) and a `confirm` that rejects that format's files. Record the reason next to the value. Native ranks probes by score and treats an extension match as 50 (`AVPROBE_SCORE_EXTENSION`). Edge probes are exact, run before extensions, and never tie. Where native's score depends on the data (avr scores 25 for stereo), claim detection parity only where native's framecrc header shows the same format.

FLAC input never reaches these probes. The dispatcher routes a `fLaC` magic or `-f flac` to the FLAC backends first, and MP4, rawvideo and image2pipe requests also go to their own backends before the PCM path (see [Dedicated backends](#dedicated-backends)).

## Adding a PCM-style container

These steps add a format named `<name>` (for example `wve`, `sox`) that carries PCM samples behind a header. Demux-only formats omit `mux`, and output-only formats omit `demux`.

1. **Module.** Create `packages/containers/src/<name>.ts`. It holds the implementation (`open<Name>`, `validate<Name>Output`, `mux<Name>`, the error class and any private tables, such as codec-id, tag or line-reader ports) and, at the end, `export const <name>=defineContainer({...})`.
   - Read headers with bounded reads (`maxReadBytes` per read, `signal` checked around each await). Never read the payload to parse.
   - Return `openRawPcm(<data range>, {codec, channels, sampleRate, channelMask, maxReadBytes, signal})` for the packets, so seeks, packet budgets and timestamps match every other PCM input.
   - Refuse explicitly anything native accepts but the module does not mirror: truncated headers, partial trailing frames, metadata native would carry into the output, and platform-dependent float paths. Use the module's own error class (`execution-failed`), or `containerRefusal(message, exitCode)` for an `unsupported-command` refusal with native's exit status.
   - Write the header in chunks of at most `maxWriteBytes`, then pass the payload to `muxRawPcm` through a wrapped writer, so packet validation and abort-once behaviour are shared. `muxAu` and `muxAiff` follow the same pattern.
2. **Registry line.** Add `export {<name>} from './<name>.js';` on its own line in `packages/containers/src/registry.ts`, at its alphabetical position. For several names from one module (the hash muxers), use one line per name (`export {md5} from './hash/hash-mux.js';`). `.gitattributes` marks this file `merge=union`: parallel additions at the same position merge as a union of lines on a local merge, squash or rebase, and detection never depends on line order. Nothing else is shared: no barrel export, no `detect.ts` or `avformat` edit, no `framecrc.ts` or `raw-pcm.ts` edit, and no change to the `PcmCodec` union. Tests can reach the module by its path (`../../packages/containers/src/<name>.js`) or through `containerFormat('<name>')`.
3. **NOTICE.** Create `packages/containers/NOTICE-<FORMAT>` (upper-case name, for example `NOTICE-WVE`; the four hash muxers share `NOTICE-HASH`), in the layout of `NOTICE-W64`. Name the upstream files ported and cite the pinned commit `946fcce07b6dcd0331c8cc609192aeff5e1924f8`. Copy the upstream copyright lines, state LGPL-2.1-or-later, and point to `COPYING.LGPLv2.1`. Start the module with `// SPDX-License-Identifier: LGPL-2.1-or-later` and a line pointing to the NOTICE. Do not edit a shared NOTICE.
4. **Tests.**
   - `tests/unit/<name>.test.ts`: header parsing, bounded read requests, refusals, abort and the descriptor fields.
   - `tests/differential/<name>.test.ts`: inputs generated in the test, with native run at test time.
   - The registry tests need no edit. `tests/unit/container-registry.test.ts` checks that a new format changes no pre-registry result and claims only names, extensions and heads that the pre-registry formats left unclaimed.
5. **Docs.** Create `docs/contributing/<name>-support.md`.
6. **Checks.** Run your unit and differential files, `tests/unit/container-registry.test.ts` and `tests/unit/container-registry-extension.test.ts`, `npm run typecheck`, `npm run lint` and `npm run boundaries`.

This template is a complete demux-and-mux module for a hypothetical `xyz` format: a 16-byte header (`XYZ1`, u16le channels, u32le rate, u16le codec tag, six zero bytes), then s16le or s16be PCM to EOF. The registry line is `export {xyz} from './xyz.js';`. `tests/unit/container-registry-extension.test.ts` runs the same hooks on scratch formats: magic, overlapping head, extension-only, output-only with an option, packet span, native exit statuses and memory sizes. This template text was registered and run unchanged (see [Evidence](#evidence)).

<!-- container-template:start -->
```ts
// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavformat/xyzdec.c and xyzenc.c (pinned FFmpeg 946fcce0). See NOTICE-XYZ.
import type {ReadHandle,WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {openRawPcm,muxRawPcm} from './raw-pcm.js';
import type {RawPcmInfo,RawPcmInput,RawPcmMuxOptions} from './raw-pcm.js';
import {containerRefusal,defineContainer} from './registry-descriptor.js';
export class XyzError extends Error {constructor(readonly code:'invalid-data'|'unsupported'|'resource-limit',message:string){super(message);}}
export type XyzCodec='pcm_s16le'|'pcm_s16be';
export interface XyzInfo extends RawPcmInfo {readonly container:'xyz'}
export interface XyzInput extends Omit<RawPcmInput,'info'> {readonly info:XyzInfo}
export interface XyzOutputFormat {readonly codec:XyzCodec;readonly channels:number;readonly sampleRate:number}
const headerBytes=16,tags:Readonly<Record<XyzCodec,number>>={pcm_s16le:0,pcm_s16be:1};
export function supportsXyzCodec(codec:string):codec is XyzCodec{return Object.hasOwn(tags,codec);}
/** Finite range-backed XYZ: a 16-byte header, then PCM to EOF. */
export async function openXyz(input:ReadHandle,options:{readonly maxReadBytes:number;readonly signal?:AbortSignal}):Promise<XyzInput>{
  const {maxReadBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1)throw new XyzError('resource-limit','Invalid XYZ read budget');
  if(input.size<BigInt(headerBytes))throw new XyzError('invalid-data','Truncated XYZ header');
  const header=new Uint8Array(headerBytes);let filled=0;
  while(filled<headerBytes){signal?.throwIfAborted();const requested=Math.min(headerBytes-filled,maxReadBytes),chunk=await input.readAt(BigInt(filled),requested,signal);signal?.throwIfAborted();if(!chunk.length||chunk.length>requested)throw new XyzError('invalid-data','Unexpected XYZ header read length');header.set(chunk,filled);filled+=chunk.length;}
  const view=new DataView(header.buffer),channels=view.getUint16(4,true),sampleRate=view.getUint32(6,true),tag=view.getUint16(10,true);
  const codec=(Object.keys(tags) as XyzCodec[]).find(name=>tags[name]===tag);
  if(!codec)throw new XyzError('unsupported',`Unsupported XYZ codec tag: ${tag}`);
  if(channels<1||sampleRate<1||sampleRate>2147483647)throw new XyzError('invalid-data','Invalid XYZ channels or sample rate');
  const offset=BigInt(headerBytes),raw=await openRawPcm({size:input.size-offset,readAt:(position,length,abort)=>input.readAt(offset+position,length,abort)},{codec,channels,sampleRate,channelMask:null,maxReadBytes,...(signal?{signal}:{})});
  return Object.freeze({info:Object.freeze({...raw.info,dataOffset:offset,container:'xyz' as const}),packets:raw.packets});
}
function outputHeader(format:XyzOutputFormat,samples:bigint):Uint8Array{
  const {codec,channels,sampleRate}=format;
  if(!supportsXyzCodec(codec))throw new XyzError('unsupported','Unsupported XYZ output codec');
  if(!Number.isInteger(channels)||channels<1||channels>65535||!Number.isInteger(sampleRate)||sampleRate<1||sampleRate>2147483647||samples<0n)throw new XyzError('invalid-data','Invalid XYZ output parameters');
  const bytes=new Uint8Array(headerBytes),view=new DataView(bytes.buffer);
  bytes.set([0x58,0x59,0x5a,0x31]);view.setUint16(4,channels,true);view.setUint32(6,sampleRate,true);view.setUint16(10,tags[codec],true);
  return bytes;
}
/** Validation available before opening an output transaction. */
export function validateXyzOutput(format:XyzOutputFormat,samples:bigint):void{outputHeader(format,samples);}
/** Known-size sequential XYZ output; raw packet validation owns the transaction. */
export async function muxXyz(output:WriteHandle,format:XyzOutputFormat,packets:AsyncIterable<MediaPacket>,options:RawPcmMuxOptions):Promise<void>{
  let abortAttempted=false;
  try{
    const stable={...format},header=outputHeader(stable,options.sampleCount),{maxWriteBytes,signal}=options;
    if(!Number.isSafeInteger(maxWriteBytes)||maxWriteBytes<1)throw new XyzError('resource-limit','Invalid XYZ write budget');
    for(let offset=0;offset<header.length;offset+=maxWriteBytes){signal?.throwIfAborted();await output.write(header.subarray(offset,offset+maxWriteBytes));signal?.throwIfAborted();}
    await muxRawPcm({write:chunk=>output.write(chunk),commit:()=>output.commit(),async abort(reason){abortAttempted=true;await output.abort(reason);}},stable,packets,options);
  }catch(error){if(!abortAttempted)try{await output.abort(error);}catch(abortError){throw new AggregateError([error,abortError],'XYZ output and abort failed');}throw error;}
}
/** Registered by `export {xyz} from './xyz.js';` in registry.ts. */
export const xyz=defineContainer({
  name:'xyz',
  demux:{probe:{precedence:100,head:bytes=>String.fromCharCode(...bytes)==='XYZ1'},headerBytes,open:(source,{maxReadBytes,signal})=>openXyz(source,{maxReadBytes,signal})},
  mux:{label:'XYZ',extensions:['.xyz'],defaultCodec:'pcm_s16le',supports:supportsXyzCodec,refuse:codec=>containerRefusal(`XYZ muxer does not support ${codec}`,234),scratchBytes:headerBytes,
    validate:({codec,channels,sampleRate,samples})=>validateXyzOutput({codec:codec as XyzCodec,channels,sampleRate},samples),
    write:(output,{codec,channels,sampleRate,samples},packets,{maxWriteBytes,signal})=>muxXyz(output,{codec:codec as XyzCodec,channels,sampleRate},packets,{sampleCount:samples,maxWriteBytes,signal})}
});
```
<!-- container-template:end -->

Variations for the wave-1 formats:

- **Head plus confirm** (wve, epaf, pvf, nistsphere, sds). `head` tests the four bytes the magic fixes: sds tests `F0 7E 00 01` (`sds_probe` compares `AV_RB32(buf)` with `0xF07E0001`), epaf tests both `'fap '` and `' paf'`. `confirm` reads only what native's `read_probe` inspects: 32 bytes for wve, 21 for sds and 24 for epaf.
- **Extension only** (rso). Use `demux:{extensions:['.rso'],...}` with no `probe`, and `mux.extensions:['.rso']`. Undeclared detection then needs the input path to end in `.rso`, as native's extension score does.
- **Output-only with options** (md5, hash, crc, streamhash). Use a descriptor with only `mux`. Declare `options:['-hash']` on md5, hash and streamhash but not on crc, as native's `AVOption` tables do, and check the values in `validate`. Set `supports:()=>true` (any implemented PCM codec or `-c copy`), `defaultCodec:'pcm_s16le'`, and a `scratchBytes` that covers the digest state and the text line. The CLI parser must also know the option. Today it refuses unknown options before any backend runs (`Unsupported option: -hash`, `invalid-arguments`), so `-hash` needs one entry in `packages/cli/src/index.ts`'s `values` set. The registry cannot supply that entry; see [Contract limits](#contract-limits).
- **Native packet span** (sds). `packetSpan:info=>...` returns 60, 40 or 30 from the bit depth that `open` stores on its info. A typed parameter (`packetSpan:(info:SdsInfo)=>info.packetSamples`) is accepted, because the hooks are methods.
- **Native exit statuses.** `refuse` and `validate` throw `containerRefusal(message, 234)` for `EINVAL` (sox and ircam codecs), or `containerRefusal(message, 183)` for `INVALIDDATA` (rso rate or channels). Both run before the output exists.
- **Metadata-bearing inputs** (nistsphere extra keys, a sox comment). Set `metadata:true` on the opened `info` for exactly the files whose native demuxer exports global metadata. The PCM path then refuses wav, aiff and au outputs and accepts raw, framecrc and w64, which drop it. A module may still refuse such files outright (sox comments).
- **Seek-dependent refusals** (wve header duration). `open` receives `seek`. Refuse there, for example `seek>0n` with a header duration that differs from the physical sample count, until native's behaviour is probed and mirrored.
- **Output-only muxers** also set `dropsMetadata:true` when the native muxer writes no tags (the hash muxers).

## Dedicated backends

These requests are dispatched before the PCM path and own their whole pipeline, so they are outside the registry:

- FLAC (`flac-copy.ts` `probeFlacInput`, `flac-wave-remux.ts`, `flac-decode.ts`);
- MP4 copy and H264 decode (`mp4-copy.ts`, `mp4-h264.ts`);
- rawvideo (`raw-video.ts`, `simple-multi-video.ts`);
- image2pipe/BMP (`bmp-stream.ts`);
- `-filter_complex` video.

Their routing predicates live in those modules, not in `index.ts`'s PCM path. Their video framecrc/rawvideo output choices (`complex-video-plan.ts`, `multi-video-plan.ts`, `actor-video/command-plan.ts`) are separate video muxers.

The FLAC decoder's PCM output has its own dispatcher in `packages/avformat/src/flac-output.ts`. It covers WAV, AIFF, AU, framecrc and raw, but not W64. A registered muxer is therefore not reachable from FLAC input until that dispatcher iterates the registry. That is a separate change, and wave-1 formats document FLAC input to their muxers as unsupported.

## Contract limits

A format outside these limits needs a contract change in `registry-descriptor.ts` and the PCM path first. That is a separate task, not a one-file addition.

- **PCM codecs only.** Streams use the `PcmCodec` union, `decodePcm` and `encodePcm`. ADPCM, DFPWM and other codecs need a codec hook.
- **One audio stream in and out, no metadata.** Nothing carries tags from a demuxer to a muxer. A demuxer marks tagged inputs with `info.metadata`, and the PCM path refuses them for muxers that would write tags (see `mux.dropsMetadata`).
- **Known sizes, sequential output.** `stream.samples` is exact before the first byte. There is no seek, pipe or unknown-length output. The output is always one opened file, so a file-less muxer (`null`) is not expressible.
- **Packet boundaries.** Demuxer packets are re-chunked by the memory plan. Native boundaries exist only as `packetSpan` (time selection, schedules) and `framing` (regrouping). A muxer whose bytes depend on packet boundaries (voc) must regroup with `framing` itself, and only framecrc does that today.
- **Detection** needs at least four bytes, runs only for undeclared input, and runs after the FLAC magic.
- **Per-format output options** are typed `name`/`value` pairs, but the CLI parser's option table is separate (`packages/cli/src/index.ts`). A new option name must be added there once, before the option reaches the backend.
- **Channel layouts.** `stream.channelLayout` comes from the PCM path's layout table: 12 native masks plus the default layouts.

## Evidence

Pinned macOS arm64 oracle (`.build/reference/ffmpeg`, sha256 `1b86106f…ab92`):

- `tests/unit/container-registry.test.ts` (9 tests) checks the registry against the pre-registry predicates of `index.ts` at 9fd9ae3, copied verbatim:
  - input and output names, headerless, default codecs, header and scratch bytes, seek-at-EOF and `dropsMetadata`, for every registered name and 21 unregistered or prototype names;
  - codec refusal messages for 25 formats × 20 PCM codecs;
  - output extensions for 29 paths;
  - packet spans for five rate and frame-size pairs;
  - probe order, results and bytes read for 13 heads at read budgets of 1, 3 and 64 bytes;
  - registration refusals, and that every descriptor part is frozen;
  - every routing refusal message through the CLI, with no output opened.

  A temporary copy of this file, prefixed with a `vi.mock` of `registry.ts` that added seven wave-1-style formats (the `xyz` template above, verbatim, plus mocked sox, rso, wve, nistsphere, md5 and crc), passed unchanged (10 of 10, including an `xyz` detect, mux, demux and exit-234 refusal check), so additions need no edit to it. The template also compiles under the repository `tsconfig.json`.
- `tests/unit/container-registry-extension.test.ts` (7 tests) adds scratch formats only through the registry module. They cover magic and overlapping-head precedence, extension-only detection, a custom packet span (framecrc rows of 7, 7 and 6 samples), native exit statuses 234 and 183 before output creation, the default codec by extension, an output-only muxer with its own option, the input-metadata refusal (wav, aiff and au refused; w64, raw and framecrc accepted), the input seek passed to `open`, and header and scratch bytes in the memory plan.
- Behaviour preservation: the unit suite (210 files, 2652 tests), 58 PCM-path differential files (138 tests: wav, aiff, au, w64, raw PCM, framecrc, G.711, planar, remix, resample, audio filters, memory budget, input and output opening and policy), 14 integration files (39 tests) and 9 workers files (104 tests) pass, as do `npm run typecheck`, `npm run lint`, `npm run boundaries` and `npm run types:declarations`.
