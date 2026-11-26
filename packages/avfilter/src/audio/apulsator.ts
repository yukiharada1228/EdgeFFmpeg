import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioConversionOptions,AudioSampleFormat} from '@edge-ffmpeg/swresample';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {AudioFilterError,defineAudioFilter} from './descriptor.js';
/** af_apulsator.c PulsatorModes without SINE (0), which needs libm sin(). */
export type ApulsatorMode = 'triangle'|'square'|'sawup'|'sawdown';
/** af_apulsator.c PulsatorTimings. */
export type ApulsatorTiming = 'bpm'|'ms'|'hz';
export interface AudioApulsatorStep {
  readonly name:'apulsator';
  readonly levelIn:number;readonly levelOut:number;readonly mode:ApulsatorMode;readonly amount:number;
  readonly offsetL:number;readonly offsetR:number;readonly width:number;readonly timing:ApulsatorTiming;
  readonly bpm:number;readonly ms:number;readonly hz:number;
}
type Key = Exclude<keyof AudioApulsatorStep,'name'>;
const modes=['sine','triangle','square','sawup','sawdown'] as const,timings=['bpm','ms','hz'] as const;
/** AVOption declaration order without the AV_OPT_TYPE_CONST entries: positional values fill these, as libavfilter's shorthand does. */
const optionTable:readonly (readonly [string,Key,'double'|'int'|'mode'|'timing',number,number])[]=[
  ['level_in','levelIn','double',0.015625,64],['level_out','levelOut','double',0.015625,64],['mode','mode','mode',0,4],['amount','amount','double',0,1],
  ['offset_l','offsetL','double',0,1],['offset_r','offsetR','double',0,1],['width','width','double',0,2],['timing','timing','timing',0,2],
  ['bpm','bpm','double',30,300],['ms','ms','int',10,2000],['hz','hz','double',0.01,100]
];
const decimal=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/,integer=/^[+-]?\d+$/;
function optionValue(name:string,kind:'double'|'int'|'mode'|'timing',min:number,max:number,text:string):number {
  const names:readonly string[]|null=kind==='mode'?modes:kind==='timing'?timings:null;
  if(names?.includes(text))return names.indexOf(text);
  if(kind==='double'?!decimal.test(text):!integer.test(text))throw new AudioFilterError(kind==='double'?`Only constant decimal values are implemented for apulsator option ${name}: ${text}`:names?`Only ${names.join(', ')} or an integer are implemented for apulsator option ${name}: ${text}`:`Only integer values are implemented for apulsator option ${name}: ${text}`);
  const value=Number(text);
  // write_number compares the parsed double with the option range (ERANGE).
  if(!(value>=min&&value<=max))throw new AudioFilterError(`Value ${text} for apulsator option ${name} out of range [${min} - ${max}]`);
  return value;
}
/** config_input: the LFO frequency in Hz for the selected timing unit. */
export function apulsatorFrequency(step:AudioApulsatorStep):number {
  return step.timing==='bpm'?step.bpm/60:step.timing==='ms'?1/(step.ms/1000):step.hz;
}
/** lfo_get_value for the non-sine modes: phase scaled by the clamped pulse width plus the offset, wrapped with fmod (JS % is exact fmod), times amount. */
export function apulsatorLfoValue(mode:ApulsatorMode,phase:number,offset:number,width:number,amount:number):number {
  const low=0.01>width?0.01:width,pwidth=1.99>low?low:1.99,scaled=phase/pwidth+offset;
  let phs=100>scaled?scaled:100;
  if(phs>1)phs%=1;
  const value=mode==='triangle'?(phs>0.75?(phs-0.75)*4-1:phs>0.25?-4*phs+2:phs*4):mode==='square'?(phs<0.5?-1:1):mode==='sawup'?phs*2-1:1-phs*2;
  return value*amount;
}
/** lfo_advance with count 1: fabs(phase + 1*freq/srate), then fmod once the phase reaches 1. */
export const apulsatorAdvance=(phase:number,freq:number,sampleRate:number):number=>{const next=Math.abs(phase+1*freq/sampleRate);return next>=1?next%1:next;};
/** Stereo LFO auto-panner from af_apulsator.c filter_frame on packed stereo doubles; both LFO phases persist across frames. */
export async function* apulsatorAudio(frames:AsyncIterable<AudioFrameData>,step:AudioApulsatorStep,options:AudioConversionOptions,target:(input:AudioSampleFormat)=>AudioSampleFormat=()=>'dbl'):AsyncIterable<AudioFrameData> {
  const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1)throw new AudioFilterError('Invalid apulsator allocation limit');
  const {mode,levelIn,levelOut,amount,offsetL,offsetR,width}=step,freq=apulsatorFrequency(step);
  let rate=0,phaseL=0,phaseR=0;
  for await(const frame of frames){
    signal?.throwIfAborted();
    if(frame.channels!==2||frame.channelLayout!=='stereo')throw new AudioFilterError('apulsator requires stereo input');
    if(!Number.isSafeInteger(frame.sampleRate)||frame.sampleRate<1||frame.sampleRate>2147483647)throw new AudioFilterError('Invalid apulsator sample rate');
    if(rate===0)rate=frame.sampleRate;else if(frame.sampleRate!==rate)throw new AudioFilterError('apulsator requires a stable input format');
    const format=target(frame.sampleFormat as AudioSampleFormat);
    if(format!=='dbl')throw new AudioFilterError(`apulsator cannot work in ${format}`);
    const output=convertAudioFrame(frame,'dbl',options),plane=output.planes[0]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);
    for(let n=0,offset=0;n<output.samples;n++,offset+=16){
      if((n&4095)===0)signal?.throwIfAborted();
      const left=view.getFloat64(offset,true),right=view.getFloat64(offset+8,true);
      if(!Number.isFinite(left)||!Number.isFinite(right))throw new AudioFilterError('Non-finite apulsator input is not yet supported');
      const inL=left*levelIn,inR=right*levelIn;
      const procL=inL*(apulsatorLfoValue(mode,phaseL,offsetL,width,amount)*0.5+amount/2),procR=inR*(apulsatorLfoValue(mode,phaseR,offsetR,width,amount)*0.5+amount/2);
      const outL=(procL+inL*(1-amount))*levelOut,outR=(procR+inR*(1-amount))*levelOut;
      // Overflowing inputs can give inf*0 or inf-inf, whose NaN payload JS does not pin.
      if(Number.isNaN(outL)||Number.isNaN(outR))throw new AudioFilterError('NaN apulsator output is not yet supported');
      view.setFloat64(offset,outL,true);view.setFloat64(offset+8,outR,true);
      phaseL=apulsatorAdvance(phaseL,freq,rate);phaseR=apulsatorAdvance(phaseR,freq,rate);
    }
    yield output;
  }
}
const defaults={levelIn:1,levelOut:1,mode:0,amount:1,offsetL:0,offsetR:0.5,width:1,timing:2,bpm:120,ms:500,hz:2};
/** apulsator: LFO auto-panner on packed double stereo, triangle/square/sawup/sawdown only. Constant options only: timeline enable and runtime commands are refused. */
export const apulsator=defineAudioFilter<AudioApulsatorStep>({
  name:'apulsator',
  examples:['apulsator=mode=triangle','apulsator=1:1:square:0.6:0.5:1:2:bpm:300','apulsator=mode=sawup:timing=ms:ms=10:amount=0:width=0','apulsator=level_in=0.015625:level_out=64:mode=sawdown:offset_l=1:offset_r=0:timing=hz:hz=100'],
  parse(text){
    if(text!=='apulsator'&&!text.startsWith('apulsator='))throw new AudioFilterError(`Unsupported audio filter: ${text}`);
    const values:Record<Key,number>={...defaults};
    if(text!=='apulsator'){
      let named=false;
      for(const [index,option]of text.slice(10).split(':').entries()){
        if(/['"\\]/.test(option))throw new AudioFilterError('Quoted or escaped apulsator options are not implemented');
        const equals=option.indexOf('=');
        if(equals<0&&named)throw new AudioFilterError(`No apulsator option name near '${option}'`);
        if(equals<0&&index>=optionTable.length)throw new AudioFilterError(`Too many apulsator positional options: ${option}`);
        const key=equals<0?optionTable[index]![0]:option.slice(0,equals),value=equals<0?option:option.slice(equals+1);
        if(equals>=0)named=true;
        if(key==='enable')throw new AudioFilterError('apulsator timeline enable is not implemented');
        const entry=optionTable.find(([name])=>name===key);
        if(!entry)throw new AudioFilterError(`Unsupported apulsator option: ${key}`);
        const [name,field,kind,min,max]=entry;
        values[field]=optionValue(name,kind,min,max,value);
      }
    }
    if(values.mode===0)throw new AudioFilterError('apulsator mode sine requires unimplemented libm arithmetic');
    return Object.freeze({name:'apulsator',levelIn:values.levelIn,levelOut:values.levelOut,mode:modes[values.mode] as ApulsatorMode,amount:values.amount,offsetL:values.offsetL,offsetR:values.offsetR,width:values.width,timing:timings[values.timing]!,bpm:values.bpm,ms:values.ms,hz:values.hz});
  },
  // A stream step: the chain derives reframes, so output time selection is taken from the filtered whole input.
  capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['dbl'],
  // query_formats: stereo only; native would remix any other layout implicitly.
  constraint:()=>format=>{if(format.channels!==2||format.channelLayout!=='stereo')throw new AudioFilterError('apulsator requires stereo input');},
  stream:(step,frames,options,_configured,negotiated)=>apulsatorAudio(frames,step,options,negotiated),
  // One output frame plus the two SimpleLFO phases.
  reserve:()=>({frames:1,buffers:[],stateBytes:16n})
});
