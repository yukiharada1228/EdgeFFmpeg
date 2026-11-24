import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioConversionOptions,AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter} from './descriptor.js';
export interface AudioDynamicSmoothStep {readonly name:'adynamicsmooth';readonly sensitivity:number;readonly basefreq:number}
const keys=['sensitivity','basefreq'] as const,ranges={sensitivity:[0,1000000],basefreq:[2,1000000]} as const;
/** One option value: plain decimals only (av_strtod would also take expressions, exponents, hex and SI suffixes). */
function decimal(name:'sensitivity'|'basefreq',text:string):number {
  if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text))throw new AudioFilterError(`Unsupported adynamicsmooth ${name}: ${text}`);
  const value=Number(text),[low,high]=ranges[name];
  if(!(value>=low&&value<=high))throw new AudioFilterError(`adynamicsmooth ${name} ${text} is out of range [${low} - ${high}]`);
  return value;
}
/** af_adynamicsmooth.c filter_frame: per-channel two-stage dynamic smoothing in double, low1/low2/inz carried across frames from zero. */
export async function* smoothAudio(step:AudioDynamicSmoothStep,frames:AsyncIterable<AudioFrameData>,options:AudioConversionOptions,negotiated:(input:AudioSampleFormat)=>AudioSampleFormat=()=>'dblp'):AsyncIterable<AudioFrameData> {
  const sensitivity=step.sensitivity;let state:Float64Array|null=null;
  for await(const frame of frames){
    options.signal?.throwIfAborted();
    const output=convertAudioFrame(frame,negotiated(frame.sampleFormat as AudioSampleFormat),options),channels=output.channels;
    if(state===null)state=new Float64Array(channels*3);
    else if(state.length!==channels*3)throw new AudioFilterError('adynamicsmooth requires a stable channel count');
    const wc=step.basefreq/output.sampleRate;
    for(let ch=0;ch<channels;ch++){
      options.signal?.throwIfAborted();
      const plane=output.planes[ch]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength);
      let low1=state[ch*3]!,low2=state[ch*3+1]!,inz=state[ch*3+2]!;
      for(let n=0;n<output.samples;n++){
        if((n&4095)===4095)options.signal?.throwIfAborted();
        const x=view.getFloat64(n*8,true);
        if(!Number.isFinite(x))throw new AudioFilterError('Non-finite adynamicsmooth input is not yet supported');
        // Same operation order as the C source; JavaScript never contracts a*b+c, so this is the unfused IEEE double result.
        const low1z=low1,low2z=low2,bandz=low2z-low1z,wd=wc+sensitivity*Math.abs(bandz);
        const poly=wd*(5.9948827+wd*(-11.969296+wd*15.959062)),g=Number.isNaN(poly)||poly>1?1:poly;
        low1=low1z+g*(0.5*(x+inz)-low1z);
        low2=low2z+g*(0.5*(low1+low1z)-low2z);
        inz=x;
        view.setFloat64(n*8,low2,true);
      }
      state[ch*3]=low1;state[ch*3+1]=low2;state[ch*3+2]=inz;
    }
    yield output;
  }
}
/** Dynamic smoothing in pinned dblp (FILTER_SINGLE_SAMPLEFMT); timeline enable and runtime commands are refused. */
export const adynamicsmooth=defineAudioFilter<AudioDynamicSmoothStep>({
  name:'adynamicsmooth',
  examples:['adynamicsmooth','adynamicsmooth=sensitivity=2:basefreq=1000','adynamicsmooth=0:22050'],
  parse(text){
    const values={sensitivity:2,basefreq:22050};
    if(text!=='adynamicsmooth'){
      if(!text.startsWith('adynamicsmooth='))throw new AudioFilterError(`Unsupported audio filter: ${text}`);
      let named=false;
      for(const [index,option]of text.slice(15).split(':').entries()){
        const at=option.indexOf('='),name=at<0?(named?undefined:keys[index]):option.slice(0,at),value=at<0?option:option.slice(at+1);
        if(at>=0)named=true;
        if(name==='enable')throw new AudioFilterError('adynamicsmooth timeline enable is not implemented');
        if(name!=='sensitivity'&&name!=='basefreq')throw new AudioFilterError(`Unsupported adynamicsmooth option: ${option}`);
        values[name]=decimal(name,value);
      }
    }
    return Object.freeze({name:'adynamicsmooth',...values});
  },
  capabilities:()=>({generatesOutput:false,reframes:false,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['dblp'],
  stream:(step,frames,options,_configured,negotiated)=>smoothAudio(step,frames,options,negotiated),
  // One output frame plus low1, low2 and inz (three doubles) per channel.
  reserve:(_step,{channels})=>({frames:1,buffers:[],stateBytes:BigInt(channels)*24n})
});
