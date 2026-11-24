import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter,packed} from './descriptor.js';
/** `intensity` is the float32 option value (af_crystalizer.c stores i in a float); `clip` is option c. */
export interface AudioCrystalizerStep {readonly name:'crystalizer';readonly intensity:number;readonly clip:boolean}
const number=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
function intensityValue(text:string):number{
  if(!number.test(text))throw new AudioFilterError('Only constant numeric crystalizer intensity is implemented');
  const value=Number(text);
  // set_string_number range-checks the double before write_number stores it as float.
  if(!(value>=-10&&value<=10))throw new AudioFilterError(`crystalizer intensity ${text} out of range [-10 - 10]`);
  return Math.fround(value);
}
function clipValue(text:string):boolean{
  // set_string_bool: case-insensitive names, otherwise a whole decimal strtol value within [0,1]; 'auto' (-1) is out of range.
  const lower=text.toLowerCase();
  if(['true','y','yes','enable','enabled','on'].includes(lower))return true;
  if(['false','n','no','disable','disabled','off'].includes(lower))return false;
  if(!/^[+-]?\d+$/.test(text)||Number(text)!==0&&Number(text)!==1)throw new AudioFilterError(`Unsupported crystalizer clipping value: ${text}`);
  return Number(text)===1;
}
/** Float32 recurrences of af_crystalizer.c with one rounding per C operation; double recurrences unchanged. */
function filterPlane(view:DataView,start:number,stride:number,samples:number,width:number,previous:Float64Array,channel:number,mult:number,clip:boolean,signal?:AbortSignal){
  const single=width===4,round=single?Math.fround:(value:number)=>value,inverse=!(mult>=0),scale=round(1/round(-mult+1));
  let prior=previous[channel]!;
  for(let index=0,offset=start;index<samples;index++,offset+=stride){
    if((index&4095)===0)signal?.throwIfAborted();
    const current=single?view.getFloat32(offset,true):view.getFloat64(offset,true);
    let output:number;
    if(inverse){output=round(round(current-round(prior*mult))*scale);prior=output;}
    else{output=round(current+round(round(current-prior)*mult));prior=current;}
    // av_clipf/av_clipd: FFMIN(FFMAX(a,-1),1), so NaN becomes -1.
    if(clip){output=output>-1?output:-1;output=output>1?1:output;}
    if(single)view.setFloat32(offset,output,true);else view.setFloat64(offset,output,true);
  }
  previous[channel]=prior;
}
/** Simple audio noise sharpening: per-channel sample-difference recurrence in the negotiated flt/fltp/dbl/dblp format, state carried across frames. */
export const crystalizer=defineAudioFilter<AudioCrystalizerStep>({
  name:'crystalizer',
  examples:['crystalizer','crystalizer=i=-3:c=0','crystalizer=10:1'],
  parse(text){
    let intensity=Math.fround(2),clip=true,named=false;
    if(text!=='crystalizer'){
      if(!text.startsWith('crystalizer='))throw new AudioFilterError(`Unsupported audio filter: ${text}`);
      const options=text.slice(12).split(':');
      for(const [index,option]of options.entries()){
        if(/['"\\]/.test(option))throw new AudioFilterError('Quoted or escaped crystalizer options are not implemented');
        const equals=option.indexOf('=');
        if(equals<0&&named)throw new AudioFilterError(`crystalizer positional option after a named option: ${option}`);
        const key=equals<0?['i','c'][index]:option.slice(0,equals),value=equals<0?option:option.slice(equals+1);
        if(key===undefined)throw new AudioFilterError('Too many crystalizer options');
        if(equals>=0)named=true;
        if(key==='i')intensity=intensityValue(value);
        else if(key==='c')clip=clipValue(value);
        else if(key==='enable')throw new AudioFilterError('crystalizer timeline enable is not implemented');
        else throw new AudioFilterError(`Unsupported crystalizer option: ${key}`);
      }
    }
    return Object.freeze({name:'crystalizer',intensity,clip});
  },
  capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['flt','fltp','dbl','dblp'],
  async *stream(step,frames,options,_configured,negotiated){
    let previous:Float64Array|null=null;
    for await(const frame of frames){
      options.signal?.throwIfAborted();
      const target=negotiated(frame.sampleFormat as AudioSampleFormat),base=packed(target);
      if(base!=='flt'&&base!=='dbl')throw new AudioFilterError(`crystalizer cannot work in ${target}`);
      const output:AudioFrameData=convertAudioFrame(frame,target,options),width=base==='flt'?4:8,planar=target!==base;
      // The prev frame of af_crystalizer.c: one silent sample per channel, allocated with the first frame.
      previous??=new Float64Array(output.channels);
      if(previous.length!==output.channels)throw new AudioFilterError('crystalizer channel count changed');
      for(let channel=0;channel<output.channels;channel++){
        const plane=output.planes[planar?channel:0]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);
        filterPlane(view,planar?0:channel*width,planar?width:width*output.channels,output.samples,width,previous,channel,step.intensity,step.clip,options.signal);
      }
      yield output;
    }
  },
  // One owned output frame per input frame plus the per-channel previous value (a Float64Array).
  reserve:(_step,{channels})=>({frames:1,buffers:[],stateBytes:BigInt(channels)*8n})
});
