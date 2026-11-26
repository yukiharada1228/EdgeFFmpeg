import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter,packed} from './descriptor.js';
import {BiquadNonFiniteError,biquadCacheBytes,biquadKernel,normalizeBiquad,prepareBiquad} from './biquad-kernels.js';
import type {BiquadCoefficients,BiquadKernel,BiquadKind,BiquadPlane,BiquadTransform,BiquadTriple} from './biquad-kernels.js';
export type BiquadPrecision='auto'|'s16'|'s32'|'f32'|'f64';
/** a and b are the raw option values (oa/ob); coefficients are the prepared doubles config_filter() leaves in a_double/b_double. */
export interface AudioBiquadStep {readonly name:'biquad';readonly a:BiquadTriple;readonly b:BiquadTriple;readonly mix:number;readonly normalize:boolean;readonly transform:BiquadTransform;readonly precision:BiquadPrecision;readonly coefficients:BiquadCoefficients}
/** Shorthand order of biquad_options (aliases share an offset and are skipped). */
const positional=['a0','a1','a2','b0','b1','b2','mix','channels','normalize','transform','precision','blocksize'] as const;
const aliases:Readonly<Record<string,typeof positional[number]>>={m:'mix',c:'channels',n:'normalize',a:'transform',r:'precision',b:'blocksize'};
const transforms:readonly string[]=['di','dii','tdi','tdii','latt','svf','zdf'],precisions:readonly BiquadPrecision[]=['s16','s32','f32','f64'];
const decimal=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const pinned:Readonly<Record<BiquadPrecision,readonly AudioSampleFormat[]>>={auto:['s16p','s32p','fltp','dblp'],s16:['s16p'],s32:['s32p'],f32:['fltp'],f64:['dblp']};
const kinds:Readonly<Record<string,BiquadKind>>={s16:'s16',s32:'s32',flt:'flt',dbl:'dbl'};
const littleEndian=new Uint8Array(new Uint16Array([1]).buffer)[0]===1;
function invalid(message:string):never{throw new AudioFilterError(message);}
function number(name:string,text:string,low:number,high:number):number {
  if(!decimal.test(text))invalid(`Only constant decimal biquad ${name} values are implemented`);
  const value=Number(text);if(!(value>=low&&value<=high))invalid(`biquad ${name} is out of range [${low}, ${high}]`);
  return value;
}
/** Second-order stability triangle |a2| < 1, |a1| < 1 + a2 for normalised direct-form denominators, checked in double and after the float copy. */
const stable=(a1:number,a2:number)=>[[a1,a2],[Math.fround(a1),Math.fround(a2)]].every(([p,q])=>Math.abs(q!)<1&&Math.abs(p!)<1+q!);
/** The zdf state update with raw a: [b0,b1] <- M [b0,b1] + input terms, M = [[2a0-1, -2a1], [2a1, 1-2a2]]; stable when its trace and determinant satisfy the same triangle. */
function zdfStable(a:BiquadTriple):boolean {
  return [a,a.map(Math.fround) as unknown as BiquadTriple].every(([a0,a1,a2])=>{const m00=2*a0-1,m01=-2*a1,m10=2*a1,m11=1-2*a2,trace=m00+m11,det=m00*m11-m01*m10;return Math.abs(det)<1&&Math.abs(trace)<1+det;});
}
/** Parses `biquad=a0=..:a1=..:...` (named, or positional in biquad_options order) with native ranges, then refuses the forms that are not implemented. */
export function parseAudioBiquad(text:string):AudioBiquadStep {
  if(text!=='biquad'&&!text.startsWith('biquad='))invalid(`Unsupported audio filter: ${text}`);
  const values:Record<string,string>={};let named=false;
  if(text!=='biquad')for(const [index,option]of text.slice(7).split(':').entries()){
    const separator=option.indexOf('=');let key:string,value:string;
    if(separator<0){if(named||index>=positional.length)invalid('Invalid biquad option');key=positional[index]!;value=option;}
    else{named=true;key=option.slice(0,separator);value=option.slice(separator+1);}
    if(key==='enable')invalid('biquad timeline enable is not implemented');
    key=aliases[key]??key;
    if(!(positional as readonly string[]).includes(key))invalid(`Unsupported biquad option: ${key}`);
    values[key]=value;
  }
  const coefficient=(name:string,fallback:number)=>values[name]===undefined?fallback:number(name,values[name],-2147483648,2147483647);
  const a:BiquadTriple=[coefficient('a0',1),coefficient('a1',0),coefficient('a2',0)],b:BiquadTriple=[coefficient('b0',0),coefficient('b1',0),coefficient('b2',0)];
  const mix=values.mix===undefined?1:number('mix',values.mix,0,1);
  const channels=values.channels??'all';if(channels!=='all')invalid('biquad channels other than all are not implemented');
  const flag=values.normalize??'0';if(!['0','1','true','false'].includes(flag))invalid(`Unsupported biquad normalize value: ${flag}`);
  const normalize=flag==='1'||flag==='true';
  const transformText=values.transform??'di',transform=/^\d$/.test(transformText)?transforms[Number(transformText)]:transforms.includes(transformText)?transformText:undefined;
  if(transform===undefined)invalid(`Unsupported biquad transform: ${transformText}`);
  const precisionText=values.precision??'auto',precision=/^-?\d$/.test(precisionText)?(precisionText==='-1'?'auto':precisions[Number(precisionText)]):precisionText==='auto'||(precisions as readonly string[]).includes(precisionText)?precisionText as BiquadPrecision:undefined;
  if(precision===undefined)invalid(`Unsupported biquad precision: ${precisionText}`);
  const block=values.blocksize??'0';if(!/^\d+$/.test(block))invalid(`Only constant integer biquad blocksize values are implemented`);
  if(Number(block)>32768)invalid('biquad blocksize is out of range [0, 32768]');
  if(Number(block)>0)invalid('biquad blocksize is not implemented');
  if(transform==='di')invalid('biquad transform di depends on native frame boundaries, which are not implemented');
  if(a[0]===0)invalid('biquad a0 must not be zero');
  const direct=normalizeBiquad(a,b,normalize),coefficients=prepareBiquad(a,b,normalize,transform as BiquadTransform);
  if(![...direct.a,...direct.b,...coefficients.a,...coefficients.b].every(value=>Number.isFinite(value)&&Number.isFinite(Math.fround(value))))invalid('biquad coefficients exceed the float range');
  if(!stable(direct.a[1],direct.a[2])||(transform==='zdf'&&!zdfStable(a)))invalid('biquad coefficients outside the stability triangle are not implemented');
  return Object.freeze({name:'biquad',a,b,mix,normalize,transform:transform as BiquadTransform,precision,coefficients});
}
const typed=(kind:BiquadKind,plane:Uint8Array):BiquadPlane=>{
  const width=kind==='s16'?2:kind==='dbl'?8:4,length=plane.byteLength/width;
  return kind==='s16'?new Int16Array(plane.buffer,plane.byteOffset,length):kind==='s32'?new Int32Array(plane.buffer,plane.byteOffset,length):kind==='flt'?new Float32Array(plane.buffer,plane.byteOffset,length):new Float64Array(plane.buffer,plane.byteOffset,length);
};
/** Filters every frame in its negotiated planar format with one kernel and a 4-value cache per channel carried across frames (filter_channel without blocksize). */
async function* biquadAudio(step:AudioBiquadStep,frames:AsyncIterable<AudioFrameData>,options:{readonly maxFrameBytes:number;readonly signal?:AbortSignal|undefined},negotiated:(input:AudioSampleFormat)=>AudioSampleFormat):AsyncIterable<AudioFrameData> {
  const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1)invalid('Invalid biquad allocation limit');
  if(!littleEndian)invalid('biquad requires a little-endian host');
  let format:{readonly sampleRate:number;readonly channels:number;readonly channelLayout:string;readonly sampleFormat:AudioSampleFormat}|null=null,kind:BiquadKind='s16',kernel:BiquadKernel|null=null,caches:Float64Array[]=[];
  for await(const frame of frames){
    signal?.throwIfAborted();
    if(!Number.isSafeInteger(frame.samples)||frame.samples<1||!Number.isSafeInteger(frame.channels)||frame.channels<1||!Number.isSafeInteger(frame.sampleRate)||frame.sampleRate<1)invalid('Invalid biquad input frame');
    const target=negotiated(frame.sampleFormat as AudioSampleFormat);
    if(!format){
      const resolved=target.endsWith('p')?kinds[packed(target)]:undefined;
      if(!resolved||!pinned[step.precision].includes(target))invalid(`biquad cannot run in ${target}`);
      if(frame.channels*biquadCacheBytes>maxFrameBytes)invalid('biquad state exceeds allocation limit');
      kind=resolved;kernel=biquadKernel(step.transform,kind,step.coefficients,step.mix);caches=Array.from({length:frame.channels},()=>new Float64Array(4));
      format={sampleRate:frame.sampleRate,channels:frame.channels,channelLayout:frame.channelLayout,sampleFormat:target};
    }else if(frame.sampleRate!==format.sampleRate||frame.channels!==format.channels||frame.channelLayout!==format.channelLayout||target!==format.sampleFormat)invalid('biquad requires a stable input format');
    const output=convertAudioFrame(frame,target,{maxFrameBytes,...(signal?{signal}:{})});
    if(output.planes.length!==output.channels)invalid('biquad requires planar frames');
    const planes=output.planes.slice();
    for(let channel=0;channel<output.channels;channel++){
      signal?.throwIfAborted();
      let plane=planes[channel]!;
      if(plane.byteOffset%(kind==='s16'?2:kind==='dbl'?8:4)!==0){plane=plane.slice();planes[channel]=plane;}
      const samples=typed(kind,plane);
      if((kind==='flt'||kind==='dbl')&&!samples.every(Number.isFinite))invalid('Non-finite biquad input is not implemented');
      try{kernel!(samples,samples,output.samples,caches[channel]!);}
      catch(error){if(error instanceof BiquadNonFiniteError)invalid(error.message);throw error;}
    }
    yield {...output,planes};
  }
}
/** Explicit-coefficient biquad (libavfilter/af_biquads.c, filter type biquad) for the dii, tdi, tdii, latt, svf and zdf transforms. */
export const biquad=defineAudioFilter<AudioBiquadStep>({
  name:'biquad',
  examples:['biquad=a0=1:a1=-1.1:a2=0.3:b0=0.05:b1=0.1:b2=0.05:a=dii','biquad=b0=0.5:b1=0.3:a1=-0.5:a2=0.2:transform=tdii:precision=s16','biquad=1:-0.9:0.2:0.3:0.2:0.1:0.5:all:1:latt:f64','biquad=a1=0.4:a2=0.3:b0=0.4:b1=-0.2:b2=0.1:a=svf:r=s32:m=0.7','biquad=a0=0.5:a1=0.1:a2=0.2:b0=0.3:b1=0.2:b2=0.1:a=zdf:r=f32','biquad=a1=-0.5:b0=0.25:b1=0.25:a=tdi:n=1'],
  parse:parseAudioBiquad,
  capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:step=>pinned[step.precision],
  stream:(step,frames,options,_configured,negotiated)=>biquadAudio(step,frames,options,negotiated),
  // One output frame per input frame plus the per-channel cache of 4 doubles.
  reserve:(_step,{channels})=>({frames:1,buffers:[],stateBytes:BigInt(channels*biquadCacheBytes)})
});
