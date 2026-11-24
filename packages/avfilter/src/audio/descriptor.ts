import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioConversionOptions,AudioSampleFormat} from '@edge-ffmpeg/swresample';
import type {AudioPadFormat} from '../pad-checkpoint.js';
export class AudioFilterError extends Error {}
export interface AudioFilterStepBase {readonly name:string}
export interface AudioFilterProcessOptions extends AudioConversionOptions {readonly inputFormat?:AudioPadFormat}
/** Per-step facts consumers query instead of filter names. stateless and changesRate follow from apply and outputRate; stream-only and output-generating steps always reframe. */
export interface AudioFilterCapabilities {
  /** Emits packets beyond its input's, including from a configured empty input (apad tail, adelay silence). */
  readonly generatesOutput:boolean;
  /** Output counts, frame boundaries, cross-frame state or timestamp-dependent samples: output time selection (PCM and FLAC) follows the filter instead of narrowing its input. Implied for stream-only and output-generating steps; a stateless apply() that reads pts must declare it. */
  readonly reframes:boolean;
  /** Allocates new output frames: one frame-producing stage in the PCM memory plan. Required when reserve() declares frames. */
  readonly allocatesFrames:boolean;
  /** Explicit format constraint: automatic rate conversion is negotiated inside the chain (rateBoundary). */
  readonly formatConstraint:boolean;
  /** Accepts automatic sample-rate conversion; false makes rateBoundary() fail explicitly. */
  readonly rateConversion:boolean;
  /** FLAC only: pinned evidence covers this step between FLAC input and output time selection. PCM paths rely on `reframes`. Derived false without `flacInput`. */
  readonly timeSelection:boolean;
  /** FLAC only: pinned evidence covers this step on FLAC input; false makes the FLAC path refuse the chain before decoding. Declared, default false. */
  readonly flacInput:boolean;
  /** apply() handles this step frame by frame; false requires process(). */
  readonly stateless:boolean;
  /** Fixes its output sample rate. */
  readonly changesRate:boolean;
}
export type AudioFilterDeclaredCapabilities = Omit<AudioFilterCapabilities,'stateless'|'changesRate'|'flacInput'>&{readonly flacInput?:boolean};
export interface AudioCountContext {readonly configuredInput?:boolean|undefined;readonly channels?:number|undefined}
export interface AudioPacketRun {readonly samples:bigint;readonly span:bigint}
/** Packet-boundary effect of one step, applied in order: regroup every sample into `reframe`-sample packets, then prepend `leading`, then append `trailing`. */
export interface AudioPacketChange {readonly reframe?:bigint;readonly leading?:AudioPacketRun;readonly trailing?:AudioPacketRun}
export interface AudioCountChange {readonly samples:bigint;readonly buffers:readonly number[];readonly packets?:AudioPacketChange}
/** A native sample format, including the 64-bit integer formats no chain step implements (a negotiation that picks one fails explicitly). */
export type AudioNativeSampleFormat = AudioSampleFormat|'s64'|'s64p';
/** Native format set. An array is the filter's native list (FILTER_SAMPLEFMTS / query_formats order, one entry for a pinned format):
 * the chain then reproduces native merging with its neighbours and the encoder, and fails explicitly where it cannot.
 * 'all' merges both neighbours. The other strings are the pre-registry vocabulary ('planar'/'integer' restrict the merged set, a sample format pins it):
 * only adelay, aformat and volume may return them, because no native merge model checks them.
 */
export type AudioFormatSet = 'all'|'planar'|'integer'|AudioSampleFormat|readonly AudioNativeSampleFormat[];
export interface AudioNegotiation {
  /** Encoder format hint (s32 for direct API use). */
  readonly outputHint:AudioSampleFormat;
  /** Format pinned by the nearest later step; null when only merging steps follow. */
  readonly nextPinned:AudioSampleFormat|null;
  /** Name of a planar-only step sharing this step's merged format set, or null. */
  readonly planarNeighbour:string|null;
}
/** `channelLayout` is the stream's layout name. Without a container mask, or with the default mask for the channel count, it is 'mono', 'stereo',
 * 'unspecified' (a guessed default of 3 or more channels) or '<n> channels' (an unguessed layout, -guess_layout_max).
 * A WAV/W64 WAVEFORMATEXTENSIBLE mask that is not the default for its channel count arrives under native's name for that mask instead
 * (av_channel_layout_describe: '2 channels (FL+FC)', 'downmix', '3.0(back)'), so a check for 'stereo' refuses it.
 */
export type AudioFormatCheck = (format:Pick<AudioPadFormat,'sampleRate'|'channels'|'channelLayout'>)=>void;
/** Rate and negotiated input format at this step; channels never change inside a chain.
 * `samples` is the step's planned input count when the caller knows it (PCM plan, with `configuredInput`); absent, reserve for any input length (FLAC streaming).
 */
export interface AudioReservationContext {readonly sampleRate:number;readonly channels:number;readonly sampleFormat:AudioSampleFormat;readonly samples?:bigint|undefined;readonly configuredInput?:boolean|undefined}
/** Resident memory a step holds across a downstream yield; the only memory declaration both planners read.
 * The FLAC helper reserves it directly. The PCM plan gives every allocatesFrames step (or two declared frames) one frame-producing stage,
 * and reserves the buffers and state that the step's own count().buffers slots do not already hold.
 */
export interface AudioReservation {
  /** Output frames retained across a downstream yield: one maxFrameBytes slot each (FLAC), half a frame-producing stage each (PCM). */
  readonly frames:number;
  /** Per-channel sample buffers at the widest chain sample width, each bounded by one frame allocation. */
  readonly buffers:readonly {readonly samples:number;readonly copies:number}[];
  /** Exact state bytes outside frames (delay rings, histories), bounded by one frame allocation. */
  readonly stateBytes:bigint;
}
/** One filter. Hooks are methods so a typed descriptor registers under the step-erased chain type.
 * Every descriptor needs exactly one of apply or stream; omitted hooks mean: no rate, count, packet, buffer, precision or format effect.
 */
export interface AudioFilterDescriptor<S extends AudioFilterStepBase> {
  readonly name:S['name'];
  /** Representative accepted tokens; the registry test checks each against every consumer's contract. */
  readonly examples:readonly string[];
  /** A trimmed chain token equal to `name` or starting with `name=`; returns a frozen step or throws. */
  parse(text:string):S;
  capabilities(step:S):AudioFilterDeclaredCapabilities;
  /** Fixed output sample rate; rate constraints do not propagate backwards across it. */
  outputRate?(step:S):number;
  /** Output count, retained sample buffers (PCM slots: two each, sized to the largest) and packet effect at the step's input rate. Sections must sum to `samples`.
   * Required for a step that declares generatesOutput: the generated packets are its count change.
   */
  count?(step:S,samples:bigint,rate:number|undefined,context:AudioCountContext):AudioCountChange;
  /** Fixed output packet span. */
  packetSpan?(step:S):bigint;
  /** Largest sample buffer held between input frames (AudioFilterChain.maxBufferedSamples). */
  bufferedSamples?(step:S):number;
  /** Intermediate width and arithmetic; the last non-null kind is the chain outputSampleFormat. Default for an array set: the widest listed width, no kind. */
  precision?(step:S):{readonly bytesPerSample:number;readonly kind:'flt'|'dbl'|'integer'}|null;
  /** Default 'all'. New filters return their native list as an array; 'all' only suits format-transparent filters (copies, reframing, padding, metadata).
   * Any other string compiles only for the pre-registry adelay, aformat and volume ('Invalid audio filter format set: <name>').
   */
  formats?(step:S):AudioFormatSet;
  /** Pre-registry only (adelay, volume): the native list that a string formats() approximates (volume: flt -> [flt,fltp]), read only to model native merging next to array sets. */
  nativeFormats?(step:S):readonly AudioNativeSampleFormat[];
  /** Output samples are input samples (copied, permuted, delayed or padded with silence), so the working sample format never changes values and the native merge model does not compare it. Implied by formats 'all'. */
  readonly transparent?:boolean;
  /** Pre-registry only (volume): output format from the negotiated input. The chain's own pick is the default: for an array, the native pick (the input when listed,
   * else the closest entry after merging with later lists and the encoder); the pinned format; the planar form for 'planar'; otherwise the input.
   * Chains with an array set check every result against the native merge model. Any other descriptor declaring it fails registration.
   */
  negotiate?(step:S,input:AudioSampleFormat,context:AudioNegotiation):AudioSampleFormat;
  /** Stream format check at this step (rate after earlier outputRate steps, channels, layout name; see AudioFormatCheck), or null when the step constrains nothing.
   * Throw AudioFilterError for every input native would resample or remix implicitly; both CLI paths run it before opening output.
   */
  constraint?(step:S):AudioFormatCheck|null;
  /** Stateless frame transform to the negotiated `target`. Absent: '<name> requires stream processing'. */
  apply?(step:S,frame:AudioFrameData,target:AudioSampleFormat,options:AudioConversionOptions):AudioFrameData;
  /** Stateful stream transform; `configured` is the empty-input format reaching this step, when known.
   * Frames arrive as the previous step produced them; `negotiated(frame.sampleFormat)` is the format this step must work in and emit (convertAudioFrame to it).
   */
  stream?(step:S,frames:AsyncIterable<AudioFrameData>,options:AudioFilterProcessOptions,configured:AudioPadFormat|undefined,negotiated:(input:AudioSampleFormat)=>AudioSampleFormat):AsyncIterable<AudioFrameData>;
  /** Configured format after the step; the chain then assigns the negotiated sample format. */
  configure?(step:S,format:AudioPadFormat):AudioPadFormat;
  /** Resident memory held across a downstream yield, read by the FLAC helper and the PCM plan. Absent or null: nothing. */
  reserve?(step:S,context:AudioReservationContext):AudioReservation|null;
}
export const sampleFormats:readonly string[]=['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'];
/** Native enum order (ff_all_formats): converter merges sort a format list into it. */
export const nativeSampleFormats:readonly AudioNativeSampleFormat[]=['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp','s64','s64p'];
export const widths:Readonly<Record<string,number>>={u8:1,s16:2,s32:4,flt:4,dbl:8};
export const packed=(format:AudioSampleFormat):AudioSampleFormat=>format.endsWith('p')?format.slice(0,-1) as AudioSampleFormat:format;
export const isInteger=(format:AudioSampleFormat)=>['u8','s16','s32'].includes(packed(format));
export const noReservation:AudioReservation=Object.freeze({frames:0,buffers:Object.freeze([]),stateBytes:0n});
export const frameReservation:AudioReservation=Object.freeze({frames:1,buffers:Object.freeze([]),stateBytes:0n});
export function defineAudioFilter<S extends AudioFilterStepBase>(descriptor:AudioFilterDescriptor<S>):AudioFilterDescriptor<S> {return Object.freeze(descriptor);}
