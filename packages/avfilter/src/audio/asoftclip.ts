import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter,frameReservation} from './descriptor.js';
/** type=hard (ASC_HARD) or type=alg (ASC_ALG) at oversample=1; threshold, output and param are the parsed doubles of af_asoftclip.c. */
export interface AudioSoftClipStep {readonly name:'asoftclip';readonly type:'hard'|'alg';readonly threshold:number;readonly output:number;readonly param:number}
const libm=['tanh','atan','cubic','exp','quintic','sin','erf'];
const ranges:Readonly<Record<string,readonly [number,number]>>={threshold:[0.000001,1],output:[0.000001,16],param:[0.01,3]};
const positional=['type','threshold','output','param','oversample'];
function decimal(key:string,text:string):number{
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text))throw new AudioFilterError(`Only plain decimal asoftclip ${key} values are implemented: ${text}`);
  const value=Number(text),[low,high]=ranges[key]!;
  if(!(value>=low&&value<=high))throw new AudioFilterError(`asoftclip ${key} ${text} is outside ${low}..${high}`);
  return value;
}
/** Float factor, gain and param as filter_flt declares them: threshold is rounded to float before both, gain is the double product rounded to float. */
export function asoftclipFloatCoefficients(step:AudioSoftClipStep){
  const threshold=Math.fround(step.threshold);
  return {factor:Math.fround(1/threshold),gain:Math.fround(step.output*threshold),param:Math.fround(step.param)};
}
/** The per-sample loop of filter_flt (float=true: every operation rounded to float, no contraction, the Linux unfused profile for alg) or filter_dbl. */
export function asoftclipKernel(step:AudioSoftClipStep,float:boolean):(value:number)=>number{
  if(float){
    const {factor,gain,param}=asoftclipFloatCoefficients(step);
    if(step.type==='hard')return value=>{const scaled=Math.fround(value*factor);return Math.fround((scaled<-1?-1:scaled>1?1:scaled)*gain);};
    return value=>{
      const scaled=Math.fround(value*factor);
      if(!Number.isFinite(scaled))throw new AudioFilterError('asoftclip alg input overflows the float sample range');
      return Math.fround(Math.fround(scaled/Math.fround(Math.sqrt(Math.fround(param+Math.fround(scaled*scaled)))))*gain);
    };
  }
  const factor=1/step.threshold,gain=step.output*step.threshold,param=step.param;
  if(step.type==='hard')return value=>{const scaled=value*factor;return (scaled<-1?-1:scaled>1?1:scaled)*gain;};
  return value=>{
    const scaled=value*factor;
    if(!Number.isFinite(scaled))throw new AudioFilterError('asoftclip alg input overflows the double sample range');
    return scaled/Math.sqrt(param+scaled*scaled)*gain;
  };
}
/** Audio soft clipper (libavfilter/af_asoftclip.c), hard and alg types without oversampling; every libm type and oversample>1 is refused. */
export const asoftclip=defineAudioFilter<AudioSoftClipStep>({
  name:'asoftclip',
  examples:['asoftclip=hard','asoftclip=type=hard:threshold=0.5:output=1.3','asoftclip=alg:0.5:1.3:0.5:1'],
  parse(text){
    if(text!=='asoftclip'&&!text.startsWith('asoftclip='))throw new AudioFilterError(`Unsupported audio filter: ${text}`);
    const values=new Map<string,string>();let named=false;
    const tokens=text==='asoftclip'?[]:text.slice(10).split(':');
    for(const [index,option]of tokens.entries()){
      // process_args stops after one trailing ':'; any other empty token is an empty option value natively.
      if(option===''){if(index===tokens.length-1)continue;throw new AudioFilterError('Empty asoftclip option value');}
      const separator=option.indexOf('=');
      if(separator<0){
        if(named||index>=positional.length)throw new AudioFilterError(`Unsupported asoftclip option: ${option}`);
        values.set(positional[index]!,option);continue;
      }
      const key=option.slice(0,separator);named=true;
      if(key==='enable')throw new AudioFilterError('asoftclip timeline enable is not implemented');
      if(!positional.includes(key))throw new AudioFilterError(`Unsupported asoftclip option: ${option}`);
      values.set(key,option.slice(separator+1));
    }
    const type=values.get('type')??'tanh';
    if(libm.includes(type))throw new AudioFilterError(`asoftclip type ${type} requires unimplemented libm arithmetic`);
    if(type!=='hard'&&type!=='alg')throw new AudioFilterError(`Unsupported asoftclip type: ${type}`);
    const oversample=values.get('oversample')??'1';
    if(oversample!=='1')throw new AudioFilterError(/^\+?\d+$/.test(oversample)?`asoftclip oversample ${oversample} requires its unimplemented sin/cos lowpass`:`Unsupported asoftclip oversample: ${oversample}`);
    const option=(key:string)=>{const value=values.get(key);return value===undefined?1:decimal(key,value);};
    return Object.freeze({name:'asoftclip',type,threshold:option('threshold'),output:option('output'),param:option('param')});
  },
  capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['fltp','dblp'],
  apply(step,frame,target,options){
    const float=target==='flt'||target==='fltp',width=float?4:8;
    if(!float&&target!=='dbl'&&target!=='dblp')throw new AudioFilterError(`asoftclip cannot run in ${target}`);
    const converted=convertAudioFrame(frame,target,options),kernel=asoftclipKernel(step,float);
    for(const plane of converted.planes){
      const view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);
      for(let offset=0;offset<plane.length;offset+=width){
        if((offset&16383)===0)options.signal?.throwIfAborted();
        const value=float?view.getFloat32(offset,true):view.getFloat64(offset,true);
        if(!Number.isFinite(value))throw new AudioFilterError('Non-finite asoftclip input is not yet supported');
        const result=kernel(value);
        if(float)view.setFloat32(offset,result,true);else view.setFloat64(offset,result,true);
      }
    }
    return converted;
  },
  reserve:()=>frameReservation
});
