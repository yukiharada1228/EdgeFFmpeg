import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter} from './descriptor.js';
/** Parsed haas options (af_haas.c AVOptions, native defaults and ranges). */
export interface AudioHaasStep {
  readonly name:'haas';
  readonly levelIn:number;readonly levelOut:number;readonly sideGain:number;
  /** middle_source: 0 left, 1 right, 2 mid (L+R)/2, 3 side (L-R)/2. */
  readonly middleSource:0|1|2|3;readonly middlePhase:boolean;
  readonly leftDelay:number;readonly leftBalance:number;readonly leftGain:number;readonly leftPhase:boolean;
  readonly rightDelay:number;readonly rightBalance:number;readonly rightGain:number;readonly rightPhase:boolean;
}
type Key = Exclude<keyof AudioHaasStep,'name'>;
const MAX_HAAS_DELAY=40,gain:[number,number]=[0.015625,64];
/** AVOption declaration order: positional values fill these, as libavfilter's shorthand does. */
const options:readonly [string,Key,'double'|'source'|'bool',number,number][]=[
  ['level_in','levelIn','double',...gain],['level_out','levelOut','double',...gain],['side_gain','sideGain','double',...gain],['middle_source','middleSource','source',0,3],['middle_phase','middlePhase','bool',0,1],
  ['left_delay','leftDelay','double',0,MAX_HAAS_DELAY],['left_balance','leftBalance','double',-1,1],['left_gain','leftGain','double',...gain],['left_phase','leftPhase','bool',0,1],
  ['right_delay','rightDelay','double',0,MAX_HAAS_DELAY],['right_balance','rightBalance','double',-1,1],['right_gain','rightGain','double',...gain],['right_phase','rightPhase','bool',0,1]
];
const defaults:AudioHaasStep=Object.freeze({name:'haas',levelIn:1,levelOut:1,sideGain:1,middleSource:2,middlePhase:false,leftDelay:2.05,leftBalance:-1,leftGain:1,leftPhase:false,rightDelay:2.12,rightBalance:1,rightGain:1,rightPhase:true});
const sources:Readonly<Record<string,number>>={left:0,right:1,mid:2,side:3};
function value(name:string,kind:'double'|'source'|'bool',min:number,max:number,text:string):number|boolean {
  let parsed:number;
  if(kind==='bool'){
    // set_string_bool: case-insensitive names, else a whole base-10 integer; 'auto' is -1, outside [0,1].
    const lower=text.toLowerCase();
    if(['true','y','yes','enable','enabled','on'].includes(lower))return true;
    if(['false','n','no','disable','disabled','off'].includes(lower))return false;
    if(lower==='auto'||/^[+-]?\d+$/.test(text)){parsed=lower==='auto'?-1:Number(text);if(parsed<min||parsed>max)throw new AudioFilterError(`Unable to parse haas option ${name} value ${text} as boolean`);return parsed===1;}
    throw new AudioFilterError(`Only 0, 1 and boolean names are implemented for haas option ${name}`);
  }
  if(kind==='source'&&Object.hasOwn(sources,text))return sources[text]!;
  if(kind==='source'?!/^[+-]?\d+$/.test(text):!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))throw new AudioFilterError(kind==='source'?`Only left, right, mid, side or an integer are implemented for haas option ${name}`:`Only constant decimal values are implemented for haas option ${name}`);
  parsed=Number(text);
  if(!Number.isFinite(parsed)||parsed<min||parsed>max)throw new AudioFilterError(`Value ${text} for haas option ${name} out of range [${min} - ${max}]`);
  return parsed;
}
/** Delays in samples as config_input truncates them, reduced modulo native's power-of-two ring, and the ring length that reproduces it. */
export function haasDelays(step:AudioHaasStep,sampleRate:number):{readonly delays:readonly [number,number];readonly ring:number} {
  if(!Number.isSafeInteger(sampleRate)||sampleRate<=0||sampleRate>2147483647)throw new AudioFilterError('Invalid haas sample rate');
  const minimum=Math.trunc(sampleRate*MAX_HAAS_DELAY*0.001);let size=1;while(size<minimum)size*=2;
  // (uint32_t)(delay*0.001*rate); the read index (write+size-delay)&mask is the sample `delay mod size` writes ago.
  const delays=[Math.trunc(step.leftDelay*0.001*sampleRate)%size,Math.trunc(step.rightDelay*0.001*sampleRate)%size] as const;
  return {delays,ring:Math.max(delays[0],delays[1])+1};
}
/** balance_l/balance_r per side, from par_balance, par_gain and the phase sign (par_phase ? 1 : -1). */
export function haasCoefficients(step:AudioHaasStep):{readonly left:readonly [number,number];readonly right:readonly [number,number]} {
  const phase0=step.leftPhase?1.0:-1.0,phase1=step.rightPhase?1.0:-1.0;
  return {left:[(step.leftBalance+1)/2*step.leftGain*phase0,(step.rightBalance+1)/2*step.rightGain*phase1],right:[(1.0-(step.leftBalance+1)/2)*step.leftGain*phase0,(1.0-(step.rightBalance+1)/2)*step.rightGain*phase1]};
}
/** Haas stereo enhancer: af_haas.c filter_frame on packed stereo doubles, with its delay ring carried across frames. */
export const haas=defineAudioFilter<AudioHaasStep>({
  name:'haas',
  examples:['haas','haas=middle_source=side:middle_phase=1:left_delay=40:right_delay=0:left_balance=0.25:right_gain=2:level_in=0.5:level_out=1.5:side_gain=0.75'],
  parse(text){
    if(text==='haas')return defaults;
    if(!text.startsWith('haas='))throw new AudioFilterError(`Unsupported audio filter: ${text}`);
    const step:Record<string,unknown>={...defaults};let position=0,named=false;
    for(const option of text.slice(5).split(':')){
      if(/['"\\]/.test(option))throw new AudioFilterError('Quoted or escaped haas options are not implemented');
      const equals=option.indexOf('=');
      if(equals<0&&named)throw new AudioFilterError(`No haas option name near ${option}`);
      const entry=equals<0?options[position++]:options.find(([name])=>name===option.slice(0,equals));
      if(equals>=0)named=true;
      if(!entry)throw new AudioFilterError(equals<0?`Too many haas option values near ${option}`:`Unsupported haas option: ${option.slice(0,equals)}`);
      const [name,key,kind,min,max]=entry;
      step[key]=value(name,kind,min,max,equals<0?option:option.slice(equals+1));
    }
    return Object.freeze(step) as unknown as AudioHaasStep;
  },
  capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['dbl'],
  constraint:()=>format=>{if(format.channels!==2||format.channelLayout!=='stereo')throw new AudioFilterError('haas requires a stereo layout');},
  async *stream(step,frames,options,_configured,negotiated){
    const {left,right}=haasCoefficients(step),{levelIn,levelOut,sideGain,middleSource,middlePhase}=step;
    let ring:Float64Array|null=null,rate=0,delay0=0,delay1=0,write=0;
    for await(const frame of frames){
      options.signal?.throwIfAborted();
      if(frame.channels!==2||frame.channelLayout!=='stereo')throw new AudioFilterError('haas requires a stereo layout');
      if(ring===null){
        const plan=haasDelays(step,frame.sampleRate);
        if(plan.ring*8>options.maxFrameBytes)throw new AudioFilterError('haas delay buffer exceeds allocation limit');
        ring=new Float64Array(plan.ring);rate=frame.sampleRate;[delay0,delay1]=plan.delays;
      }else if(frame.sampleRate!==rate)throw new AudioFilterError('haas sample rate changed between frames');
      const output=convertAudioFrame(frame,negotiated(frame.sampleFormat as AudioSampleFormat),options);
      if(output.sampleFormat!=='dbl')throw new AudioFilterError(`haas requires dbl samples, not ${output.sampleFormat}`);
      const data=output.planes[0]!,view=new DataView(data.buffer,data.byteOffset,data.byteLength),size=ring.length;
      for(let n=0;n<output.samples;n++){
        if((n&4095)===0)options.signal?.throwIfAborted();
        const l=view.getFloat64(n*16,true),r=view.getFloat64(n*16+8,true);
        let mid=middleSource===0?l:middleSource===1?r:middleSource===2?(l+r)*0.5:(l-r)*0.5;
        mid*=levelIn;
        ring[write]=mid;
        if(middlePhase)mid=-mid;
        const s0=ring[(write+size-delay0)%size]!*sideGain,s1=ring[(write+size-delay1)%size]!*sideGain;
        const sideL=s0*left[0]-s1*left[1],sideR=s1*right[1]-s0*right[0];
        view.setFloat64(n*16,(mid+sideL)*levelOut,true);view.setFloat64(n*16+8,(mid+sideR)*levelOut,true);
        write=(write+1)%size;
      }
      yield output;
    }
  },
  // One output frame per input frame, plus the delay ring: max(delay)+1 doubles (native's power-of-two ring gives identical output).
  reserve:(step,{sampleRate})=>({frames:1,buffers:[],stateBytes:BigInt(haasDelays(step,sampleRate).ring)*8n})
});
