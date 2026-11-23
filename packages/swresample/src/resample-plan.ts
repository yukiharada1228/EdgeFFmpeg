import {AudioConversionError} from './convert.js';
import type {AudioConversionOptions,AudioSampleFormat} from './convert.js';
export type ResampleSampleFormat='s16'|'flt'|'dbl';
export interface AudioResampleOptions extends AudioConversionOptions {readonly maxStateBytes:number;readonly sampleFormat?:ResampleSampleFormat}
/** Default SWR internal precision while changing sample rate; differs from pure rematrixing. */
export function resampleInternalFormat(source:AudioSampleFormat,target:AudioSampleFormat):ResampleSampleFormat{
  source=(source.endsWith('p')?source.slice(0,-1):source) as AudioSampleFormat;target=(target.endsWith('p')?target.slice(0,-1):target) as AudioSampleFormat;
  if(!['u8','s16','s32','flt','dbl'].includes(source)||!['u8','s16','s32','flt','dbl'].includes(target))throw new AudioConversionError('Unsupported resampling source or target format');
  if(source==='dbl')return 'dbl';
  return (source==='u8'&&['u8','s16'].includes(target))||(source==='s16'&&target==='u8')?'s16':'flt';
}
export interface AudioResamplePlan {readonly inputRate:number;readonly outputRate:number;readonly channels:number;readonly sampleFormat:ResampleSampleFormat;readonly taps:number;readonly phases:number;readonly interpolates:boolean;readonly historySamples:number;readonly coefficientBytes:number;readonly stateBytes:number}
const validRate=(value:number)=>Number.isInteger(value)&&value>0&&value<=2147483647;
function geometry(inputRate:number,outputRate:number){
  if(!validRate(inputRate)||!validRate(outputRate))throw new AudioConversionError('Invalid resampling rate');
  let a=inputRate,b=outputRate;while(b){const remainder=a%b;a=b;b=remainder;}
  if(inputRate===outputRate)return {taps:0,phases:1,factor:1};
  const factor=Math.min(outputRate*0.97/inputRate,1),minimum=Math.ceil(32/factor),taps=minimum+(minimum%2);
  return {taps,phases:outputRate/a,factor};
}
/** Available default FIR samples before EOF, independent of physical partitions. */
export function resampledStreamingSampleCount(samples:bigint,inputRate:number,outputRate:number):bigint{
  if(typeof samples!=='bigint'||samples<0n)throw new AudioConversionError('Invalid resampling input count');
  const {taps}=geometry(inputRate,outputRate);if(taps===0)return samples;
  if(samples<BigInt(taps+1))return 0n;
  const lookahead=BigInt(taps-Math.floor((taps-1)/2)-1);
  return ((samples-lookahead)*BigInt(outputRate)+BigInt(inputRate)-1n)/BigInt(inputRate);
}
/** Native default FIR total count including finite short-input flush behavior. */
export function resampledSampleCount(samples:bigint,inputRate:number,outputRate:number):bigint{
  if(typeof samples!=='bigint'||samples<0n)throw new AudioConversionError('Invalid resampling input count');
  const {taps}=geometry(inputRate,outputRate);if(taps===0)return samples;
  const half=BigInt(taps/2),center=BigInt(Math.floor((taps-1)/2)),rateIn=BigInt(inputRate),rateOut=BigInt(outputRate);
  // The drain mirrors half the retained input, not half the entire stream.
  // Rational phase position changes the retained length by a sample at some ratios.
  const beforeFlush=resampledStreamingSampleCount(samples,inputRate,outputRate);
  const consumed=beforeFlush*rateIn/rateOut>center?beforeFlush*rateIn/rateOut-center:0n,remaining=samples-consumed;
  const tail=(remaining+1n)/2n<half?(remaining+1n)/2n:half;
  if(samples+tail<BigInt(taps+1))return 0n;
  const numerator=(samples+tail-half)*BigInt(outputRate);return (numerator+BigInt(inputRate)-1n)/BigInt(inputRate);
}
/** Payload reservation excludes caller-owned input, yielded output, GC and runtime objects. */
export function planAudioResample(inputRate:number,outputRate:number,channels:number,options:AudioResampleOptions):AudioResamplePlan{
  const {taps,phases:exactPhases}=geometry(inputRate,outputRate),phases=Math.min(exactPhases,1024),interpolates=exactPhases>1024,sampleFormat=options.sampleFormat??'dbl',width=sampleFormat==='s16'?2:sampleFormat==='flt'?4:8;
  if(!['s16','flt','dbl'].includes(sampleFormat))throw new AudioConversionError('Unsupported resampling sample format');
  if(!Number.isSafeInteger(channels)||channels<1||!Number.isSafeInteger(options.maxStateBytes)||options.maxStateBytes<1||!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<channels*width)throw new AudioConversionError('Invalid resampling resource limits');
  const historySamples=taps===0?0:2*taps+2,coefficientBytes=taps*phases*width,stateBytes=coefficientBytes+historySamples*channels*width;
  if(!Number.isSafeInteger(stateBytes)||stateBytes>options.maxStateBytes)throw new AudioConversionError('Resampling state exceeds allocation limit');
  return Object.freeze({inputRate,outputRate,channels,sampleFormat,taps,phases,interpolates,historySamples,coefficientBytes,stateBytes});
}
function besselI0(value:number):number{
  let sum=1,term=1;
  for(let k=1;k<128;k++){term*=value*value/(4*k*k);const previous=sum;sum+=term;if(sum===previous)return sum;}
  throw new AudioConversionError('Kaiser window did not converge');
}
/** Deterministic coefficient bank for a plan; checkpoints rebuild it instead of serializing it. */
export function resampleCoefficients(plan:AudioResamplePlan,signal?:AbortSignal):Int16Array|Float32Array|Float64Array{
  const {taps,phases,inputRate,outputRate,sampleFormat}=plan,center=Math.floor((taps-1)/2),factor=Math.min(outputRate*0.97/inputRate,1);
  const coefficient=(phase:number,tap:number)=>{
    const distance=tap-center-phase/phases,angle=Math.PI*distance*factor,relative=distance/(taps/2);
    const sinc=angle===0?1:factor===1&&phase===0?0:Math.sin(angle)/angle;
    return sinc*besselI0(9*Math.sqrt(Math.max(0,1-relative*relative)));
  };
  // Normalize all phases against the unquantized phase-zero sum.
  let normalization=0;for(let tap=0;tap<taps;tap++){if((tap&4095)===0)signal?.throwIfAborted();normalization+=coefficient(0,tap);}
  const bank=sampleFormat==='s16'?new Int16Array(taps*phases):sampleFormat==='flt'?new Float32Array(taps*phases):new Float64Array(taps*phases);
  const quantize=(value:number)=>{const lower=Math.floor(value),fraction=value-lower;return Math.max(-32768,Math.min(32767,fraction<0.5?lower:fraction>0.5?lower+1:lower%2===0?lower:lower+1));};
  for(let phase=0;phase<phases;phase++){
    signal?.throwIfAborted();
    let absoluteSum=0;
    for(let tap=0;tap<taps;tap++){if((tap&4095)===0)signal?.throwIfAborted();const value=coefficient(phase,tap)/normalization;bank[phase*taps+tap]=sampleFormat==='s16'?quantize(Math.fround(value*32768)):value;absoluteSum+=Math.abs(bank[phase*taps+tap]!);}
    if(sampleFormat==='s16'&&!Number.isSafeInteger(absoluteSum*65536))throw new AudioConversionError('Fixed resampling accumulator exceeds exact integer range');
  }
  return bank;
}
