import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter,frameReservation} from './descriptor.js';
export interface AudioExtraStereoStep {readonly name:'extrastereo';readonly mult:number;readonly clip:boolean}
const shorthand=['m','c'] as const;
/** AV_OPT_TYPE_FLOAT: the double is range-checked against [-10,10], then stored as float. Expressions and constants are not implemented. */
function multValue(text:string):number {
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))throw new AudioFilterError('Only decimal extrastereo m values are implemented');
  const value=Number(text);
  if(!(value>=-10&&value<=10))throw new AudioFilterError('extrastereo m must be within [-10,10]');
  return Math.fround(value);
}
function clipValue(text:string):boolean {
  if(text==='1'||text==='true')return true;
  if(text==='0'||text==='false')return false;
  throw new AudioFilterError('Only 0, 1, true or false extrastereo c values are implemented');
}
/** Stereo difference widening on packed float (af_extrastereo.c filter_frame), with every intermediate rounded to float as in C. */
export function extraStereoSamples(data:Float32Array,mult:number,clip:boolean,signal?:AbortSignal):void {
  const m=Math.fround(mult);
  for(let index=0;index+1<data.length;index+=2){
    if((index&16383)===0)signal?.throwIfAborted();
    const left=data[index]!,right=data[index+1]!;
    if(!Number.isFinite(left)||!Number.isFinite(right))throw new AudioFilterError('Non-finite extrastereo input is not yet supported');
    const average=Math.fround(Math.fround(left+right)/2);
    let l=Math.fround(average+Math.fround(m*Math.fround(left-average))),r=Math.fround(average+Math.fround(m*Math.fround(right-average)));
    // av_clipf_c: FFMIN(FFMAX(a,-1),1), so NaN clips to -1.
    if(clip){l=l>-1?l:-1;l=l>1?1:l;r=r>-1?r:-1;r=r>1?1:r;}
    // Overflowing sums (inf-inf) give a NaN whose payload JS does not pin.
    else if(Number.isNaN(l)||Number.isNaN(r))throw new AudioFilterError('NaN extrastereo output without clipping is not yet supported');
    data[index]=l;data[index+1]=r;
  }
}
/** Pinned packed flt and stereo only; native would convert any other format and remix any other layout implicitly. */
export const extrastereo=defineAudioFilter<AudioExtraStereoStep>({
  name:'extrastereo',
  examples:['extrastereo','extrastereo=m=-1:c=0','extrastereo=10:1'],
  parse(text){
    let mult=Math.fround(2.5),clip=true;
    if(text!=='extrastereo'){
      if(!text.startsWith('extrastereo=')||text.length===12)throw new AudioFilterError(`Unsupported audio filter: ${text}`);
      let named=false;
      for(const [index,option]of text.slice(12).split(':').entries()){
        const equals=option.indexOf('=');
        if(equals<0&&(named||index>=shorthand.length))throw new AudioFilterError(`Unsupported extrastereo option: ${option}`);
        const key=equals<0?shorthand[index]!:option.slice(0,equals),value=equals<0?option:option.slice(equals+1);
        if(equals>=0)named=true;
        if(key==='m')mult=multValue(value);
        else if(key==='c')clip=clipValue(value);
        else if(key==='enable')throw new AudioFilterError('extrastereo timeline enable is not implemented');
        else throw new AudioFilterError(`Unsupported extrastereo option: ${option}`);
      }
    }
    return Object.freeze({name:'extrastereo',mult,clip});
  },
  capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['flt'],
  constraint:()=>format=>{
    if(format.channels!==2||format.channelLayout!=='stereo')throw new AudioFilterError(`extrastereo requires stereo input; ${format.channelLayout} would be remixed implicitly`);
  },
  apply(step,frame,target,options){
    if(target!=='flt')throw new AudioFilterError(`extrastereo requires flt, not ${target}`);
    if(frame.channels!==2)throw new AudioFilterError('extrastereo requires stereo input');
    const output=convertAudioFrame(frame,target,options),plane=output.planes[0]!;
    if(plane.byteOffset%4!==0)throw new AudioFilterError('extrastereo requires an aligned float plane');
    extraStereoSamples(new Float32Array(plane.buffer,plane.byteOffset,frame.samples*2),step.mult,step.clip,options.signal);
    return output;
  },
  reserve:()=>frameReservation
});
