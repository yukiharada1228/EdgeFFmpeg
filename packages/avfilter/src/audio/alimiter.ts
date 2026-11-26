import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter} from './descriptor.js';
/** Parsed alimiter options (af_alimiter.c AVOptions, native defaults and ranges). attack and release stay in milliseconds, as typed. */
export interface AudioLimiterStep {
  readonly name:'alimiter';
  readonly levelIn:number;readonly levelOut:number;readonly limit:number;readonly attack:number;readonly release:number;
  /** asc_level: accepted, without effect while asc is off. */
  readonly ascLevel:number;
  /** level: auto level, output scaled by 1/limit. */
  readonly level:boolean;
}
type Key = Exclude<keyof AudioLimiterStep,'name'>|'asc'|'latency';
const gain:[number,number]=[0.015625,64];
/** AVOption declaration order: positional values fill these, as libavfilter's shorthand does. */
const options:readonly [string,Key,'double'|'bool',number,number][]=[
  ['level_in','levelIn','double',...gain],['level_out','levelOut','double',...gain],['limit','limit','double',0.0625,1],['attack','attack','double',0.1,80],['release','release','double',1,8000],
  ['asc','asc','bool',0,1],['asc_level','ascLevel','double',0,1],['level','level','bool',0,1],['latency','latency','bool',0,1]
];
const defaults:AudioLimiterStep=Object.freeze({name:'alimiter',levelIn:1,levelOut:1,limit:1,attack:5,release:50,ascLevel:0.5,level:true});
function invalid(message:string):never{throw new AudioFilterError(message);}
function value(name:string,kind:'double'|'bool',min:number,max:number,text:string):number|boolean {
  if(kind==='bool'){
    // set_string_bool: case-insensitive names, else a whole base-10 integer; 'auto' is -1, outside [0,1].
    const lower=text.toLowerCase();
    if(['true','y','yes','enable','enabled','on'].includes(lower))return true;
    if(['false','n','no','disable','disabled','off'].includes(lower))return false;
    if(lower==='auto'||/^[+-]?\d+$/.test(text)){const parsed=lower==='auto'?-1:Number(text);if(parsed<min||parsed>max)invalid(`Unable to parse alimiter option ${name} value ${text} as boolean`);return parsed===1;}
    invalid(`Only 0, 1 and boolean names are implemented for alimiter option ${name}`);
  }
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))invalid(`Only constant decimal values are implemented for alimiter option ${name}`);
  const parsed=Number(text);
  if(!Number.isFinite(parsed)||parsed<min||parsed>max)invalid(`Value ${text} for alimiter option ${name} out of range [${min} - ${max}]`);
  return parsed===0?0:parsed;
}
/** Parses `alimiter[=options]` by name or position. asc=1 and latency=1 are refused; enable= and expressions are unimplemented. */
export function parseAudioLimiter(text:string):AudioLimiterStep {
  if(text==='alimiter')return defaults;
  if(!text.startsWith('alimiter='))invalid(`Unsupported audio filter: ${text}`);
  const step:Record<string,unknown>={...defaults};let position=0,named=false;
  for(const option of text.slice(9).split(':')){
    if(/['"\\]/.test(option))invalid('Quoted or escaped alimiter options are not implemented');
    const equals=option.indexOf('=');
    if(equals<0&&named)invalid(`No alimiter option name near ${option}`);
    if(equals>=0&&option.slice(0,equals)==='enable')invalid('alimiter timeline enable is not implemented');
    const entry=equals<0?options[position++]:options.find(([name])=>name===option.slice(0,equals));
    if(equals>=0)named=true;
    if(!entry)invalid(equals<0?`Too many alimiter option values near ${option}`:`Unsupported alimiter option: ${option.slice(0,equals)}`);
    const [name,key,kind,min,max]=entry;
    step[key]=value(name,kind,min,max,equals<0?option:option.slice(equals+1));
  }
  // asc_coeff = pow(0.5, asc_level - 0.5) feeds only the auto-release path; latency trims leading samples and pads the tail.
  if(step.asc===true)invalid('alimiter asc requires unimplemented libm arithmetic');
  if(step.latency===true)invalid('alimiter latency compensation drops leading samples, which the audio chain cannot express');
  delete step.asc;delete step.latency;
  return Object.freeze(step) as unknown as AudioLimiterStep;
}
/** config_input sizes: obuffer_size = (int)(sample_rate*channels*100/1000. + channels) array entries; buffer_size = (int)(sample_rate*attack*channels)
 * rounded down to a multiple of channels (attack in seconds). Throws for rates whose int product sample_rate*channels*100 overflows, and for buffer_size <= 0. */
export function audioLimiterSizes(step:AudioLimiterStep,sampleRate:number,channels:number):{readonly buffer:number;readonly allocated:number} {
  if(!Number.isSafeInteger(sampleRate)||sampleRate<1||sampleRate>2147483647||!Number.isSafeInteger(channels)||channels<1||channels>64)invalid('Invalid alimiter input format');
  if(sampleRate*channels*100>2147483647)invalid('alimiter sample rate and channel count overflow native buffer arithmetic');
  const allocated=Math.trunc(sampleRate*channels*100/1000.+channels);
  let buffer=Math.trunc(sampleRate*(step.attack/1000.)*channels);buffer-=buffer%channels;
  if(buffer<=0)invalid('alimiter attack is too small');
  return {buffer,allocated};
}
/** buffer and nextdelta (doubles) and nextpos (int32), each obuffer_size entries. */
export const audioLimiterStateBytes=(step:AudioLimiterStep,sampleRate:number,channels:number)=>BigInt(audioLimiterSizes(step,sampleRate,channels).allocated)*20n;
/** Lookahead peak limiter: af_alimiter.c filter_frame with asc=0 on packed doubles, its lookahead state carried across frames.
 * The output is the input delayed by buffer_size/channels samples with the same count; the delayed tail is dropped, as native does without latency. */
export const alimiter=defineAudioFilter<AudioLimiterStep>({
  name:'alimiter',
  examples:['alimiter','alimiter=limit=0.3:attack=0.5:release=1:level=0','alimiter=2:0.5:0.0625:80:8000:0:0.25:1:0'],
  parse:parseAudioLimiter,
  capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['dbl'],
  constraint:step=>format=>{audioLimiterSizes(step,format.sampleRate,format.channels);},
  async *stream(step,frames,options,_configured,negotiated){
    const {limit,levelIn,levelOut}=step,release=step.release/1000.,level=step.level?1/limit:1;
    let buffer=new Float64Array(0),nextdelta=new Float64Array(0),nextpos=new Int32Array(0),size=0,rate=0,channels=0,pos=0,att=1.,delta=0,nextiter=0,nextlen=0;
    for await(const frame of frames){
      options.signal?.throwIfAborted();
      if(size===0){
        const sizes=audioLimiterSizes(step,frame.sampleRate,frame.channels);
        if(sizes.allocated*20>options.maxFrameBytes)invalid('alimiter lookahead buffer exceeds allocation limit');
        buffer=new Float64Array(sizes.allocated);nextdelta=new Float64Array(sizes.allocated);nextpos=new Int32Array(sizes.allocated).fill(-1);
        size=sizes.buffer;rate=frame.sampleRate;channels=frame.channels;
      }else if(frame.sampleRate!==rate||frame.channels!==channels)invalid('alimiter requires a stable input format');
      const output=convertAudioFrame(frame,negotiated(frame.sampleFormat as AudioSampleFormat),options);
      if(output.sampleFormat!=='dbl')invalid(`alimiter requires dbl samples, not ${output.sampleFormat}`);
      const data=output.planes[0]!,view=new DataView(data.buffer,data.byteOffset,data.byteLength);
      for(let n=0,offset=0;n<output.samples;n++,offset+=channels*8){
        if((n&4095)===0)options.signal?.throwIfAborted();
        let peak=0;
        for(let c=0;c<channels;c++){
          const sample=view.getFloat64(offset+c*8,true)*levelIn,magnitude=Math.abs(sample);
          buffer[pos+c]=sample;peak=peak>magnitude?peak:magnitude;
        }
        if(peak>limit){
          const ratio=limit/peak,patt=ratio>1.?1.:ratio,rdelta=(1.0-patt)/(rate*release),candidate=(limit/peak-att)/size*channels;
          if(candidate<delta){
            delta=candidate;nextpos[0]=pos;nextpos[1]=-1;nextdelta[0]=rdelta;nextlen=1;nextiter=0;
          }else{
            let i=nextiter,found=false;
            for(;i<nextiter+nextlen;i++){
              const j=i%size,p=nextpos[j]!;let ppeak=0;
              if(p>=0)for(let c=0;c<channels;c++){const magnitude=Math.abs(buffer[p+c]!);ppeak=ppeak>magnitude?ppeak:magnitude;}
              // (buffer_size - nextpos[j] + pos) % buffer_size / channels is int division before the double division.
              const pdelta=(limit/peak-limit/ppeak)/Math.trunc(((size-p+pos)%size)/channels);
              if(pdelta<nextdelta[j]!){nextdelta[j]=pdelta;found=true;break;}
            }
            if(found){
              nextlen=i-nextiter+1;
              nextpos[(nextiter+nextlen)%size]=pos;nextdelta[(nextiter+nextlen)%size]=rdelta;nextpos[(nextiter+nextlen+1)%size]=-1;
              nextlen++;
            }
          }
        }
        const read=(pos+channels)%size;peak=0;
        for(let c=0;c<channels;c++){const magnitude=Math.abs(buffer[read+c]!);peak=peak>magnitude?peak:magnitude;}
        att+=delta;
        for(let c=0;c<channels;c++)view.setFloat64(offset+c*8,buffer[read+c]!*att,true);
        if(read===nextpos[nextiter]){
          delta=nextdelta[nextiter]!;att=limit/peak;
          nextlen-=1;nextpos[nextiter]=-1;nextiter=(nextiter+1)%size;
        }
        if(att>1.){att=1.;delta=0.;nextiter=0;nextlen=0;nextpos[0]=-1;}
        if(att<=0.){att=0.0000000000001;delta=(1.0-att)/(rate*release);}
        if(att!==1.&&(1.-att)<0.0000000000001)att=1.;
        if(delta!==0.&&Math.abs(delta)<0.00000000000001)delta=0.;
        for(let c=0;c<channels;c++){
          // av_clipd(x, -limit, limit) = FFMIN(FFMAX(x, -limit), limit), then * level * level_out.
          const x=view.getFloat64(offset+c*8,true),low=x>-limit?x:-limit;
          view.setFloat64(offset+c*8,(low>limit?limit:low)*level*levelOut,true);
        }
        pos=read;
      }
      yield output;
    }
  },
  // One output frame per input frame, plus buffer, nextdelta and nextpos at obuffer_size entries each.
  reserve:(step,{sampleRate,channels})=>({frames:1,buffers:[],stateBytes:audioLimiterStateBytes(step,sampleRate,channels)})
});
