import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioConversionOptions,AudioSampleFormat} from '@edge-ffmpeg/swresample';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {AudioFilterError,defineAudioFilter} from './descriptor.js';
export interface AudioStereoWidenStep {readonly name:'stereowiden';readonly delay:number;readonly feedback:number;readonly crossfeed:number;readonly drymix:number}
type StereoWidenOption = 'delay'|'feedback'|'crossfeed'|'drymix';
/** af_stereowiden.c option table in shorthand order: AV_OPT_TYPE_FLOAT defaults and [min, max]. */
const optionTable:readonly (readonly [StereoWidenOption,number,number,number])[]=[['delay',20,1,100],['feedback',0.3,0,0.9],['crossfeed',0.3,0,0.8],['drymix',0.8,0,1]];
const roundEven=(value:number)=>{const low=Math.floor(value),fraction=value-low;return fraction<0.5?low:fraction>0.5?low+1:low%2===0?low:low+1;};
/** Ring length in floats (two per stereo sample): 2*lrintf(delay*sample_rate/1000) in float arithmetic, round half to even; 0 is native's EINVAL. */
export function stereoWidenLength(step:AudioStereoWidenStep,sampleRate:number):number {
  if(!Number.isSafeInteger(sampleRate)||sampleRate<1||sampleRate>2147483647)throw new AudioFilterError('Invalid stereowiden sample rate');
  return 2*roundEven(Math.fround(Math.fround(step.delay*Math.fround(sampleRate))/1000));
}
/** Cross-feed widening from af_stereowiden.c: delayed opposite-channel feedback over a ring of previous input samples, float arithmetic in native order. */
export async function* stereoWidenAudio(frames:AsyncIterable<AudioFrameData>,step:AudioStereoWidenStep,options:AudioConversionOptions,target:(input:AudioSampleFormat)=>AudioSampleFormat=()=>'flt'):AsyncIterable<AudioFrameData> {
  const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1)throw new AudioFilterError('Invalid stereowiden allocation limit');
  const d=Math.fround(step.drymix),c=Math.fround(step.crossfeed),f=Math.fround(step.feedback);
  let ring:Float32Array|null=null,rate=0,cur=0;
  for await(const frame of frames){
    signal?.throwIfAborted();
    if(frame.channels!==2||frame.channelLayout!=='stereo')throw new AudioFilterError('stereowiden requires stereo input');
    if(ring===null){
      const length=stereoWidenLength(step,frame.sampleRate);
      if(length===0)throw new AudioFilterError(`stereowiden delay rounds to zero samples at ${frame.sampleRate} Hz`);
      if(length*4>maxFrameBytes)throw new AudioFilterError('stereowiden delay buffer exceeds allocation limit');
      ring=new Float32Array(length);rate=frame.sampleRate;
    }else if(frame.sampleRate!==rate)throw new AudioFilterError('stereowiden requires a stable input format');
    const format=target(frame.sampleFormat as AudioSampleFormat);
    if(format!=='flt')throw new AudioFilterError(`stereowiden cannot work in ${format}`);
    const output=convertAudioFrame(frame,'flt',options),plane=output.planes[0]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength),length=ring.length;
    for(let n=0,offset=0;n<frame.samples;n++,offset+=8,cur+=2){
      if((n&4095)===0)signal?.throwIfAborted();
      const left=view.getFloat32(offset,true),right=view.getFloat32(offset+4,true);
      if(!Number.isFinite(left)||!Number.isFinite(right))throw new AudioFilterError('Non-finite stereowiden input is not yet supported');
      if(cur===length)cur=0;
      view.setFloat32(offset,Math.fround(Math.fround(Math.fround(d*left)-Math.fround(c*right))-Math.fround(f*ring[cur+1]!)),true);
      view.setFloat32(offset+4,Math.fround(Math.fround(Math.fround(d*right)-Math.fround(c*left))-Math.fround(f*ring[cur]!)),true);
      ring[cur]=left;ring[cur+1]=right;
    }
    yield output;
  }
}
/** stereowiden: delayed cross-feed widening on packed float stereo. Constant options only: timeline enable and runtime commands are refused. */
export const stereowiden=defineAudioFilter<AudioStereoWidenStep>({
  name:'stereowiden',
  examples:['stereowiden','stereowiden=delay=5:feedback=0.5:crossfeed=0.2:drymix=0.9','stereowiden=100:0:0.8:1'],
  parse(text){
    const values:Record<StereoWidenOption,number>={delay:20,feedback:0.3,crossfeed:0.3,drymix:0.8};
    if(text!=='stereowiden'){
      if(!text.startsWith('stereowiden='))throw new AudioFilterError(`Unsupported audio filter: ${text}`);
      let named=false;
      for(const [index,option]of text.slice(12).split(':').entries()){
        const equals=option.indexOf('=');
        if(equals<0&&named)throw new AudioFilterError(`No stereowiden option name near '${option}'`);
        if(equals<0&&index>=optionTable.length)throw new AudioFilterError(`Too many stereowiden positional options: ${option}`);
        const key=equals<0?optionTable[index]![0]:option.slice(0,equals),value=equals<0?option:option.slice(equals+1);
        if(equals>=0)named=true;
        if(key==='enable')throw new AudioFilterError('stereowiden timeline enable is not implemented');
        const entry=optionTable.find(([name])=>name===key);
        if(!entry)throw new AudioFilterError(`Unsupported stereowiden option: ${key}`);
        if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))throw new AudioFilterError(`Only constant numeric stereowiden ${key} values are implemented: ${value}`);
        const number=Number(value),[,,min,max]=entry;
        // Native compares the parsed double with the option range, then stores it as float.
        if(!(number>=min&&number<=max))throw new AudioFilterError(`stereowiden ${key} ${value} is out of range [${min} - ${max}]`);
        values[key as StereoWidenOption]=number;
      }
    }
    return Object.freeze({name:'stereowiden',delay:Math.fround(values.delay),feedback:Math.fround(values.feedback),crossfeed:Math.fround(values.crossfeed),drymix:Math.fround(values.drymix)});
  },
  capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['flt'],
  // query_formats: stereo only; native would remix any other layout implicitly, and config_input fails with EINVAL for a zero-length ring.
  constraint:step=>format=>{
    if(format.channels!==2||format.channelLayout!=='stereo')throw new AudioFilterError('stereowiden requires stereo input');
    if(stereoWidenLength(step,format.sampleRate)===0)throw new AudioFilterError(`stereowiden delay rounds to zero samples at ${format.sampleRate} Hz`);
  },
  stream:(step,frames,options,_configured,negotiated)=>stereoWidenAudio(frames,step,options,negotiated),
  // One output frame plus the ring of length floats.
  reserve(step,{sampleRate}){
    let length=0;try{length=stereoWidenLength(step,sampleRate);}catch{/* the constraint refuses the rate */}
    return {frames:1,buffers:[],stateBytes:BigInt(length)*4n};
  }
});
