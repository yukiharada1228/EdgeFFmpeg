import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioConversionOptions,AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter} from './descriptor.js';
/** AV_OPT_TYPE_DOUBLE option values as parsed (before init()'s scaling); shape is always triangular. */
export interface AudioFlangerStep {readonly name:'flanger';readonly delay:number;readonly depth:number;readonly regen:number;readonly width:number;readonly speed:number;readonly phase:number;readonly interp:'linear'|'quadratic'}
type NumberKey='delay'|'depth'|'regen'|'width'|'speed'|'phase';
type Key=NumberKey|'shape'|'interp';
/** af_flanger.c option table in shorthand order (AV_OPT_TYPE_CONST entries are not positional). */
const keys:readonly Key[]=['delay','depth','regen','width','speed','shape','phase','interp'];
const ranges:Readonly<Record<NumberKey,readonly [number,number,number]>>={delay:[0,0,30],depth:[2,0,10],regen:[0,-95,95],width:[71,0,100],speed:[0.5,0.1,10],phase:[25,0,100]};
/** Largest LFO table whose uint32 `4 * point` in ff_generate_wave_table cannot wrap. */
export const flangerMaxLfoLength=2**30;
function invalid(message:string):never{throw new AudioFilterError(message);}
/** Parses `flanger[=options]` positionally or by name. shape must be triangular: the sinusoidal default needs libm sin(). */
export function parseFlanger(text:string):AudioFlangerStep {
  if(text!=='flanger'&&!text.startsWith('flanger='))invalid(`Unsupported audio filter: ${text}`);
  const values:Record<NumberKey,number>={delay:0,depth:2,regen:0,width:71,speed:0.5,phase:25};let shape='sinusoidal',interp:'linear'|'quadratic'='linear',named=false;
  if(text!=='flanger')for(const [index,option]of text.slice(8).split(':').entries()){
    const equals=option.indexOf('=');
    if(equals<0&&named)invalid(`No flanger option name near '${option}'`);
    if(equals<0&&index>=keys.length)invalid(`Too many flanger positional options: ${option}`);
    const key=equals<0?keys[index]!:option.slice(0,equals),value=equals<0?option:option.slice(equals+1);
    if(equals>=0)named=true;
    if(key==='enable')invalid('flanger timeline enable is not implemented');
    if(!(keys as readonly string[]).includes(key))invalid(`Unsupported flanger option: ${key}`);
    if(key==='shape'){
      if(value==='triangular'||value==='t')shape='triangular';else if(value==='sinusoidal'||value==='s')shape='sinusoidal';else invalid(`Unsupported flanger shape value: ${value}`);
      continue;
    }
    if(key==='interp'){if(value!=='linear'&&value!=='quadratic')invalid(`Unsupported flanger interp value: ${value}`);interp=value;continue;}
    if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))invalid(`Only constant numeric flanger ${key} values are implemented: ${value}`);
    const number=Number(value),[,min,max]=ranges[key as NumberKey];
    if(!(number>=min&&number<=max))invalid(`flanger ${key} ${value} is out of range [${min} - ${max}]`);
    values[key as NumberKey]=number;
  }
  if(shape!=='triangular')invalid('flanger shape sinusoidal requires unimplemented libm arithmetic');
  return Object.freeze({name:'flanger',...values,interp});
}
/** init() and config_input() values at a sample rate. */
export interface FlangerPlan {readonly feedbackGain:number;readonly delayGain:number;readonly inGain:number;readonly channelPhase:number;readonly delayMin:number;readonly delayDepth:number;readonly maxSamples:number;readonly lfoLength:number}
const roundEven=(value:number)=>{const low=Math.floor(value),fraction=value-low;return fraction<0.5?low:fraction>0.5?low+1:low%2===0?low:low+1;};
/** init(): /100 and /1000 scaling, in_gain = 1/(1+width), delay_gain /= 1+width, *= 1-|regen|; config_input(): (int) max_samples and lfo_length. */
export function flangerPlan(step:AudioFlangerStep,sampleRate:number):FlangerPlan {
  if(!Number.isSafeInteger(sampleRate)||sampleRate<1||sampleRate>2147483647)invalid('flanger requires a valid sample rate');
  const feedbackGain=step.regen/100,channelPhase=step.phase/100,delayMin=step.delay/1000,delayDepth=step.depth/1000;let delayGain=step.width/100;
  const inGain=1/(1+delayGain);delayGain/=1+delayGain;delayGain*=1-Math.abs(feedbackGain);
  const maxSamples=Math.trunc((delayMin+delayDepth)*sampleRate+2.5),length=sampleRate/step.speed;
  if(!(length<flangerMaxLfoLength))invalid('flanger LFO length exceeds the implemented range');
  const lfoLength=Math.trunc(length);if(lfoLength<1)invalid(`flanger speed ${step.speed} leaves no LFO samples at ${sampleRate} Hz`);
  return Object.freeze({feedbackGain,delayGain,inGain,channelPhase,delayMin,delayDepth,maxSamples,lfoLength});
}
/** ff_generate_wave_table(WAVE_TRI, AV_SAMPLE_FMT_FLT, lfo, lfo_length, rint(delay_min * sample_rate), max_samples - 2., 3 * M_PI_2). */
export function flangerLfo(plan:FlangerPlan,sampleRate:number):Float32Array {
  const size=plan.lfoLength,min=roundEven(plan.delayMin*sampleRate),max=plan.maxSamples-2,table=new Float32Array(size),offset=Math.trunc(3*(Math.PI/2)/Math.PI/2*size+0.5);
  for(let i=0;i<size;i++){
    const point=(i+offset)%size;let d=point*2/size;
    switch(Math.trunc(4*point/size)){case 0:d=d+0.5;break;case 1:case 2:d=1.5-d;break;case 3:d=d-1.5;break;}
    table[i]=d*(max-min)+min;
  }
  return table;
}
/** Per-channel ring of max_samples doubles, delay_last per channel and the float LFO table. */
export const flangerStateBytes=(plan:FlangerPlan,channels:number)=>BigInt(plan.maxSamples)*BigInt(channels)*8n+BigInt(channels)*8n+BigInt(plan.lfoLength)*4n;
/** filter_frame state checks: channel_phase plus lfo_pos stays below channels*lfo_length, which must fit an int. */
function check(step:AudioFlangerStep,sampleRate:number,channels:number):FlangerPlan {
  const plan=flangerPlan(step,sampleRate);
  if(!Number.isSafeInteger(channels)||channels<1||channels*plan.lfoLength>2147483647)invalid('flanger channel phase exceeds int range');
  return plan;
}
/** filter_frame in pinned dblp: one owned output frame per input frame, same sample count and timestamp. */
async function* flange(step:AudioFlangerStep,frames:AsyncIterable<AudioFrameData>,options:AudioConversionOptions,negotiated:(input:AudioSampleFormat)=>AudioSampleFormat):AsyncIterable<AudioFrameData> {
  const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1)invalid('Invalid flanger allocation limit');
  let format:{sampleRate:number;channels:number;channelLayout:string}|null=null,plan:FlangerPlan|null=null,lfo:Float32Array=new Float32Array(0),rings:Float64Array[]=[],last=new Float64Array(0),phases:number[]=[],position=0,lfoPosition=0;
  for await(const frame of frames){
    signal?.throwIfAborted();
    if(!Number.isSafeInteger(frame.samples)||frame.samples<0||!Number.isSafeInteger(frame.channels)||frame.channels<1)invalid('Invalid flanger input frame');
    if(!format){
      plan=check(step,frame.sampleRate,frame.channels);
      if(flangerStateBytes(plan,frame.channels)>BigInt(maxFrameBytes))invalid('flanger state exceeds allocation limit');
      lfo=flangerLfo(plan,frame.sampleRate);rings=Array.from({length:frame.channels},()=>new Float64Array(plan!.maxSamples));last=new Float64Array(frame.channels);
      phases=Array.from({length:frame.channels},(_,chan)=>Math.trunc(chan*plan!.lfoLength*plan!.channelPhase+.5));
      format={sampleRate:frame.sampleRate,channels:frame.channels,channelLayout:frame.channelLayout};
    }else if(frame.sampleRate!==format.sampleRate||frame.channels!==format.channels||frame.channelLayout!==format.channelLayout)invalid('flanger requires a stable input format');
    const target=negotiated(frame.sampleFormat as AudioSampleFormat);if(target!=='dblp')invalid(`flanger cannot work in ${target}`);
    const bytes=frame.samples*8;if(bytes*frame.channels>maxFrameBytes)invalid('flanger frame exceeds allocation limit');
    const input=convertAudioFrame(frame,'dblp',{maxFrameBytes,...(signal?{signal}:{})}),data=new Uint8Array(bytes*frame.channels),channels=frame.channels;
    const sources=input.planes.map(plane=>new Float64Array(plane.buffer.slice(plane.byteOffset,plane.byteOffset+bytes))),outputs=Array.from({length:channels},(_,c)=>new Float64Array(data.buffer,c*bytes,frame.samples));
    const {maxSamples,lfoLength,feedbackGain,inGain,delayGain}=plan!,quadratic=step.interp==='quadratic';
    for(let i=0;i<frame.samples;i++){
      if((i&4095)===0)signal?.throwIfAborted();
      position=(position+maxSamples-1)%maxSamples;
      for(let chan=0;chan<channels;chan++){
        const delay=lfo[(lfoPosition+phases[chan]!)%lfoLength]!;let whole=Math.trunc(delay);const fraction=delay-whole,ring=rings[chan]!,value=sources[chan]![i]!;
        ring[position]=value+last[chan]!*feedbackGain;
        const d0=ring[(position+whole++)%maxSamples]!;let d1=ring[(position+whole++)%maxSamples]!,delayed:number;
        if(!quadratic)delayed=d0+(d1-d0)*fraction;
        else{let d2=ring[(position+whole++)%maxSamples]!;d2-=d0;d1-=d0;const a=d2*.5-d1,b=d1*2-d2*.5;delayed=d0+(a*fraction+b)*fraction;}
        last[chan]=delayed;outputs[chan]![i]=value*inGain+delayed*delayGain;
      }
      lfoPosition=(lfoPosition+1)%lfoLength;
    }
    yield {...frame,sampleFormat:'dblp',planes:Array.from({length:channels},(_,c)=>data.subarray(c*bytes,(c+1)*bytes))};
  }
}
/** flanger (libavfilter/af_flanger.c) with the triangular LFO only: a swept, regenerating delay line in pinned dblp. */
export const flanger=defineAudioFilter<AudioFlangerStep>({
  name:'flanger',
  examples:['flanger=shape=t','flanger=delay=5:depth=10:regen=40:width=100:speed=10:shape=triangular:phase=100:interp=quadratic','flanger=30:0:-95:0:0.1:t:0:linear'],
  parse:parseFlanger,
  capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['dblp'],
  // config_input: a zero-length LFO table would divide by zero in filter_frame.
  constraint:step=>format=>{check(step,format.sampleRate,format.channels);},
  stream:(step,frames,options,_configured,negotiated)=>flange(step,frames,options,negotiated),
  // One output frame plus the rings, delay_last and the LFO table.
  reserve(step,{sampleRate,channels}){
    let bytes=0n;try{bytes=flangerStateBytes(check(step,sampleRate,channels),channels);}catch{/* the constraint refuses the rate */}
    return {frames:1,buffers:[],stateBytes:bytes};
  }
});
