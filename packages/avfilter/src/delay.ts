import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioConversionOptions,AudioSampleFormat} from '@edge-ffmpeg/swresample';
import type {AudioPadFormat} from './pad-checkpoint.js';
export class AudioDelayError extends Error {}
/** One '|' token: exact samples, a float32 seconds/milliseconds value, or a form reported only when a channel reads it. */
export type AudioDelayValue = {readonly samples:bigint}|{readonly value:number;readonly divisor:1|1000}|{readonly unsupported:string};
export interface AudioDelayStep {readonly name:'adelay';readonly delays:readonly AudioDelayValue[];readonly all:boolean}
export interface AudioDelayOptions extends AudioConversionOptions {readonly emptyInput?:AudioPadFormat}
/** Native leading-silence and flush frames hold at most 2048 samples. */
export const audioDelayPacketSamples=2048;
const widths:Readonly<Record<string,number>>={u8:1,s16:2,s32:4,flt:4,dbl:8},signed64=(1n<<63n)-1n;
function invalid(message:string):never{throw new AudioDelayError(message);}
/** Double value exactly between two floats: fround(Number(text)) may differ from direct float32 decimal rounding. */
function midpoint(value:number):boolean {
  const rounded=Math.fround(value);if(rounded===value)return false;
  const bits=new Uint32Array(new Float32Array([rounded]).buffer);bits[0]=bits[0]!+(rounded<value?1:-1);
  return value*2===rounded+new Float32Array(bits.buffer)[0]!;
}
function token(text:string):AudioDelayValue {
  if(/^\d+S$/.test(text)){const samples=BigInt(text.slice(0,-1));return samples>signed64?{unsupported:text}:{samples};}
  // Native reads an int64 and one character: only digits directly followed by 's' select seconds; 1.5s and 1.5S read as 1.5 milliseconds.
  const match=/^(\d+(?:\.\d*)?|\.\d+)([sS]?)$/.exec(text);if(!match)return {unsupported:text};
  const number=Number(match[1]);if(!Number.isFinite(number)||(match[1]!.includes('.')||number>2**53)&&midpoint(number))return {unsupported:text};
  return {value:Math.fround(number),divisor:match[2]==='s'&&/^\d+$/.test(match[1]!)?1:1000};
}
/** Parses `adelay[=delays[:all]]`. Signs, exponents, hexadecimal, infinities, NaN, trailing text, escaping and commands are unsupported. */
export function parseAudioDelay(text:string):AudioDelayStep {
  let delays:readonly AudioDelayValue[]=[],all=false,named=false;
  if(text!=='adelay')for(const [index,option]of text.slice(7).split(':').entries()){
    named||=option.includes('=');
    const parts=option.includes('=')?option.split('='):[named?'':index===0?'delays':index===1?'all':'',option];
    if(parts.length!==2)invalid('Invalid adelay option');
    const [name,value]=parts as [string,string];
    // av_strtok skips empty '|' fields.
    if(name==='delays')delays=Object.freeze(value.split('|').filter(item=>item!=='').map(item=>Object.freeze(token(item))));
    else if(name==='all'){if(!['0','1','false','true'].includes(value))invalid('Unsupported adelay all value');all=value==='1'||value==='true';}
    else invalid('Unsupported adelay option');
  }
  return Object.freeze({name:'adelay',delays,all});
}
function samples(value:AudioDelayValue,rate:number):bigint {
  if('unsupported' in value)invalid(`Unsupported adelay delay: ${value.unsupported}`);
  if('samples' in value)return value.samples;
  // config_input evaluates float delay * sample_rate / div in float32, then truncates toward zero.
  const result=Math.fround(Math.fround(value.value*Math.fround(rate))/value.divisor);
  if(!(result<2**63))invalid('adelay delay exceeds signed64 samples');
  return BigInt(Math.trunc(result));
}
/** Per-channel delays. Tokens beyond the channel count are never read; `all` repeats the last read delay; others stay zero. */
export function audioDelaySamples(step:AudioDelayStep,sampleRate:number,channels:number):readonly bigint[] {
  if(!Number.isInteger(sampleRate)||sampleRate<1||sampleRate>2147483647||!Number.isSafeInteger(channels)||channels<1||channels>1024)invalid('adelay requires a valid sample rate and channel count');
  const delays:bigint[]=Array.from({length:channels},()=>0n);let index=0;
  for(;index<channels&&index<step.delays.length;index++)delays[index]=samples(step.delays[index]!,sampleRate);
  if(step.all&&index)for(let channel=index;channel<channels;channel++)delays[channel]=delays[index-1]!;
  return Object.freeze(delays);
}
/** Common leading silence (minimum delay) and trailing flush (maximum minus minimum). */
export function audioDelayPlan(step:AudioDelayStep,sampleRate:number|undefined,channels:number|undefined):{readonly padding:bigint;readonly flush:bigint} {
  if(sampleRate===undefined||channels===undefined)invalid('adelay planning requires the input sample rate and channel count');
  const delays=audioDelaySamples(step,sampleRate,channels),padding=delays.reduce((low,delay)=>delay<low?delay:low),maximum=delays.reduce((high,delay)=>delay>high?delay:high);
  return Object.freeze({padding,flush:maximum-padding});
}
const position=(pts:AudioFrameData['pts'],rate:number):bigint|null=>{
  if(!pts)return null;const {num,den}=pts.timeBase;if(typeof pts.value!=='bigint'||typeof num!=='bigint'||typeof den!=='bigint')invalid('adelay requires sample-aligned timestamps');
  const value=pts.value*num*BigInt(rate);if(num<=0n||den<=0n||value%den!==0n)invalid('adelay requires sample-aligned timestamps');return value/den;
};
/** Per-channel delay in the planar form of the input precision. Each output frame owns new storage; inputs are never mutated.
 * Rings retain at most (delay - minimum delay) samples per channel; the common minimum is emitted as leading silence.
 */
export async function* delayAudio(frames:AsyncIterable<AudioFrameData>,step:AudioDelayStep,options:AudioDelayOptions):AsyncIterable<AudioFrameData> {
  const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1)invalid('Invalid adelay allocation limit');
  let format:Omit<AudioPadFormat,'pts'>|null=null,base='',width=0,fill=0,rings:{readonly data:Uint8Array;head:number}[]=[],padding=0n,flush=0n;
  const configure=(input:Omit<AudioPadFormat,'pts'>)=>{
    base=input.sampleFormat.endsWith('p')?input.sampleFormat.slice(0,-1):input.sampleFormat;
    if(!Object.hasOwn(widths,base))invalid('Unsupported adelay sample format');
    const delays=audioDelaySamples(step,input.sampleRate,input.channels);({padding,flush}=audioDelayPlan(step,input.sampleRate,input.channels));
    width=widths[base]!;fill=base==='u8'?128:0;
    if(delays.reduce((sum,delay)=>sum+(delay-padding)*BigInt(width),0n)>BigInt(maxFrameBytes))invalid('adelay delay buffer exceeds allocation limit');
    rings=delays.map(delay=>({data:new Uint8Array(Number(delay-padding)*width).fill(fill),head:0}));
    format={sampleRate:input.sampleRate,channels:input.channels,channelLayout:input.channelLayout,sampleFormat:`${base}p`};
  };
  const output=(count:number,pts:bigint|null)=>{
    const current=format!,bytes=count*width;if(bytes*current.channels>maxFrameBytes)invalid('adelay frame exceeds allocation limit');
    const data=new Uint8Array(bytes*current.channels);
    return {data,bytes,frame:{...current,samples:count,planes:Array.from({length:current.channels},(_,channel)=>data.subarray(channel*bytes,(channel+1)*bytes)),pts:pts===null?null:{value:pts,timeBase:{num:1n,den:BigInt(current.sampleRate)}}} as AudioFrameData};
  };
  /** Shifts one frame (or flush silence when `source` is absent) through every channel ring. */
  const shift=(count:number,pts:bigint|null,source?:AudioFrameData):AudioFrameData=>{
    const {bytes,frame}=output(count,pts);
    for(let channel=0;channel<frame.channels;channel++){
      signal?.throwIfAborted();
      const target=frame.planes[channel]!,input=source?.planes[channel],ring=rings[channel]!,size=ring.data.length;
      if(!size){if(input)target.set(input);else target.fill(fill);continue;}
      // The ring holds the newest `size` delayed bytes, oldest at head.
      const fromRing=Math.min(bytes,size),first=Math.min(fromRing,size-ring.head);
      target.set(ring.data.subarray(ring.head,ring.head+first));target.set(ring.data.subarray(0,fromRing-first),first);
      if(bytes>fromRing){if(input)target.set(input.subarray(0,bytes-fromRing),fromRing);else target.fill(fill,fromRing);}
      if(bytes>=size){if(input)ring.data.set(input.subarray(bytes-size));else ring.data.fill(fill);ring.head=0;}
      else{const tail=Math.min(bytes,size-ring.head);if(input){ring.data.set(input.subarray(0,tail),ring.head);ring.data.set(input.subarray(tail),0);}else{ring.data.fill(fill,ring.head,ring.head+tail);ring.data.fill(fill,0,bytes-tail);}ring.head=(ring.head+bytes)%size;}
    }
    return frame;
  };
  function* silence(total:bigint,start:bigint|null,delayed:boolean):Generator<AudioFrameData,void,unknown> {
    for(let done=0n;done<total;){
      const count=Number(total-done<BigInt(audioDelayPacketSamples)?total-done:BigInt(audioDelayPacketSamples)),pts=start===null?null:start+done;
      if(delayed)yield shift(count,pts);else{const {data,frame}=output(count,pts);data.fill(fill);yield frame;}
      done+=BigInt(count);
    }
  }
  let next:bigint|null=null,seen=false;
  for await(const input of frames){
    signal?.throwIfAborted();
    const planar=input.sampleFormat.endsWith('p'),kind=planar?input.sampleFormat.slice(0,-1):input.sampleFormat;
    if(!Object.hasOwn(widths,kind)||!Number.isSafeInteger(input.samples)||input.samples<1||!Number.isSafeInteger(input.channels)||input.channels<1||!Number.isSafeInteger(input.sampleRate)||input.sampleRate<1||!Array.isArray(input.planes)||input.planes.length!==(planar?input.channels:1))invalid('Invalid adelay input frame');
    if(planar)for(const plane of input.planes)if(!(plane instanceof Uint8Array)||plane.length!==input.samples*widths[kind]!)invalid('Invalid adelay input plane');
    const at=position(input.pts,input.sampleRate);
    if(!seen){configure(input);seen=true;yield* silence(padding,at,false);}
    else if(input.sampleRate!==format!.sampleRate||input.channels!==format!.channels||input.channelLayout!==format!.channelLayout||kind!==base)invalid('adelay requires a stable input format');
    // Native output pts is input pts + leading silence; the flush continues after the last input frame.
    yield shift(input.samples,at===null?null:at+padding,planar?input:convertAudioFrame(input,`${kind}p` as AudioSampleFormat,{maxFrameBytes,...(signal?{signal}:{})}));
    next=at===null?null:at+BigInt(input.samples);
  }
  if(!seen){
    const empty=options.emptyInput;if(!empty)invalid('adelay requires a configured empty input format');
    configure(empty);next=position(empty.pts,empty.sampleRate);yield* silence(padding,next,false);
  }
  yield* silence(flush,next===null?null:next+padding,true);
}
