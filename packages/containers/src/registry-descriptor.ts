import {ExecutionError} from '@edge-ffmpeg/core';
import type {ReadHandle,WriteHandle} from '@edge-ffmpeg/core';
import type {MediaPacket,PcmCodec} from '@edge-ffmpeg/avutil';
import type {FrameCrcOptions} from './framecrc.js';
/** Demuxed stream facts the PCM backend reads; WavInfo, RawPcmInfo and every container info extend it. */
export interface ContainerStreamInfo {
  readonly codec:string;readonly channels:number;readonly sampleRate:number;readonly channelMask:number|null;
  readonly blockAlign:number;readonly durationSamples:bigint;
  /** True when the native demuxer exports global metadata (tags, comments) for this input: refused unless the muxer sets dropsMetadata, since nothing carries tags to a muxer. */
  readonly metadata?:boolean;
}
/** An opened finite input: packets start at an exact sample frame and carry at most maxPacketBytes. */
export interface ContainerInput<I extends ContainerStreamInfo=ContainerStreamInfo> {readonly info:I;packets(startSample?:bigint,maxPacketBytes?:number):AsyncIterable<MediaPacket>}
/** Input -ar/-ac/-guess_layout_max (44100 Hz mono when absent); only headerless formats accept declarations. */
export interface ContainerDeclaration {readonly sampleRate:number;readonly channels:number;
  /** False when -guess_layout_max is below the channel count: no default layout mask. */
  readonly guessLayout:boolean}
export interface ContainerOpenOptions {readonly maxReadBytes:number;readonly signal:AbortSignal;readonly declared:ContainerDeclaration;
  /** Input -ss in microseconds (0n when absent), so a demuxer can refuse a seek whose native semantics it does not mirror. */
  readonly seek:bigint}
/** Magic detection of an undeclared input. */
export interface ContainerProbe {
  /** Fixed probe order, ascending; equal values resolve by name. Exact, non-overlapping magics may share a value; an overlapping head needs its own. */
  readonly precedence:number;
  /** Match on the first four bytes (read-only). Only a matching head may read further. */
  head(bytes:Uint8Array):boolean;
  /** Bounded confirmation after a head match (w64's GUIDs); absent, the head decides. */
  confirm?(input:ReadHandle,maxReadBytes:number,signal?:AbortSignal):Promise<boolean>;
}
/** Hooks are methods so a typed demuxer registers under the erased registry type. */
export interface ContainerDemuxer<I extends ContainerStreamInfo=ContainerStreamInfo> {
  readonly probe?:ContainerProbe;
  /** Lower-case input extensions ('.rso') that select the format when no probe matches; only for native demuxers without read_probe. */
  readonly extensions?:readonly string[];
  /** Header bytes held while the input is open: inputHeaderBytes of the PCM memory plan. */
  readonly headerBytes:number;
  open(source:ReadHandle,options:ContainerOpenOptions):Promise<ContainerInput<I>>;
  /** Native input packet span in samples (time ranges, packet schedules, framecrc regrouping). Absent: the PCM default for the rate (pcmPacketSpan). */
  packetSpan?(info:I):bigint;
  /** Input -ss at or beyond the end selects nothing, as native does, instead of failing as unimplemented. */
  readonly seekBeyondEnd?:boolean;
}
export interface ContainerOption {readonly name:string;readonly value:string|null}
export type ContainerFraming=NonNullable<FrameCrcOptions['framing']>;
/** The encoded output stream every muxer hook receives. */
export interface ContainerOutputStream {
  readonly codec:PcmCodec;readonly channels:number;readonly sampleRate:number;
  /** Source layout mask (WAVEFORMATEXTENSIBLE, AIFF CHAN); null after channel conversion. */
  readonly channelMask:number|null;
  /** Mask for muxers that always write a layout: the source mask, else the default layout when it is guessed or converted. */
  readonly layoutMask:number|bigint|null;
  /** Native channel layout name; '' when the mask has none. */
  readonly channelLayout:string;
  /** Exact output sample count. */
  readonly samples:bigint;
  readonly bitexact:boolean;
  /** This format's own output options (mux.options), in command order. */
  readonly options:readonly ContainerOption[];
}
export interface ContainerMuxOptions {readonly maxWriteBytes:number;readonly signal:AbortSignal;
  /** Packet boundaries of the selected range, for per-packet muxers (framecrc). */
  readonly framing:ContainerFraming}
export interface ContainerMuxer {
  /** Name in `<label> muxer does not support <codec>` and in the supported-output listing. */
  readonly label:string;
  /** Position in the supported-output listing, never routing; unordered muxers follow by name. */
  readonly order?:number;
  /** Lower-case output extensions ('.wav') that select the format without -f. */
  readonly extensions?:readonly string[];
  /** Codec when no -c is given. */
  readonly defaultCodec:PcmCodec;
  /** Encodings written; checked before the output policy. */
  supports(codec:PcmCodec):boolean;
  /** Error for an unsupported codec (native status); default unsupported-command `<label> muxer does not support <codec>`. */
  refuse?(codec:PcmCodec):Error;
  /** Output options only this format accepts ('-hash'); every other format refuses them as unsupported output options. */
  readonly options?:readonly string[];
  /** Header and trailer bytes held while writing: outputScratchBytes of the PCM memory plan. */
  readonly scratchBytes:number;
  /** The native muxer writes no input metadata (raw, framecrc, w64), so inputs with info.metadata are accepted. Absent, they are refused before the output policy. */
  readonly dropsMetadata?:boolean;
  /** Every refusal that needs no output (geometry, size fields, option values), after the input opens and before the output is created. */
  validate?(stream:ContainerOutputStream):void;
  /** Writes the stream and commits the output, or aborts it on any failure. */
  write(output:WriteHandle,stream:ContainerOutputStream,packets:AsyncIterable<MediaPacket>,options:ContainerMuxOptions):Promise<void>;
}
/** One container format, registered under its -f name. A demux-only format omits mux; an output-only format omits demux. */
export interface ContainerDescriptor {
  readonly name:string;
  /** Headerless PCM: never detected, takes input declarations, defers a failed first read past the output checks, and is listed as "an explicit raw PCM format". */
  readonly headerless?:boolean;
  readonly demux?:ContainerDemuxer;
  readonly mux?:ContainerMuxer;
}
/** Freezes the descriptor, its demuxer, muxer, probe and lists, and keeps its literal type (ContainerName, DetectableContainerName). */
export function defineContainer<const D extends ContainerDescriptor>(descriptor:D):D{
  const {demux,mux}=descriptor;
  if(demux){Object.freeze(demux.probe);Object.freeze(demux.extensions);Object.freeze(demux);}
  if(mux){Object.freeze(mux.extensions);Object.freeze(mux.options);Object.freeze(mux);}
  return Object.freeze(descriptor);
}
/** The refusal error class of the PCM backend: unsupported-command, exit 1 unless a native status is given. */
export function containerRefusal(message:string,exitCode?:number):ExecutionError{return new ExecutionError('unsupported-command',message,exitCode===undefined?{}:{exitCode});}
