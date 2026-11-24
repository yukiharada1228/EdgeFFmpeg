import {resampledSampleCount} from '@edge-ffmpeg/swresample';
import type {AudioConversionOptions,AudioSampleFormat} from '@edge-ffmpeg/swresample';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioPadFormat} from '../pad-checkpoint.js';
import * as registry from './registry.js';
import type {AudioCountChange,AudioFilterCapabilities,AudioFilterDescriptor,AudioFilterProcessOptions,AudioFilterStepBase,AudioFormatSet,AudioNativeSampleFormat,AudioNegotiation,AudioPacketChange,AudioReservation} from './descriptor.js';
import {AudioFilterError,isInteger,nativeSampleFormats,noReservation,packed,sampleFormats,widths} from './descriptor.js';
type StepOf<D> = D extends AudioFilterDescriptor<infer S> ? S : never;
/** Union of every registered descriptor's step. */
export type AudioFilterStep = StepOf<typeof registry[keyof typeof registry]>;
export interface AudioRateBoundary {
  readonly beforeStep:number;
  readonly inputRate:number;
  readonly outputRate:number;
  readonly inputFormat:AudioSampleFormat;
  readonly outputFormat:AudioSampleFormat;
}
export type AudioCountRateBoundary = Pick<AudioRateBoundary, 'beforeStep' | 'inputRate' | 'outputRate'>;
export interface AudioCountOptions {readonly rateBoundary?:AudioCountRateBoundary;readonly configuredInput?:boolean;readonly channels?:number}
export interface AudioStreamInsertion {
  readonly outputFormat?:AudioPadFormat;
  readonly beforeStep:number;
  readonly transform:(frames:AsyncIterable<AudioFrameData>)=>AsyncIterable<AudioFrameData>;
}
export interface AudioFilterCountStage {
  readonly step:AudioFilterStep|null;
  readonly inputSamples:bigint;
  readonly outputSamples:bigint;
  readonly inputRate:number|undefined;
  readonly outputRate:number|undefined;
  /** The step's packet-boundary effect, when it has one. */
  readonly packets?:AudioPacketChange;
}
export interface AudioFilterCountPlan {readonly samples:bigint;readonly buffers:readonly number[];readonly stages:readonly AudioFilterCountStage[]}
/** A planned stream: its input sample count plus the count options planSamples() takes. */
export interface AudioReservationPlan extends AudioCountOptions {readonly samples:bigint}
export interface AudioPlannedReservation {
  readonly step:AudioFilterStep;
  /** The descriptor reservation for the step's planned input count, rate and negotiated input format. */
  readonly reservation:AudioReservation;
  /** The step's own count() buffers, in requiredBufferSamples() order. */
  readonly countBuffers:readonly number[];
}
export interface AudioFilterChain {
  readonly steps: readonly AudioFilterStep[];
  readonly reframes: boolean;
  readonly maxBufferedSamples: number;
  planSamples(inputSamples:bigint,inputRate?:number,options?:AudioCountOptions):AudioFilterCountPlan;
  outputSamples(inputSamples: bigint,inputRate?:number,options?:AudioCountOptions): bigint;
  requiredBufferSamples(inputSamples:bigint,inputRate?:number,options?:AudioCountOptions):readonly number[];
  outputPacketSamples(inputSpan: bigint): bigint;
  packetSections(inputSamples:bigint,inputSpan:bigint,inputRate?:number,configuredInput?:boolean,channels?:number):readonly {readonly samples:bigint;readonly span:bigint}[];
  validateInputFormat(format:Pick<AudioPadFormat,'sampleRate'|'channels'|'channelLayout'>,insertion?:AudioStreamInsertion):void;
  resolvedSampleFormat(input:AudioSampleFormat):AudioSampleFormat;
  /** Whether a step declares a native format list, so negotiation follows the native merge model. */
  readonly nativeFormatLists:boolean;
  /** The format each step works in and emits, in step order, for a chain input format. */
  negotiatedSampleFormats(input:AudioSampleFormat):readonly AudioSampleFormat[];
  rateBoundary(input:AudioSampleFormat,inputRate:number,outputRate:number):AudioRateBoundary|null;
  process(frames: AsyncIterable<AudioFrameData>, options: AudioFilterProcessOptions, insertion?:AudioStreamInsertion): AsyncIterable<AudioFrameData>;
  readonly maxBytesPerSample: number;
  readonly outputSampleFormat: 'flt' | 'dbl' | 'integer' | null;
  outputSampleRate(inputRate: number): number;
  requiresScalarRounding(input: AudioSampleFormat): boolean;
  apply(frame: AudioFrameData, options: AudioConversionOptions): AudioFrameData;
  /** Per-step capabilities, in step order. */
  readonly capabilities:readonly AudioFilterCapabilities[];
  /** Whether any step has the capability. */
  has(capability:keyof AudioFilterCapabilities):boolean;
  /** One resident reservation per step, lazily in step order, for a stream of any length entering in `input` format. */
  reservations(input:Pick<AudioPadFormat,'sampleRate'|'channels'|'sampleFormat'>):Iterable<AudioReservation>;
  /** One reservation per step for a planned stream, in step order: counts and rates follow planSamples(), including its rate boundary. */
  plannedReservations(input:Pick<AudioPadFormat,'sampleRate'|'channels'|'sampleFormat'>,plan:AudioReservationPlan):readonly AudioPlannedReservation[];
}
type Descriptor = AudioFilterDescriptor<AudioFilterStepBase>;
/** The pre-registry descriptors whose string format sets and negotiate/nativeFormats hooks predate native lists; their own tests pin them.
 * Frozen: no native merge model checks these hooks, so every other descriptor declares an array formats() (or 'all') and the chain picks.
 */
const approximations:ReadonlySet<string>=new Set(['adelay','aformat','volume']);
const descriptors:ReadonlyMap<string,Descriptor>=new Map(Object.entries(registry).map(([key,descriptor]):[string,Descriptor]=>{
  // Exactly one of apply and stream: process() runs stream when present, so a second hook would classify the step as stateless while it keeps state.
  if(key!==descriptor.name||!descriptor.apply===!descriptor.stream||!descriptor.examples?.length||!approximations.has(key)&&(descriptor.negotiate!==undefined||descriptor.nativeFormats!==undefined))throw new Error(`Invalid audio filter registration: ${key}`);
  return [key,descriptor];
}));
const capabilitiesOf=(node:Descriptor,step:AudioFilterStepBase):AudioFilterCapabilities=>{
  // Cross-frame state and generated output always need the whole input, so such a step reframes whatever it declares.
  // The native merge model has no rate boundary, so a step with a native format list never accepts automatic rate conversion.
  // FLAC time selection is evidence on FLAC input, so it needs flacInput (absent: false).
  const declared=node.capabilities(step),flacInput=declared.flacInput===true;
  return Object.freeze({...declared,reframes:declared.reframes||declared.generatesOutput||node.apply===undefined,rateConversion:declared.rateConversion&&typeof (node.formats?.(step)??'all')==='string',timeSelection:declared.timeSelection&&flacInput,flacInput,stateless:node.apply!==undefined,changesRate:node.outputRate!==undefined});
};
/** Capabilities of one compiled step, for consumers holding a step without its chain. */
export function audioFilterCapabilities(step:AudioFilterStep):AudioFilterCapabilities {
  const node=descriptors.get(step.name);
  if(!node)throw new AudioFilterError(`Unsupported audio filter: ${step.name}`);
  return capabilitiesOf(node,step);
}
const listed=(set:AudioFormatSet):set is readonly AudioNativeSampleFormat[]=>typeof set!=='string';
const pinned=(set:AudioFormatSet):AudioSampleFormat|null=>listed(set)?set.length===1&&sampleFormats.includes(set[0]!)?set[0] as AudioSampleFormat:null:set==='all'||set==='planar'||set==='integer'?null:set;
const nativeWidths:Readonly<Record<string,number>>={...widths,s64:8},base=(format:AudioNativeSampleFormat)=>format.endsWith('p')?format.slice(0,-1):format;
/** get_fmt_score (libavfilter/avfiltergraph.c): planarity change, width change, s32/flt cross terms; lower is better. */
function formatScore(target:AudioNativeSampleFormat,source:AudioNativeSampleFormat):number {
  const to=nativeWidths[base(target)]!,from=nativeWidths[base(source)]!;
  return Number(target.endsWith('p')!==source.endsWith('p'))+(to<from?100*(from-to):10*(to-from))+(base(target)==='s32'&&base(source)==='flt'?20:0)+(base(target)==='flt'&&base(source)==='s32'?2:0);
}
/** swap_sample_fmts_on_filter: a converter fed one format moves its preferred output (same sample type, s32/flt to 8 bytes, else the closest wider width) to the front. */
function swapFormats(list:readonly AudioNativeSampleFormat[],reference:AudioNativeSampleFormat):AudioNativeSampleFormat[] {
  const width=nativeWidths[base(reference)]!,result=[...list];let best=0,score=-Infinity;
  for(const [index,format]of list.entries()){
    const candidate=nativeWidths[base(format)]!;
    if(base(format)===reference||`${base(format)}p`===reference||width===4&&candidate===8){best=index;break;}
    const value=-Math.abs(candidate-width)+(candidate>=width?2**30:0);
    if(value>score){score=value;best=index;}
  }
  [result[0],result[best]]=[result[best]!,result[0]!];
  return result;
}
/** pick_format after a converter: the list in native enum order (converter merges sort it), swapped when the converter is fed one format, then the lowest score with ties to the later entry. */
function chooseFormat(formats:readonly AudioNativeSampleFormat[],reference:AudioNativeSampleFormat,swap:boolean):AudioNativeSampleFormat {
  if(formats.length===1)return formats[0]!;
  const ordered=nativeSampleFormats.filter(format=>formats.includes(format)),list=swap?swapFormats(ordered,reference):ordered;
  return list.reduce((best,format)=>formatScore(format,reference)<=formatScore(best,reference)?format:best);
}
const frozenPackets=(packets:AudioPacketChange):AudioPacketChange=>Object.freeze({...(packets.reframe!==undefined?{reframe:packets.reframe}:{}),...(packets.leading?{leading:Object.freeze({...packets.leading})}:{}),...(packets.trailing?{trailing:Object.freeze({...packets.trailing})}:{})});
/** Compiles a bounded single-input audio chain from the registered descriptors. No expression evaluation or graph labels. */
export function compileAudioFilterChain(description: string, negotiation: { readonly outputSampleFormat?: AudioSampleFormat; readonly outputConversion?: boolean } = {}): AudioFilterChain {
  // outputConversion: a channel conversion follows the chain, so native cannot merge its last format list with the encoder's.
  const outputHint = negotiation.outputSampleFormat ?? 's32',outputConversion=negotiation.outputConversion===true;
  if (!sampleFormats.includes(outputHint)) throw new AudioFilterError('Unsupported output sample format hint');
  if (!description || description.length > 4096) throw new AudioFilterError('Invalid audio filter description length');
  const tokens = description.split(',');
  if (tokens.length > 32) throw new AudioFilterError('Audio filter chain exceeds node limit');
  const steps: AudioFilterStep[] = [],nodes:Descriptor[]=[];
  for (const token of tokens) {
    const text = token.trim(),equals=text.indexOf('='),descriptor=descriptors.get(equals<0?text:text.slice(0,equals));
    if(!descriptor)throw new AudioFilterError(`Unsupported audio filter: ${text}`);
    steps.push(descriptor.parse(text) as AudioFilterStep);nodes.push(descriptor);
  }
  const sets=steps.map((step,index)=>{
    const set=nodes[index]!.formats?.(step)??'all';
    if(listed(set)&&(!set.length||new Set(set).size!==set.length||!set.every(format=>nativeSampleFormats.includes(format))))throw new Error(`Invalid audio filter format list: ${step.name}`);
    // A restricting or pinning string is checked by no merge model: a new filter returns its native list as an array.
    if(!listed(set)&&set!=='all'&&!approximations.has(step.name))throw new Error(`Invalid audio filter format set: ${step.name}`);
    return set;
  });
  let maxBytesPerSample = 0, outputSampleFormat: 'flt' | 'dbl' | 'integer' | null = null;
  for(const [index,step]of steps.entries()){
    const precision=nodes[index]!.precision?.(step),set=sets[index]!;
    if(precision){maxBytesPerSample=Math.max(maxBytesPerSample,precision.bytesPerSample);outputSampleFormat=precision.kind;}
    else if(listed(set))maxBytesPerSample=Math.max(maxBytesPerSample,...set.map(format=>nativeWidths[base(format)]!));
  }
  const capabilities=Object.freeze(steps.map((step,index)=>capabilitiesOf(nodes[index]!,step)));
  // Generated packets are a count change: without count() the PCM range stops at the input count and silently cuts the tail.
  const tail=steps.findIndex((_,index)=>capabilities[index]!.generatesOutput&&!nodes[index]!.count);
  if(tail>=0)throw new Error(`Invalid audio filter declaration: ${steps[tail]!.name} generates output without count()`);
  const listedChain=sets.some(listed);
  // Native lists for the merge model; the string vocabulary maps to the lists it approximates.
  const natives=steps.map((step,index):readonly AudioNativeSampleFormat[]=>{
    const set=sets[index]!;
    if(listed(set))return set;
    return nodes[index]!.nativeFormats?.(step)??(set==='all'?nativeSampleFormats:set==='planar'?nativeSampleFormats.filter(format=>format.endsWith('p')):set==='integer'?nativeSampleFormats.filter(format=>['u8','s16','s32'].includes(base(format))):[set]);
  });
  const contexts:readonly AudioNegotiation[]=steps.map((_,index)=>{
    // A merged set extends backwards through 'all'/'planar' steps and forwards through every unpinned step.
    let planarNeighbour:string|null=null;
    for(let before=index-1;before>=0&&(sets[before]==='all'||sets[before]==='planar');before--)if(sets[before]==='planar'){planarNeighbour=steps[before]!.name;break;}
    for(let after=index+1;planarNeighbour===null&&after<steps.length&&pinned(sets[after]!)===null;after++)if(sets[after]==='planar')planarNeighbour=steps[after]!.name;
    return Object.freeze({outputHint,nextPinned:sets.slice(index+1).map(pinned).find(format=>format!==null)??null,planarNeighbour});
  });
  /** Native pick for an array set: the input when listed; otherwise a converter feeds the list, merged forwards until a later list or the encoder shares nothing. */
  const listedPick=(index:number,input:AudioSampleFormat):AudioSampleFormat=>{
    if(!sampleFormats.includes(input))throw new AudioFilterError('Invalid format negotiation input');
    const list=natives[index]!;
    let pick:AudioNativeSampleFormat=input;
    if(!list.includes(input)){
      let candidates=list,open=true;
      for(let after=index+1;open&&after<steps.length;after++){const common=natives[after]!.filter(format=>candidates.includes(format));if(common.length)candidates=common;else open=false;}
      if(open&&!outputConversion&&candidates.includes(outputHint))candidates=[outputHint];
      pick=chooseFormat(candidates,input,true);
    }
    if(!sampleFormats.includes(pick))throw new AudioFilterError(`${steps[index]!.name} with ${input} input negotiates ${pick}, which is not implemented`);
    return pick as AudioSampleFormat;
  };
  const negotiate=(index:number,input:AudioSampleFormat):AudioSampleFormat=>{
    const node=nodes[index]!,set=sets[index]!;
    if(node.negotiate)return node.negotiate(steps[index]!,input,contexts[index]!);
    if(listed(set))return listedPick(index,input);
    return set==='planar'?`${packed(input)}p` as AudioSampleFormat:pinned(set)??input;
  };
  /** Native linear negotiation (query_formats, then pick_formats): format lists merge along links from left to right and a converter starts a new segment.
   * inputFirst: the source format merges before the filters (no input trim); otherwise after them (an input atrim sits between). merged: the encoder format merges last.
   */
  const simulate=(input:AudioSampleFormat,inputFirst:boolean,merged:boolean)=>{
    const segments:{formats:readonly AudioNativeSampleFormat[];readonly members:number[]}[]=inputFirst?[{formats:[input],members:[]}]:[];
    for(const [index,list]of natives.entries()){
      const current=segments.at(-1),common=current?list.filter(format=>current.formats.includes(format)):[];
      if(current&&common.length){current.formats=common;current.members.push(index);}
      else segments.push({formats:list,members:[index]});
    }
    const first=segments[0];
    if(!inputFirst){if(first?.formats.includes(input))first.formats=[input];else segments.unshift({formats:[input],members:[]});}
    const last=segments.at(-1)!;
    if(merged&&last.formats.includes(outputHint))last.formats=[outputHint];
    let reference:AudioNativeSampleFormat=input,single=true;
    return segments.map(segment=>{const format=chooseFormat(segment.formats,reference,single);reference=format;single=segment.formats.length===1;return {format,members:segment.members};});
  };
  // In a chain with an array set, every step that is not transparent must work in the native pick's sample type, with and without an input trim
  // (which merges the source format last), or the chain refuses. The pre-registry rules assume a later list merges or pins; a list that blocks the encoder merge is only modelled here.
  const verified=new Set<string>(),owner=steps.findIndex((_,index)=>listed(sets[index]!)),opaque=steps.map((_,index)=>sets[index]!=='all'&&nodes[index]!.transparent!==true);
  const verify=(input:AudioSampleFormat,local:readonly AudioSampleFormat[])=>{
    for(const inputFirst of [true,false])for(const {format,members}of simulate(input,inputFirst,!outputConversion)){
      const member=members.find(index=>opaque[index]&&base(format)!==packed(local[index]!));
      if(member===undefined)continue;
      const name=listed(sets[member]!)?steps[member]!.name:steps[members.find(index=>listed(sets[index]!))??owner]!.name;
      throw new AudioFilterError(`${name} with ${input} input requires unimplemented format negotiation`);
    }
  };
  const walkCounts=(inputSamples:bigint,inputRate:number|undefined,options:AudioCountOptions,visit?:(index:number,samples:bigint,rate:number|undefined,change:AudioCountChange|undefined)=>void)=>{
    const insertion=options.rateBoundary;
    if(typeof inputSamples!=='bigint'||inputSamples<0n)throw new AudioFilterError('Invalid input sample count');
    const boundary=insertion?{...insertion}:undefined;
    if(boundary&&(!Number.isInteger(boundary.beforeStep)||boundary.beforeStep<0||boundary.beforeStep>steps.length||![boundary.inputRate,boundary.outputRate].every(rate=>Number.isInteger(rate)&&rate>0&&rate<=2147483647)))throw new AudioFilterError('Invalid count rate boundary');
    let count=inputSamples,rate=inputRate;const buffers:number[]=[],stages:AudioFilterCountStage[]=[];
    for(let index=0;index<=steps.length;index++){
      if(boundary?.beforeStep===index){
        if(rate!==boundary.inputRate)throw new AudioFilterError('Count rate boundary does not match filter input rate');
        const inputSamples=count;count=resampledSampleCount(count,boundary.inputRate,boundary.outputRate);rate=boundary.outputRate;
        stages.push(Object.freeze({step:null,inputSamples,outputSamples:count,inputRate:boundary.inputRate,outputRate:rate}));
      }
      const step=steps[index];if(!step)continue;
      const node=nodes[index]!,before=count,rateBefore=rate,change=node.count?.(step,count,rate,options);
      visit?.(index,before,rateBefore,change);
      if(change){buffers.push(...change.buffers);count=change.samples;}
      rate=node.outputRate?.(step)??rate;
      stages.push(Object.freeze({step,inputSamples:before,outputSamples:count,inputRate:rateBefore,outputRate:rate,...(change?.packets?{packets:frozenPackets(change.packets)}:{})}));
    }
    return Object.freeze({samples:count,buffers:Object.freeze(buffers),stages:Object.freeze(stages)});
  };
  const planCounts=(inputSamples:bigint,inputRate?:number,options:AudioCountOptions={})=>walkCounts(inputSamples,inputRate,options);
  const targets = (input: AudioSampleFormat, start=0): AudioSampleFormat[] => {
    let current = input;
    const result=steps.slice(start).map((_,localIndex)=>current=negotiate(start+localIndex,current));
    if(listedChain&&start===0&&!verified.has(input)){verify(input,result);verified.add(input);}
    return result;
  };
  const checks=steps.map((step,index)=>nodes[index]!.constraint?.(step)??null),constrained=steps.find((_,index)=>checks[index]!==null);
  const validateConstraints=(initial:Pick<AudioPadFormat,'sampleRate'|'channels'|'channelLayout'>,insertion?:AudioStreamInsertion)=>{
    let rate=initial.sampleRate,channels=initial.channels,layout=initial.channelLayout;
    for(const [index,step]of steps.entries()){
      if(insertion?.beforeStep===index&&insertion.outputFormat){rate=insertion.outputFormat.sampleRate;channels=insertion.outputFormat.channels;layout=insertion.outputFormat.channelLayout;}
      checks[index]?.({sampleRate:rate,channels,channelLayout:layout});
      rate=nodes[index]!.outputRate?.(step)??rate;
    }
  };
  const applyRange=(frame:AudioFrameData,options:AudioConversionOptions,start:number,end:number):AudioFrameData=>{
      options.signal?.throwIfAborted();
      const planar=frame.sampleFormat.endsWith('p'),base=planar?frame.sampleFormat.slice(0,-1):frame.sampleFormat;
      const total=frame.samples*frame.channels*(widths[base]??0);
      if(!Object.hasOwn(widths,base)||!Number.isSafeInteger(frame.samples)||frame.samples<=0||!Number.isSafeInteger(frame.channels)||frame.channels<=0||!Number.isSafeInteger(frame.sampleRate)||frame.sampleRate<=0||!Number.isSafeInteger(total)||frame.planes.length!==(planar?frame.channels:1))throw new AudioFilterError('Invalid audio filter frame');
      if(!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<=0||total>options.maxFrameBytes)throw new AudioFilterError('Audio filter frame exceeds allocation limit');
      for(let channel=0;channel<frame.planes.length;channel++){options.signal?.throwIfAborted();const plane=frame.planes[channel];if(!(plane instanceof Uint8Array)||plane.length!==frame.samples*(planar?1:frame.channels)*widths[base]!)throw new AudioFilterError('Invalid audio filter plane');}
      let current = frame;
      const formats = targets(frame.sampleFormat as AudioSampleFormat,start);
      for (const [index,step] of steps.slice(start,end).entries()) {
        options.signal?.throwIfAborted();
        const node=nodes[start+index]!;
        if(!node.apply)throw new AudioFilterError(`${step.name} requires stream processing`);
        current=node.apply(step,current,formats[index]!,options);
      }
      return current;
  };
  return Object.freeze({
    steps: Object.freeze(steps), maxBytesPerSample, outputSampleFormat, nativeFormatLists:listedChain,
    validateInputFormat:validateConstraints,
    reframes:capabilities.some(capability=>capability.reframes),
    maxBufferedSamples:Math.max(0,...steps.map((step,index)=>nodes[index]!.bufferedSamples?.(step)??0)),
    planSamples:planCounts,
    outputSamples(inputSamples:bigint,inputRate?:number,options?:AudioCountOptions):bigint {return planCounts(inputSamples,inputRate,options).samples;},
    requiredBufferSamples(inputSamples:bigint,inputRate?:number,options?:AudioCountOptions){return planCounts(inputSamples,inputRate,options).buffers;},
    packetSections(inputSamples:bigint,inputSpan:bigint,inputRate?:number,configuredInput?:boolean,channels?:number){
      if(inputSamples<0n||inputSpan<1n)throw new AudioFilterError('Invalid packet section input');
      let count=inputSamples,rate=inputRate,sections=count?[{samples:count,span:inputSpan}]:[];
      for(const [index,step]of steps.entries()){
        const node=nodes[index]!,change=node.count?.(step,count,rate,{configuredInput,channels});
        rate=node.outputRate?.(step)??rate;
        if(!change)continue;
        count=change.samples;
        const {reframe,leading,trailing}=change.packets??{};
        if(reframe!==undefined)sections=count?[{samples:count,span:reframe}]:[];
        if(leading)sections.unshift({samples:leading.samples,span:leading.span});
        if(trailing)sections.push({samples:trailing.samples,span:trailing.span});
        if(sections.reduce((sum,section)=>sum+section.samples,0n)!==count)throw new AudioFilterError(`${step.name} packet sections disagree with its sample count`);
      }
      return Object.freeze(sections.map(section=>Object.freeze(section)));
    },
    outputPacketSamples(inputSpan:bigint):bigint {return steps.reduce((span,step,index)=>nodes[index]!.packetSpan?.(step)??span,inputSpan);},
    outputSampleRate(inputRate: number): number { return steps.reduce((rate,step,index)=>nodes[index]!.outputRate?.(step)??rate,inputRate); },
    requiresScalarRounding(input: AudioSampleFormat): boolean {
      let current = input, required = false;
      for (const target of targets(input)) { if (!isInteger(current) && isInteger(target)) required = true; current = target; }
      return required || (!isInteger(current) && isInteger(outputHint));
    },
    apply(frame:AudioFrameData,options:AudioConversionOptions):AudioFrameData {
      validateConstraints(frame);
      const stream=nodes.findIndex(node=>!node.apply);if(stream>=0)throw new AudioFilterError(`${steps[stream]!.name} requires stream processing`);
      return applyRange(frame,options,0,steps.length);
    },
    resolvedSampleFormat(input:AudioSampleFormat){return targets(input).at(-1)??input;},
    negotiatedSampleFormats(input:AudioSampleFormat):readonly AudioSampleFormat[] {
      if(!sampleFormats.includes(input))throw new AudioFilterError('Invalid format negotiation input');
      return Object.freeze(targets(input));
    },
    rateBoundary(input:AudioSampleFormat,inputRate:number,outputRate:number):AudioRateBoundary|null {
      if(!sampleFormats.includes(input)||![inputRate,outputRate].every(rate=>Number.isInteger(rate)&&rate>0&&rate<=2147483647))throw new AudioFilterError('Invalid rate negotiation input');
      const formats=targets(input);
      let rate=inputRate,lastRateStep=-1;
      for(const [index,step]of steps.entries()){const fixed=nodes[index]!.outputRate?.(step);if(fixed!==undefined){rate=fixed;lastRateStep=index;}}
      if(rate===outputRate)return null;
      const blocking=capabilities.findIndex(capability=>!capability.rateConversion);
      if(blocking>=0)throw new AudioFilterError(`${steps[blocking]!.name} with sample rate conversion is not implemented`);
      // Rate constraints propagate backwards through format-preserving filters.
      // Each fixed output rate (asetrate) stops that propagation.
      let beforeStep=steps.length,source=formats.at(-1)??input,target=outputHint;
      if(source===target){
        for(let index=steps.length-1;index>lastRateStep;index--){
          const previous=index===0?input:formats[index-1]!,next=formats[index]!;
          if(previous!==next){beforeStep=index;source=previous;target=next;break;}
        }
      }
      return Object.freeze({beforeStep,inputRate:rate,outputRate,inputFormat:source,outputFormat:target});
    },
    process(frames:AsyncIterable<AudioFrameData>,options:AudioFilterProcessOptions,insertion?:AudioStreamInsertion):AsyncIterable<AudioFrameData> {
      if(insertion&&(!Number.isInteger(insertion.beforeStep)||insertion.beforeStep<0||insertion.beforeStep>steps.length||typeof insertion.transform!=='function'))throw new AudioFilterError('Invalid stream insertion boundary');
      const snapshot=(format:AudioPadFormat|undefined)=>format?{...format,pts:format.pts?{value:format.pts.value,timeBase:{...format.pts.timeBase}}:null}:undefined;
      const boundary=insertion?{...insertion,...(insertion.outputFormat?{outputFormat:snapshot(insertion.outputFormat)!}:{})}:undefined;
      const initial=snapshot(options.inputFormat);
      if(initial)validateConstraints(initial,boundary);
      const checked:AsyncIterable<AudioFrameData>={async *[Symbol.asyncIterator](){let seen=false;for await(const frame of frames){seen=true;validateConstraints(frame,boundary);yield frame;}if(!seen&&!initial)throw new AudioFilterError(`${constrained!.name} constraints require a configured empty input format`);}};
      let stream=constrained?checked:frames,configured=initial;
      if(listedChain){
        // Negotiation refusals surface before any filter runs: up front for a configured input, otherwise at the first frame.
        if(initial)targets(initial.sampleFormat as AudioSampleFormat);
        const upstream=stream;
        stream={async *[Symbol.asyncIterator](){let first=true;for await(const frame of upstream){if(first){targets(frame.sampleFormat as AudioSampleFormat);first=false;}yield frame;}}};
      }
      for(const [index,step]of steps.entries()){
        if(boundary?.beforeStep===index){stream=boundary.transform(stream);configured=snapshot(boundary.outputFormat);}
        const node=nodes[index]!;
        if(node.stream)stream=node.stream(step,stream,options,configured,format=>targets(format,index)[0]!);
        else{
          const upstream=stream;
          stream=(async function*(){for await(const frame of upstream)yield applyRange(frame,options,index,index+1);})();
        }
        if(configured){
          const sampleFormat=targets(configured.sampleFormat as AudioSampleFormat,index)[0]??configured.sampleFormat;
          configured={...(node.configure?.(step,configured)??configured),sampleFormat};
        }
      }
      return boundary?.beforeStep===steps.length?boundary.transform(stream):stream;
    },
    capabilities,
    has(capability:keyof AudioFilterCapabilities):boolean {return capabilities.some(entry=>entry[capability]);},
    *reservations(input:Pick<AudioPadFormat,'sampleRate'|'channels'|'sampleFormat'>):Generator<AudioReservation,void,unknown> {
      const formats=targets(input.sampleFormat as AudioSampleFormat);let rate=input.sampleRate;
      for(const [index,step]of steps.entries()){
        const node=nodes[index]!;
        yield node.reserve?.(step,{sampleRate:rate,channels:input.channels,sampleFormat:index?formats[index-1]!:input.sampleFormat as AudioSampleFormat})??noReservation;
        rate=node.outputRate?.(step)??rate;
      }
    },
    plannedReservations(input:Pick<AudioPadFormat,'sampleRate'|'channels'|'sampleFormat'>,plan:AudioReservationPlan):readonly AudioPlannedReservation[] {
      const {samples,...options}=plan,formats=targets(input.sampleFormat as AudioSampleFormat),entries:AudioPlannedReservation[]=[];
      walkCounts(samples,input.sampleRate,options,(index,before,rate,change)=>{
        const step=steps[index]!,reservation=nodes[index]!.reserve?.(step,{sampleRate:rate!,channels:input.channels,sampleFormat:index?formats[index-1]!:input.sampleFormat as AudioSampleFormat,samples:before,configuredInput:options.configuredInput===true})??noReservation;
        entries.push(Object.freeze({step,reservation,countBuffers:Object.freeze([...(change?.buffers??[])])}));
      });
      return Object.freeze(entries);
    }
  });
}
