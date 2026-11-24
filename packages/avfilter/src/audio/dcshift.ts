import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter,frameReservation} from './descriptor.js';
export interface AudioDcShiftStep {readonly name:'dcshift';readonly shift:number;readonly limitergain:number}
const names=['shift','limitergain'] as const;
function optionValue(name:typeof names[number],text:string):number {
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))throw new AudioFilterError(`Only constant decimal dcshift ${name} values are implemented`);
  const value=Number(text),[low,high]=name==='shift'?[-1,1]:[0,1];
  if(!(value>=low&&value<=high))throw new AudioFilterError(`dcshift ${name} must be between ${low} and ${high}`);
  return value;
}
/** av_clipl_int32 of the double truncated to int64 (af_dcshift.c). x86-64 converts a non-finite or out-of-range double to INT64_MIN,
 * which clips to INT32_MIN: shift=-1:limitergain=1 divides by zero on INT32_MIN input. */
const clip=(value:number)=>{if(!(Math.abs(value)<2**63))return -2147483648;const truncated=Math.trunc(value);return truncated<-2147483648?-2147483648:truncated>2147483647?2147483647:truncated;};
/** DC offset in s32p (af_dcshift.c). With limitergain > 0, samples beyond the limiter threshold are compressed and receive the unscaled shift, as native does. */
export const dcshift=defineAudioFilter<AudioDcShiftStep>({
  name:'dcshift',
  examples:['dcshift','dcshift=0.3','dcshift=-0.7:0.4','dcshift=shift=1:limitergain=1'],
  parse(text){
    const values={shift:0,limitergain:0};
    if(text!=='dcshift'){
      if(!text.startsWith('dcshift='))throw new AudioFilterError(`Unsupported audio filter: ${text}`);
      let named=false;
      for(const [index,option]of text.slice(8).split(':').entries()){
        const separator=option.indexOf('=');
        if(separator<0){
          if(named||index>=names.length)throw new AudioFilterError(`Unsupported dcshift option: ${option}`);
          values[names[index]!]=optionValue(names[index]!,option);continue;
        }
        named=true;const name=option.slice(0,separator);
        if(name!=='shift'&&name!=='limitergain')throw new AudioFilterError(`Unsupported dcshift option: ${option}`);
        values[name]=optionValue(name,option.slice(separator+1));
      }
    }
    return Object.freeze({name:'dcshift',...values});
  },
  capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['s32p'],
  apply(step,frame,target,options){
    if(target!=='s32p')throw new AudioFilterError(`dcshift requires s32p, not ${target}`);
    const converted=convertAudioFrame(frame,target,options),{shift,limitergain}=step;
    const threshold=2147483647*(1-(Math.abs(shift)-limitergain)),range=2147483647-threshold,unlimited=shift*2147483648,scaled=shift*2147483647;
    for(const plane of converted.planes){
      options.signal?.throwIfAborted();
      const view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);
      for(let offset=0;offset<plane.length;offset+=4){
        if((offset&16383)===0)options.signal?.throwIfAborted();
        const d=view.getInt32(offset,true);
        let value:number;
        if(limitergain>0){
          if(d>threshold&&shift>0)value=(d-threshold)*limitergain/range+threshold+shift;
          else if(d< -threshold&&shift<0)value=(d+threshold)*limitergain/range-threshold+shift;
          else value=scaled+d;
        }else value=unlimited+d;
        view.setInt32(offset,clip(value),true);
      }
    }
    return converted;
  },
  reserve:()=>frameReservation
});
