import {parseTimeDuration,rescale} from '@edge-ffmpeg/avutil';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter,frameReservation,isInteger,packed} from './descriptor.js';
/** Implemented af_afade.c curves: every one needs only + - * / and correctly rounded sqrt. */
export type AudioFadeCurve='nofade'|'tri'|'ipar'|'qua'|'cub'|'squ'|'par'|'desi'|'quat';
export interface AudioFadeStep {readonly name:'afade';readonly type:'in'|'out';readonly startSample:bigint;readonly nbSamples:bigint;readonly startTime:bigint;readonly duration:bigint;readonly curve:AudioFadeCurve;readonly silence:number;readonly unity:number}
const curves:readonly string[]=['nofade','tri','ipar','qua','cub','squ','par','desi','quat'];
/** Curves that need sin/cos/asin/acos/exp/log10/cbrt/pow: libm results are not reproduced. */
const libmCurves:readonly string[]=['qsin','esin','hsin','log','cbr','exp','iqsin','ihsin','dese','losi','sinc','isinc','quatr','qsin2','hsin2'];
/** Positional order of ff_filter_opt_parse over afade_options: one entry per offset, constants skipped. */
const positional=['type','start_sample','nb_samples','start_time','duration','curve','silence','unity'] as const;
const aliases:Readonly<Record<string,typeof positional[number]>>={type:'type',t:'type',start_sample:'start_sample',ss:'start_sample',nb_samples:'nb_samples',ns:'nb_samples',start_time:'start_time',st:'start_time',duration:'duration',d:'duration',curve:'curve',c:'curve',silence:'silence',unity:'unity'};
/** Sample counts and durations above 2^53 would need double-rounded option evaluation; refused. */
const limit=1n<<53n;
const cube=(a:number)=>a*a*a;
/** fade_gain: av_clipd(1.0*index/range,0,1), the curve, then silence+(unity-silence)*gain, unfused. */
export function afadeGain(curve:AudioFadeCurve,index:bigint,range:bigint,silence:number,unity:number):number {
  const ratio=Number(index)/Number(range);
  let gain=ratio<0?0:ratio>1?1:ratio;
  switch(curve){
    case 'ipar':gain=1-(1-gain)*(1-gain);break;
    case 'qua':gain*=gain;break;
    case 'cub':gain=cube(gain);break;
    case 'squ':gain=Math.sqrt(gain);break;
    case 'par':gain=1-Math.sqrt(1-gain);break;
    case 'desi':gain=gain<=0.5?cube(2*gain)/2:1-cube(2*(1-gain))/2;break;
    case 'quat':gain=gain*gain*gain*gain;break;
    case 'nofade':gain=1;break;
    case 'tri':break;
  }
  return silence+(unity-silence)*gain;
}
/** config_output: a nonzero duration/start_time replaces nb_samples/start_sample, av_rescale(x,rate,AV_TIME_BASE) with near-inf rounding. */
export function afadeRange(step:AudioFadeStep,sampleRate:number):{readonly start:bigint;readonly samples:bigint} {
  const micro={num:1n,den:1000000n},rate={num:1n,den:BigInt(sampleRate)};
  const samples=step.duration!==0n?rescale(step.duration,micro,rate):step.nbSamples,start=step.startTime!==0n?rescale(step.startTime,micro,rate):step.startSample;
  if(samples<=0n)throw new AudioFilterError(`afade duration rounds to zero samples at ${sampleRate} Hz`);
  if(samples>limit||start>limit)throw new AudioFilterError('afade ranges above 2^53 samples are not implemented');
  return {start,samples};
}
/** filter_frame branch for a frame starting at curSample: pass (unity==1 shortcut), silence, scale or fade. */
export function afadeBranch(step:AudioFadeStep,curSample:bigint,samples:number,start:bigint,range:bigint):'pass'|'silence'|'scale-silence'|'scale-unity'|'fade' {
  const n=BigInt(samples),out=step.type==='out';
  if(step.unity===1&&((!out&&start+range<curSample)||(out&&curSample+n<start)))return 'pass';
  if((!out&&curSample+n<start)||(out&&start+range<curSample))return step.silence===0?'silence':'scale-silence';
  if((out&&curSample+n<start)||(!out&&start+range<curSample))return 'scale-unity';
  return 'fade';
}
/** Whether samples outside the window can share a frame with it, where native's per-frame branch decides their gain:
 * before the start of a fade-in that starts after sample 0, or after the end of a fade-out. Such frames follow native demuxer and filter boundaries, which the chain does not reproduce.
 * Only the silence side differs between branches: av_samples_set_silence writes +0 where fade_samples writes s*gain (-0 for negative floats, s*unity for nofade).
 */
const outside=(step:AudioFadeStep,start:bigint)=>step.type==='out'||start>0n;
function sampleCount(text:string,name:string,minimum:bigint):bigint {
  if(!/^\d+$/.test(text))throw new AudioFilterError(`Only decimal integer afade ${name} values are implemented`);
  const value=BigInt(text);
  if(value<minimum)throw new AudioFilterError(`afade ${name} is out of range`);
  if(value>limit)throw new AudioFilterError(`afade ${name} values above 2^53 are not implemented`);
  return value;
}
function durationValue(text:string,name:string):bigint {
  let value:bigint;
  try{value=parseTimeDuration(text);}catch{throw new AudioFilterError(`Invalid afade ${name}`);}
  if(value<0n)throw new AudioFilterError(`afade ${name} is out of range`);
  if(value>limit)throw new AudioFilterError(`afade ${name} values above 2^53 microseconds are not implemented`);
  return value;
}
function gainValue(text:string,name:string):number {
  if(!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))throw new AudioFilterError(`Only constant decimal afade ${name} values are implemented`);
  const value=Number(text);
  if(!(value>=0&&value<=1))throw new AudioFilterError(`afade ${name} is out of range`);
  return value;
}
/** Owned copy of a frame in its own format; scale/fade/silence rewrite it in place. */
function rewrite(output:AudioFrameData,format:AudioSampleFormat,signal:AbortSignal|undefined,gain:(sample:number)=>number|null):void {
  const kind=packed(format),planar=format.endsWith('p'),width=kind==='s16'?2:kind==='dbl'?8:4,channels=output.channels;
  for(let plane=0;plane<output.planes.length;plane++){
    const data=output.planes[plane]!,view=new DataView(data.buffer,data.byteOffset,data.byteLength),count=data.length/width;
    for(let k=0;k<count;k++){
      if((k&4095)===0)signal?.throwIfAborted();
      const g=gain(planar?k:Math.floor(k/channels)),offset=k*width;
      if(g===null){for(let byte=0;byte<width;byte++)data[offset+byte]=0;continue;}
      if(kind==='s16')view.setInt16(offset,Math.trunc(view.getInt16(offset,true)*g),true);
      else if(kind==='s32')view.setInt32(offset,Math.trunc(view.getInt32(offset,true)*g),true);
      else{
        const value=kind==='flt'?view.getFloat32(offset,true):view.getFloat64(offset,true);
        if(!Number.isFinite(value))throw new AudioFilterError('Non-finite afade input is not implemented');
        if(kind==='flt')view.setFloat32(offset,value*g,true);else view.setFloat64(offset,value*g,true);
      }
    }
  }
}
/** Stateless fade from the frame timestamp: cur_sample = av_rescale_q(pts, time_base, 1/sample_rate). */
export const afade=defineAudioFilter<AudioFadeStep>({
  name:'afade',
  examples:['afade','afade=t=out:ss=3:ns=5','afade=in:st=0.0005:d=0.001:curve=par','afade=t=out:c=desi:silence=0.1:unity=0.9'],
  parse(text){
    const values:{type:'in'|'out';start_sample:bigint;nb_samples:bigint;start_time:bigint;duration:bigint;curve:AudioFadeCurve;silence:number;unity:number}={type:'in',start_sample:0n,nb_samples:44100n,start_time:0n,duration:0n,curve:'tri',silence:0,unity:1};
    if(text!=='afade'){
      let named=false;
      for(const [index,option]of text.slice(6).split(':').entries()){
        if(/["'\\]/.test(option))throw new AudioFilterError('Quoted or escaped afade options are not implemented');
        const equals=option.indexOf('=');
        if(equals<0&&(named||index>=positional.length))throw new AudioFilterError(`Unsupported afade option: ${option}`);
        if(equals>=0)named=true;
        const key=equals<0?positional[index]!:aliases[option.slice(0,equals)],value=equals<0?option:option.slice(equals+1);
        if(key===undefined)throw new AudioFilterError(`Unsupported afade option: ${option}`);
        if(value==='')throw new AudioFilterError(`Missing afade ${key} value`);
        if(key==='type'){if(value!=='in'&&value!=='out'&&value!=='0'&&value!=='1')throw new AudioFilterError(`Unsupported afade type: ${value}`);values.type=value==='out'||value==='1'?'out':'in';}
        else if(key==='curve'){
          if(libmCurves.includes(value))throw new AudioFilterError(`afade curve ${value} requires unimplemented libm functions`);
          if(!curves.includes(value))throw new AudioFilterError(`Unsupported afade curve: ${value}`);
          values.curve=value as AudioFadeCurve;
        }
        else if(key==='start_sample')values.start_sample=sampleCount(value,key,0n);
        else if(key==='nb_samples')values.nb_samples=sampleCount(value,key,1n);
        else if(key==='start_time'||key==='duration')values[key]=durationValue(value,key);
        else values[key]=gainValue(value,key);
      }
    }
    // Samples past the fade window in a frame that overlaps it get silence+(unity-silence)*1; whole frames get unity. They agree only when that sum rounds to unity.
    if(values.silence+(values.unity-values.silence)*1!==values.unity)throw new AudioFilterError('afade silence and unity whose full gain does not round to unity depend on native frame boundaries, which are not implemented');
    return Object.freeze({name:'afade',type:values.type,startSample:values.start_sample,nbSamples:values.nb_samples,startTime:values.start_time,duration:values.duration,curve:values.curve,silence:values.silence,unity:values.unity});
  },
  capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['s16','s16p','s32','s32p','flt','fltp','dbl','dblp'],
  constraint:step=>format=>{
    const {start}=afadeRange(step,format.sampleRate);
    if(step.curve==='nofade'&&step.silence!==step.unity&&outside(step,start))throw new AudioFilterError('afade nofade with silence outside the fade depends on native frame boundaries, which are not implemented');
  },
  apply(step,frame,target,options){
    if(frame.pts===null)throw new AudioFilterError('afade requires frame timestamps');
    const {start,samples:range}=afadeRange(step,frame.sampleRate);
    if(step.silence===0&&!isInteger(target)&&outside(step,start))throw new AudioFilterError(`afade with silence=0 on ${packed(target)} samples outside the fade depends on native frame boundaries, which are not implemented`);
    const curSample=rescale(frame.pts.value,frame.pts.timeBase,{num:1n,den:BigInt(frame.sampleRate)});
    const output=convertAudioFrame(frame,target,options),branch=afadeBranch(step,curSample,frame.samples,start,range);
    if(branch==='pass')return output;
    if(branch==='silence'){rewrite(output,target,options.signal,()=>null);return output;}
    if(branch!=='fade'){const g=branch==='scale-silence'?step.silence:step.unity;rewrite(output,target,options.signal,()=>g);return output;}
    // fade_samples: gain at start + i*dir for sample i, shared by every channel; recomputed per channel instead of buffered.
    const out=step.type==='out',first=out?start+range-curSample:curSample-start;
    rewrite(output,target,options.signal,i=>afadeGain(step.curve,out?first-BigInt(i):first+BigInt(i),range,step.silence,step.unity));
    return output;
  },
  reserve:()=>frameReservation
});
