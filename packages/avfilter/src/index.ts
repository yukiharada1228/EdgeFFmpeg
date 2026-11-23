import {parseTimeDuration} from '@edge-ffmpeg/avutil';
import {padAudio,paddingDurationSamples} from './pad.js';
import type {AudioPadFormat} from './pad.js';
import { reframeAudio } from './reframe.js';
import {audioDelayPlan,audioDelayPacketSamples,delayAudio,parseAudioDelay} from './delay.js';
import type {AudioDelayStep} from './delay.js';
import { convertAudioFrame, resampledSampleCount } from '@edge-ffmpeg/swresample';
import type { AudioConversionOptions, AudioSampleFormat } from '@edge-ffmpeg/swresample';
import type { AudioFrameData } from '@edge-ffmpeg/avutil';
export class AudioFilterError extends Error {}
export type AudioFilterStep = { readonly name: 'anull' } | AudioDelayStep | {readonly name:'apad';readonly padSamples:bigint|null;readonly wholeSamples:bigint|null;readonly padDuration:bigint|null;readonly wholeDuration:bigint|null;readonly packetSamples:number} | { readonly name:'aformat';readonly sampleFormat:AudioSampleFormat|null;readonly sampleRate?:number;readonly channelLayout?:'mono'|'stereo' } | { readonly name: 'asetnsamples'; readonly samples: number; readonly pad: boolean } | { readonly name: 'asetrate'; readonly sampleRate: number } | { readonly name: 'volume'; readonly gain: number; readonly precision: 'fixed' | 'float' | 'double' };
export interface AudioRateBoundary {
  readonly beforeStep:number;
  readonly inputRate:number;
  readonly outputRate:number;
  readonly inputFormat:AudioSampleFormat;
  readonly outputFormat:AudioSampleFormat;
}
export type AudioCountRateBoundary = Pick<AudioRateBoundary, 'beforeStep' | 'inputRate' | 'outputRate'>;
export interface AudioCountOptions {readonly rateBoundary?:AudioCountRateBoundary;readonly configuredInput?:boolean;readonly channels?:number}
export interface AudioFilterProcessOptions extends AudioConversionOptions {readonly inputFormat?:AudioPadFormat}
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
}
export interface AudioFilterCountPlan {readonly samples:bigint;readonly buffers:readonly number[];readonly stages:readonly AudioFilterCountStage[]}
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
  rateBoundary(input:AudioSampleFormat,inputRate:number,outputRate:number):AudioRateBoundary|null;
  process(frames: AsyncIterable<AudioFrameData>, options: AudioFilterProcessOptions, insertion?:AudioStreamInsertion): AsyncIterable<AudioFrameData>;
  readonly maxBytesPerSample: number;
  readonly outputSampleFormat: 'flt' | 'dbl' | 'integer' | null;
  outputSampleRate(inputRate: number): number;
  requiresScalarRounding(input: AudioSampleFormat): boolean;
  apply(frame: AudioFrameData, options: AudioConversionOptions): AudioFrameData;
}
function gainValue(text: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:dB)?$/.test(text)) throw new AudioFilterError('Only constant numeric/dB volume expressions are implemented');
  const gain = text.endsWith('dB') ? 10 ** (Number(text.slice(0,-2)) / 20) : Number(text);
  if (!Number.isFinite(gain)) throw new AudioFilterError('Volume gain must be finite');
  return gain;
}
/** Compiles a bounded single-input audio chain. No expression evaluation or graph labels. */
export function compileAudioFilterChain(description: string, negotiation: { readonly outputSampleFormat?: AudioSampleFormat } = {}): AudioFilterChain {
  const outputHint = negotiation.outputSampleFormat ?? 's32';
  if (!['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'].includes(outputHint)) throw new AudioFilterError('Unsupported output sample format hint');
  if (!description || description.length > 4096) throw new AudioFilterError('Invalid audio filter description length');
  const tokens = description.split(',');
  if (tokens.length > 32) throw new AudioFilterError('Audio filter chain exceeds node limit');
  const steps: AudioFilterStep[] = [];
  let maxBytesPerSample = 0, outputSampleFormat: 'flt' | 'dbl' | 'integer' | null = null;
  for (const token of tokens) {
    const text = token.trim();
    if (text === 'anull') { steps.push(Object.freeze({ name: 'anull' })); continue; }
    if(text==='adelay'||text.startsWith('adelay=')){steps.push(parseAudioDelay(text));continue;}
    if(text==='apad'||text.startsWith('apad=')){
      let padSamples:bigint|null=null,wholeSamples:bigint|null=null,padDuration:bigint|null=null,wholeDuration:bigint|null=null,packetSamples=4096;
      if(text!=='apad')for(const [index,option]of text.slice(5).split(':').entries()){
        const parts=option.includes('=')?option.split('='):[index===0?'packet_size':'',option];
        if(parts.length!==2)throw new AudioFilterError('Only finite apad pad_len/whole_len and positive packet_size are implemented');
        const [name,value]=parts;
        if(name==='pad_dur'||name==='whole_dur'){let duration:bigint;try{duration=parseTimeDuration(value??'');}catch{throw new AudioFilterError('Invalid apad duration');}if(duration<0n)throw new AudioFilterError('Negative apad duration is not implemented');if(name==='pad_dur')padDuration=duration;else wholeDuration=duration;continue;}
        if(!/^\d+$/.test(value??''))throw new AudioFilterError('Invalid finite apad length');
        if(name==='pad_len'||name==='whole_len'){const count=BigInt(value!);if(count>(1n<<63n)-1n)throw new AudioFilterError('apad length exceeds signed64');if(name==='pad_len')padSamples=count;else wholeSamples=count;}
        else if(name==='packet_size'){packetSamples=Number(value);if(!Number.isInteger(packetSamples)||packetSamples<1||packetSamples>2147483647)throw new AudioFilterError('Invalid apad packet_size');}
        else throw new AudioFilterError('Unsupported apad option');
      }
      if([padSamples,wholeSamples,padDuration,wholeDuration].filter(value=>value!==null).length!==1)throw new AudioFilterError('apad requires exactly one finite length or duration');
      steps.push(Object.freeze({name:'apad',padSamples,wholeSamples,padDuration,wholeDuration,packetSamples}));continue;
    }
    if(text==='aformat'||text.startsWith('aformat=')){
      let sampleFormat:AudioSampleFormat|null=null,sampleRate:number|undefined,channelLayout:'mono'|'stereo'|undefined;
      if(text!=='aformat')for(const [index,option]of text.slice(8).split(':').entries()){
        const parts=option.includes('=')?option.split('='):[index===0?'sample_fmts':'',option];
        if(parts.length!==2)throw new AudioFilterError('Invalid singleton aformat constraint');
        const [name,value]=parts;
        if(name==='sample_rates'||name==='r'){
          if(!/^\d+$/.test(value??'')||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>2147483647)throw new AudioFilterError('aformat requires one supported sample rate');
          sampleRate=Number(value);
        }else if(name==='channel_layouts'||name==='cl'){
          if(value!=='mono'&&value!=='stereo')throw new AudioFilterError('aformat requires one supported channel layout');
          channelLayout=value;
        }else{
          if(!['sample_fmts','f'].includes(name??'')||!['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'].includes(value??''))throw new AudioFilterError('aformat currently requires one supported sample format');
          sampleFormat=value as AudioSampleFormat;
        }
      }
      steps.push(Object.freeze({name:'aformat',sampleFormat,...(sampleRate!==undefined?{sampleRate}:{}),...(channelLayout!==undefined?{channelLayout}:{})}));
      if(sampleFormat){maxBytesPerSample=Math.max(maxBytesPerSample,{u8:1,s16:2,s32:4,flt:4,dbl:8,u8p:1,s16p:2,s32p:4,fltp:4,dblp:8}[sampleFormat]);outputSampleFormat=sampleFormat.startsWith('flt')?'flt':sampleFormat.startsWith('dbl')?'dbl':'integer';}
      continue;
    }
    if (text === 'asetnsamples' || text.startsWith('asetnsamples=')) {
      let samples=1024,pad=true;
      if(text!=='asetnsamples')for(const [index,option]of text.slice(13).split(':').entries()){
        const parts=option.includes('=')?option.split('='):[index===0?'n':'',option];
        if(parts.length!==2)throw new AudioFilterError('Invalid asetnsamples option');
        const [name,value]=parts;
        if(['n','nb_out_samples'].includes(name??'')){
          if(!/^\d+$/.test(value??'')||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>2147483647)throw new AudioFilterError('Invalid asetnsamples sample count');
          samples=Number(value);
        }else if(['p','pad'].includes(name??'')){
          if(!['0','1','false','true'].includes(value??''))throw new AudioFilterError('Unsupported asetnsamples padding value');
          pad=value==='1'||value==='true';
        }else throw new AudioFilterError('Unsupported asetnsamples option');
      }
      steps.push(Object.freeze({name:'asetnsamples',samples,pad}));continue;
    }
    if (text === 'asetrate' || text.startsWith('asetrate=')) {
      let sampleRate = 44100;
      if (text !== 'asetrate') for (const [index,option] of text.slice(9).split(':').entries()) {
        const value = option.startsWith('sample_rate=') ? option.slice(12) : option.startsWith('r=') ? option.slice(2) : index === 0 && !option.includes('=') ? option : '';
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value)<1 || Number(value)>2147483647) throw new AudioFilterError('Only positive integer asetrate values are implemented');
        sampleRate = Number(value);
      }
      steps.push(Object.freeze({name:'asetrate',sampleRate}));
      continue;
    }
    if (text !== 'volume' && !text.startsWith('volume=')) throw new AudioFilterError(`Unsupported audio filter: ${text}`);
    let gain = 1, precision: 'fixed' | 'float' | 'double' = 'float';
    if (text !== 'volume') {
      for (const [index, option] of text.slice(7).split(':').entries()) {
        if (option.startsWith('precision=')) {
          const value = option.slice(10);
          if (value !== 'fixed' && value !== 'float' && value !== 'double') throw new AudioFilterError('Unsupported volume precision');
          precision = value;
        } else if (option.startsWith('volume=')) gain = gainValue(option.slice(7));
        else if (index === 0 && !option.includes('=')) gain = gainValue(option);
        else throw new AudioFilterError(`Unsupported volume option: ${option}`);
      }
    }
    if (precision === 'float' && !Number.isFinite(Math.fround(gain))) throw new AudioFilterError('Volume gain exceeds selected precision');
    if (precision === 'fixed' && gain > 65535) throw new AudioFilterError('Fixed volume gain exceeds the supported integer arithmetic profile');
    steps.push(Object.freeze({ name: 'volume', gain, precision }));
    maxBytesPerSample = Math.max(maxBytesPerSample, precision === 'double' ? 8 : 4);
    outputSampleFormat = precision === 'fixed' ? 'integer' : precision === 'double' ? 'dbl' : 'flt';
  }
  const packed=(format:AudioSampleFormat):AudioSampleFormat=>format.endsWith('p')?format.slice(0,-1) as AudioSampleFormat:format;
  const paddingCount=(step:Extract<AudioFilterStep,{name:'apad'}>,count:bigint,rate?:number,configured=false)=>{
    if(count===0n&&!configured)return 0n;
    if(step.padDuration!==null)return paddingDurationSamples(step.padDuration,rate!);
    const minimum=step.wholeDuration!==null?paddingDurationSamples(step.wholeDuration,rate!):step.wholeSamples;
    return step.padSamples??(minimum!>count?minimum!-count:0n);
  };
  const planCounts=(inputSamples:bigint,inputRate?:number,options:AudioCountOptions={})=>{
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
      const step=steps[index],before=count,rateBefore=rate;
      if(step?.name==='asetrate')rate=step.sampleRate;
      else if(step?.name==='asetnsamples'){buffers.push(step.samples);if(step.pad)count=((count+BigInt(step.samples)-1n)/BigInt(step.samples))*BigInt(step.samples);}
      else if(step?.name==='apad'){const added=paddingCount(step,count,rate,options.configuredInput);if(added>0n)buffers.push(Number(added<BigInt(step.packetSamples)?added:BigInt(step.packetSamples)));count+=added;}
      else if(step?.name==='adelay'){const {padding,flush}=audioDelayPlan(step,rate,options.channels),chunk=BigInt(audioDelayPacketSamples);if(padding>0n)buffers.push(Number(padding<chunk?padding:chunk));if(flush>0n)buffers.push(Number(flush));count+=padding+flush;}
      if(step)stages.push(Object.freeze({step,inputSamples:before,outputSamples:count,inputRate:rateBefore,outputRate:rate}));
    }
    return Object.freeze({samples:count,buffers:Object.freeze(buffers),stages:Object.freeze(stages)});
  };
  const isInteger = (format: AudioSampleFormat) => ['u8','s16','s32'].includes(packed(format));
  const transparent=(step:AudioFilterStep)=>['anull','asetrate','asetnsamples','apad','adelay'].includes(step.name)||step.name==='aformat'&&step.sampleFormat===null||step.name==='volume'&&step.precision==='fixed';
  const delayedComponent=(index:number)=>{let before=index-1;while(before>=0&&transparent(steps[before]!)&&steps[before]!.name!=='volume')if(steps[before--]!.name==='adelay')return true;for(let after=index+1;after<steps.length&&transparent(steps[after]!);after++)if(steps[after]!.name==='adelay')return true;return false;};
  const targets = (input: AudioSampleFormat, start=0): AudioSampleFormat[] => {
    let current = input;
    return steps.slice(start).map((step,localIndex) => {
      const index=start+localIndex;
      if(step.name==='aformat'){current=step.sampleFormat??current;return current;}
      if(step.name==='adelay'){current=`${packed(current)}p` as AudioSampleFormat;return current;}
      if (step.name !== 'volume') return current;
      if (step.precision !== 'fixed') current = step.precision === 'double' ? 'dbl' : 'flt';
      else if (!isInteger(current)&&delayedComponent(index)) {
        // Planar-only adelay merged into the fixed-volume format set keeps the encoder format out; native then picks s32p from floating input.
        const constraint=steps.slice(index+1).find(next=>!transparent(next));
        if(constraint?.name==='aformat'&&isInteger(constraint.sampleFormat!))throw new AudioFilterError('adelay with fixed volume and an integer sample format constraint on floating input requires unimplemented format negotiation');
        current='s32';
      }
      else if (!isInteger(current)) {
        const nextConstraint=steps.slice(index+1).find(next=>next.name==='volume'&&next.precision!=='fixed'||next.name==='aformat'&&next.sampleFormat!==null);
        const laterFloat=nextConstraint?.name==='volume'||nextConstraint?.name==='aformat'&&!isInteger(nextConstraint.sampleFormat!);
        const output=nextConstraint?.name==='aformat'?nextConstraint.sampleFormat!:outputHint;
        current = !laterFloat && isInteger(output) ? packed(output) : 's32';
      }
      if(step.precision==='fixed')current=packed(current);
      return current;
    });
  };
  const hasConstraints=steps.some(step=>step.name==='aformat'&&(step.sampleRate!==undefined||step.channelLayout!==undefined));
  const validateConstraints=(initial:Pick<AudioPadFormat,'sampleRate'|'channels'|'channelLayout'>,insertion?:AudioStreamInsertion)=>{
    let rate=initial.sampleRate,channels=initial.channels,layout=initial.channelLayout;
    for(const [index,step]of steps.entries()){
      if(insertion?.beforeStep===index&&insertion.outputFormat){rate=insertion.outputFormat.sampleRate;channels=insertion.outputFormat.channels;layout=insertion.outputFormat.channelLayout;}
      if(step.name==='asetrate')rate=step.sampleRate;
      if(step.name==='aformat'){
        if(step.sampleRate!==undefined&&step.sampleRate!==rate)throw new AudioFilterError('aformat sample rate constraint requires an implicit conversion');
        if(step.channelLayout!==undefined&&(step.channelLayout!==layout||channels!==(step.channelLayout==='mono'?1:2)))throw new AudioFilterError('aformat channel layout constraint requires an implicit conversion');
      }
    }
  };
  const applyRange=(frame:AudioFrameData,options:AudioConversionOptions,start:number,end:number):AudioFrameData=>{
      options.signal?.throwIfAborted();
      const widths: Record<string,number> = { u8:1,s16:2,s32:4,flt:4,dbl:8 };
      const planar=frame.sampleFormat.endsWith('p'),base=planar?frame.sampleFormat.slice(0,-1):frame.sampleFormat;
      const total=frame.samples*frame.channels*(widths[base]??0);
      if(!Object.hasOwn(widths,base)||!Number.isSafeInteger(frame.samples)||frame.samples<=0||!Number.isSafeInteger(frame.channels)||frame.channels<=0||!Number.isSafeInteger(frame.sampleRate)||frame.sampleRate<=0||!Number.isSafeInteger(total)||frame.planes.length!==(planar?frame.channels:1))throw new AudioFilterError('Invalid audio filter frame');
      if(!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<=0||total>options.maxFrameBytes)throw new AudioFilterError('Audio filter frame exceeds allocation limit');
      for(let channel=0;channel<frame.planes.length;channel++){options.signal?.throwIfAborted();const plane=frame.planes[channel];if(!(plane instanceof Uint8Array)||plane.length!==frame.samples*(planar?1:frame.channels)*widths[base]!)throw new AudioFilterError('Invalid audio filter plane');}
      let current = frame;
      const formats = targets(frame.sampleFormat as AudioSampleFormat,start);
      for (const [index,step] of steps.slice(start,end).entries()) {
        options.signal?.throwIfAborted();
        if (step.name === 'anull') continue;
        if(step.name==='aformat'){if(step.sampleRate!==undefined&&step.sampleRate!==current.sampleRate)throw new AudioFilterError('aformat sample rate constraint requires an implicit conversion');if(step.channelLayout!==undefined&&(step.channelLayout!==current.channelLayout||current.channels!==(step.channelLayout==='mono'?1:2)))throw new AudioFilterError('aformat channel layout constraint requires an implicit conversion');if(step.sampleFormat)current=convertAudioFrame(current,step.sampleFormat,options);continue;}
        if(step.name==='apad'||step.name==='adelay')throw new AudioFilterError(`${step.name} requires stream processing`);
        if (step.name === 'asetnsamples') throw new AudioFilterError('asetnsamples requires stream processing');
        if (step.name === 'asetrate') {
          let pts = current.pts;
          if (pts !== null) {
            const {num,den} = pts.timeBase;
            const position = pts.value * num * BigInt(current.sampleRate);
            if (num<=0n || den<=0n || position % den !== 0n) throw new AudioFilterError('asetrate requires sample-aligned timestamps');
            pts = {value:position / den,timeBase:{num:1n,den:BigInt(step.sampleRate)}};
          }
          // Reinterpret metadata; shared planes keep the original ownership claim.
          current = {...current,sampleRate:step.sampleRate,pts};
          continue;
        }
        const target = formats[index]!;
        const converted = convertAudioFrame(current, target, options);
        const data = converted.planes[0]!, view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const width = widths[target]!;
        if (step.precision === 'fixed') {
          const quantized = BigInt(Math.floor(Math.max(0,step.gain) * 256 + 0.5));
          const low = target === 'u8' ? -128n : target === 's16' ? -32768n : -2147483648n;
          const high = target === 'u8' ? 127n : target === 's16' ? 32767n : 2147483647n;
          for (let offset = 0; offset < data.length; offset += width) {
            if ((offset & 16383) === 0) options.signal?.throwIfAborted();
            const value = target === 'u8' ? view.getUint8(offset) - 128 : target === 's16' ? view.getInt16(offset,true) : view.getInt32(offset,true);
            const scaled = (BigInt(value) * quantized + 128n) >> 8n;
            const clipped = Number(scaled < low ? low : scaled > high ? high : scaled);
            if (target === 'u8') view.setUint8(offset,clipped + 128);
            else if (target === 's16') view.setInt16(offset,clipped,true);
            else view.setInt32(offset,clipped,true);
          }
          current = converted;
          continue;
        }
        const gain = step.precision === 'double' ? step.gain : Math.fround(step.gain);
        if (!Number.isFinite(gain)) throw new AudioFilterError('Volume gain exceeds selected precision');
        for (let offset = 0; offset < data.length; offset += width) {
          if ((offset & 16383) === 0) options.signal?.throwIfAborted();
          const value = width === 8 ? view.getFloat64(offset,true) : view.getFloat32(offset,true);
          if (!Number.isFinite(value)) throw new AudioFilterError('Non-finite volume input is not yet supported');
          if (width === 8) view.setFloat64(offset,value * gain,true);
          else view.setFloat32(offset,value * gain,true);
        }
        current = converted;
      }
      return current;
  };
  return Object.freeze({
    steps: Object.freeze(steps), maxBytesPerSample, outputSampleFormat,
    validateInputFormat:validateConstraints,
    reframes:steps.some(step=>step.name==='asetnsamples'||step.name==='apad'||step.name==='adelay'),
    maxBufferedSamples:Math.max(0,...steps.map(step=>step.name==='asetnsamples'?step.samples:step.name==='apad'?Number((step.padSamples??step.wholeSamples??BigInt(step.packetSamples))<BigInt(step.packetSamples)?(step.padSamples??step.wholeSamples??BigInt(step.packetSamples)):BigInt(step.packetSamples)):0)),
    planSamples:planCounts,
    outputSamples(inputSamples:bigint,inputRate?:number,options?:AudioCountOptions):bigint {return planCounts(inputSamples,inputRate,options).samples;},
    requiredBufferSamples(inputSamples:bigint,inputRate?:number,options?:AudioCountOptions){return planCounts(inputSamples,inputRate,options).buffers;},
    packetSections(inputSamples:bigint,inputSpan:bigint,inputRate?:number,configuredInput?:boolean,channels?:number){
      if(inputSamples<0n||inputSpan<1n)throw new AudioFilterError('Invalid packet section input');
      let count=inputSamples,rate=inputRate,sections=count?[{samples:count,span:inputSpan}]:[];
      for(const step of steps){
        if(step.name==='asetrate')rate=step.sampleRate;
        else if(step.name==='asetnsamples'){if(step.pad)count=((count+BigInt(step.samples)-1n)/BigInt(step.samples))*BigInt(step.samples);sections=count?[{samples:count,span:BigInt(step.samples)}]:[];}
        else if(step.name==='apad'){const added=paddingCount(step,count,rate,configuredInput);if(added>0n){sections.push({samples:added,span:BigInt(step.packetSamples)});count+=added;}}
        else if(step.name==='adelay'){const {padding,flush}=audioDelayPlan(step,rate,channels),span=BigInt(audioDelayPacketSamples);if(padding>0n)sections.unshift({samples:padding,span});if(flush>0n)sections.push({samples:flush,span});count+=padding+flush;}
      }
      return Object.freeze(sections.map(section=>Object.freeze(section)));
    },
    outputPacketSamples(inputSpan:bigint):bigint {return steps.reduce((span,step)=>step.name==='asetnsamples'?BigInt(step.samples):span,inputSpan);},
    outputSampleRate(inputRate: number): number { return steps.reduce((rate,step)=>step.name === 'asetrate' ? step.sampleRate : rate,inputRate); },
    requiresScalarRounding(input: AudioSampleFormat): boolean {
      let current = input, required = false;
      for (const target of targets(input)) { if (!isInteger(current) && isInteger(target)) required = true; current = target; }
      return required || (!isInteger(current) && isInteger(outputHint));
    },
    apply(frame:AudioFrameData,options:AudioConversionOptions):AudioFrameData { validateConstraints(frame);if(steps.some(step=>step.name==='asetnsamples'||step.name==='apad'||step.name==='adelay'))throw new AudioFilterError('asetnsamples requires stream processing');return applyRange(frame,options,0,steps.length); },
    resolvedSampleFormat(input:AudioSampleFormat){return targets(input).at(-1)??input;},
    rateBoundary(input:AudioSampleFormat,inputRate:number,outputRate:number):AudioRateBoundary|null {
      if(!['u8','s16','s32','flt','dbl','u8p','s16p','s32p','fltp','dblp'].includes(input)||![inputRate,outputRate].every(rate=>Number.isInteger(rate)&&rate>0&&rate<=2147483647))throw new AudioFilterError('Invalid rate negotiation input');
      const formats=targets(input);
      let rate=inputRate,lastRateStep=-1;
      for(const [index,step]of steps.entries())if(step.name==='asetrate'){rate=step.sampleRate;lastRateStep=index;}
      if(rate===outputRate)return null;
      if(steps.some(step=>step.name==='adelay'))throw new AudioFilterError('adelay with sample rate conversion is not implemented');
      // Rate constraints propagate backwards through format-preserving filters.
      // Each asetrate fixes its output rate and therefore stops that propagation.
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
      const checked:AsyncIterable<AudioFrameData>={async *[Symbol.asyncIterator](){let seen=false;for await(const frame of frames){seen=true;validateConstraints(frame,boundary);yield frame;}if(!seen&&!initial)throw new AudioFilterError('aformat constraints require a configured empty input format');}};
      let stream=hasConstraints?checked:frames,configured=initial;
      for(const [index,step]of steps.entries()){
        if(boundary?.beforeStep===index){stream=boundary.transform(stream);configured=snapshot(boundary.outputFormat);}
        if(step.name==='apad')stream=padAudio(stream,{...options,...(configured?{emptyInput:configured}:{}),...(step.padSamples!==null?{padSamples:step.padSamples}:step.wholeSamples!==null?{wholeSamples:step.wholeSamples}:step.padDuration!==null?{padDurationMicros:step.padDuration}:{wholeDurationMicros:step.wholeDuration!}),packetSamples:step.packetSamples});
        else if(step.name==='adelay')stream=delayAudio(stream,step,{...options,...(configured?{emptyInput:configured}:{})});
        else if(step.name==='asetnsamples')stream=reframeAudio(stream,step.samples,step.pad,options);
        else{
          const upstream=stream;
          stream=(async function*(){for await(const frame of upstream)yield applyRange(frame,options,index,index+1);})();
        }
        if(configured){
          const sampleFormat=targets(configured.sampleFormat as AudioSampleFormat,index)[0]??configured.sampleFormat;
          let pts=configured.pts;
          if(step.name==='asetrate'&&pts){const position=pts.value*pts.timeBase.num*BigInt(configured.sampleRate);if(pts.timeBase.num<=0n||pts.timeBase.den<=0n||position%pts.timeBase.den!==0n)throw new AudioFilterError('asetrate requires sample-aligned timestamps');pts={value:position/pts.timeBase.den,timeBase:{num:1n,den:BigInt(step.sampleRate)}};}
          configured={...configured,sampleFormat,...(step.name==='asetrate'?{sampleRate:step.sampleRate}:{}),pts};
        }
      }
      return boundary?.beforeStep===steps.length?boundary.transform(stream):stream;
    }
  });
}
export { reframeAudio, AudioReframeError } from './reframe.js';
export { padAudio, AudioPadError } from './pad.js';
export {delayAudio,parseAudioDelay,audioDelaySamples,audioDelayPlan,AudioDelayError} from './delay.js';
export type {AudioDelayStep,AudioDelayValue,AudioDelayOptions} from './delay.js';
export type { AudioPadOptions, AudioPadFormat } from './pad.js';

export {compileVideoFilterChain,VideoFilterError} from './video.js';
export type {VideoFilterPlan,VideoFilterStep,VideoFilterNegotiation,VideoFilterStage} from './video.js';

export {flipVideoFrame,VideoFlipError} from './video-flip.js';
export type {VideoFlipOptions} from './video-flip.js';

export type {VideoGraphNode} from './video-graph.js';

export {transposeVideoFrame,VideoTransposeError} from './video-transpose.js';
export type {VideoTransposeOptions} from './video-transpose.js';

export {compileFrameGraph as compileVideoFilterGraph} from './video-filter-graph.js';
export type {GraphFrameBudget as VideoGraphFrameBudget} from './video-filter-graph.js';
export {parseFilterTopology,filterTopologyOrder,FilterTopologyError} from './filter-topology.js';
export type {FilterTopology,FilterPads,FilterToken,FilterMediaType,TopologyNode,TopologyEndpoint,TopologyEdge,ExternalPad} from './filter-topology.js';

export {stackVideoFrames,VideoStackError} from './video-stack.js';
export type {VideoStackDirection,VideoStackOptions} from './video-stack.js';

export {compileMultiFrameGraph as compileMultiInputVideoFilterGraph} from './video-filter-graph.js';
export type {Geometry as VideoGraphGeometry} from './video-graph-formats.js';
export {synchronizeFrames,synchronizationTimeBase} from './frame-sync.js';
export type {SynchronizationSource,SynchronizationOptions,SynchronizationLease} from './frame-sync.js';
export {createReplayVideoExecution} from './video-stream.js';
export type {ReplayVideoSource,ReplayVideoBudget} from './video-stream.js';

export {createVideoPtsTransform,setptsVariables} from './setpts/state.js';
export {createSetptsStream} from './setpts/stream.js';
export type {FrameEvent as TimedVideoFrameEvent,SourceEnd as TimedVideoSourceEnd,SourceEvent as TimedVideoSourceEvent,Completion as TimedVideoCompletion,OutputEnd as TimedVideoOutputEnd,OutputEvent as TimedVideoOutputEvent} from './setpts/stream.js';

export {createTimedSynchronization} from './timed-sync/lifecycle.js';
export type {TimedSynchronizationOptions,TimedSynchronizationOutput,TimedSynchronizationSource,Completion as TimedSynchronizationCompletion} from './timed-sync/lifecycle.js';
export type {Event as TimedSynchronizationInput} from './timed-sync/stream.js';

export {createTimedSynchronizationStep} from './timed-sync/step.js';

export {createFilterEnableTimeline} from './enable-timeline.js';
export type {FilterTimelineFrame,FilterTimelineOptions} from './enable-timeline.js';

export {createFilterCommandQueue} from './command-queue.js';
export type {QueuedFilterCommand,FilterCommandInput,FilterCommandQueueOptions} from './command-queue.js';

export {createScaleExpressionState,scaleExpressionVariables} from './scale-expression.js';
export type {ScaleExpressionOptions} from './scale-expression.js';

export type {FilterLogEntry} from './activation/filter-log.js';
export {createActorMultiInputDriver} from './activation/actor-multi-driver.js';
export type {ActorSourceEvent} from './activation/actor-multi-driver.js';
export type {ActorSinkConsumer} from './activation/actor-multi-driver.js';
export {resolveVideoFilter} from './activation/resolver.js';
export {planTimedVideoGraph} from './activation/plan.js';
export type {Geometry} from './activation/formats.js';
export type {LinkLease} from './activation/link.js';

export type {Clock as TimedVideoGraphClock,SourceDescription as TimedVideoGraphSource} from './activation/plan.js';
export type {GraphVideoStep as TimedVideoGraphStep} from './activation/resolver.js';
export type {RegisteredVideoNode,RegisteredVideoLink} from './activation/formats.js';
export type {NegotiatedTopology as VideoNegotiatedTopology} from './video-graph-formats.js';
export {createAudioReframeState,serializeAudioReframeCheckpoint,deserializeAudioReframeCheckpoint} from './reframe-state.js';
export type {AudioReframeState,AudioReframeCheckpoint,AudioReframeFormat} from './reframe-state.js';
export {createAudioPadState,serializeAudioPadCheckpoint,deserializeAudioPadCheckpoint} from './pad-checkpoint.js';
export type {AudioPadState,AudioPadCheckpoint,AudioPadCheckpointDescriptor,AudioPadStateFormat,AudioPadMode} from './pad-checkpoint.js';
export {paddingDurationSamples} from './pad-checkpoint.js';
