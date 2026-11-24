import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioConversionOptions,AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter} from './descriptor.js';
export interface AudioCompensationDelayStep {readonly name:'compensationdelay';readonly mm:number;readonly cm:number;readonly m:number;readonly dry:number;readonly wet:number;readonly temp:number}
type Key = 'mm'|'cm'|'m'|'dry'|'wet'|'temp';
/** AVOption order (positional shorthand) and ranges from af_compensationdelay.c. */
const keys:readonly Key[]=['mm','cm','m','dry','wet','temp'],ranges:Readonly<Record<Key,readonly [number,number]>>={mm:[0,10],cm:[0,100],m:[0,100],dry:[0,1],wet:[0,1],temp:[-50,50]};
function invalid(message:string):never{throw new AudioFilterError(message);}
/** Parses `compensationdelay[=options]`: decimal integers for mm/cm/m/temp, plain decimals for dry/wet; expressions, enable and commands are unsupported. */
function parse(text:string):AudioCompensationDelayStep {
  const values:Record<Key,number>={mm:0,cm:0,m:0,dry:0,wet:1,temp:20};let named=false;
  if(text!=='compensationdelay'){
    if(!text.startsWith('compensationdelay='))invalid(`Unsupported audio filter: ${text}`);
    for(const [index,option]of text.slice(18).split(':').entries()){
      const parts=option.includes('=')?option.split('='):[named?'':keys[index]??'',option];named||=option.includes('=');
      if(parts.length!==2)invalid('Invalid compensationdelay option');
      const [name,value]=parts as [string,string];
      if(name==='enable')invalid('compensationdelay timeline enable is not implemented');
      if(!(keys as readonly string[]).includes(name))invalid(name===''?'Invalid compensationdelay option':`Unsupported compensationdelay option: ${name}`);
      const key=name as Key,integer=key!=='dry'&&key!=='wet';
      if(!(integer?/^-?\d+$/:/^(?:\d+(?:\.\d*)?|\.\d+)$/).test(value))invalid(`Unsupported compensationdelay ${key} value: ${value}`);
      const number=Number(value),[low,high]=ranges[key];
      if(!(number>=low&&number<=high))invalid(`compensationdelay ${key} is out of range [${low} - ${high}]`);
      values[key]=number===0?0:number;
    }
  }
  return Object.freeze({name:'compensationdelay',...values});
}
/** COMP_DELAY_SOUND_FRONT_DELAY(temp) in the macro's evaluation order. */
export function compensationDelayFront(temp:number):number {
  const speed=1.85325*(643.95*Math.sqrt((temp+273.15)/273.15));
  return 1.0/(speed*(1000.0*100.0)/(60.0*60.0));
}
/** config_input: (unsigned)((m*100. + cm*1. + mm*.1) * COMP_DELAY_SOUND_FRONT_DELAY(temp) * sample_rate). */
export function compensationDelaySamples(step:AudioCompensationDelayStep,sampleRate:number):number {
  if(!Number.isSafeInteger(sampleRate)||sampleRate<1||sampleRate>2147483647)invalid('compensationdelay requires a valid sample rate');
  return Math.trunc((step.m*100.+step.cm*1.+step.mm*.1)*compensationDelayFront(step.temp)*sampleRate);
}
/** config_input's buf_size: the smallest power of two >= (unsigned)(sample_rate * COMP_DELAY_MAX_DELAY), where
 * COMP_DELAY_MAX_DELAY uses the 50 degree (shortest) front delay. */
export function compensationDelayBufferSize(sampleRate:number):number {
  const minimum=Math.trunc(sampleRate*((100.0*100.0+100.0*1.0+1.0)*compensationDelayFront(50)));
  let size=1;while(size<minimum)size*=2;
  return size;
}
/** filter_frame reads (w_ptr + buf_size - delay) & (buf_size - 1) in unsigned arithmetic, so the delay that reaches the
 * output is delay mod buf_size: colder temperatures at rates where sample_rate * COMP_DELAY_MAX_DELAY lies just below a
 * power of two (25000 and 50000 Hz, for example) wrap. */
export function compensationDelayEffectiveSamples(step:AudioCompensationDelayStep,sampleRate:number):number {
  return compensationDelaySamples(step,sampleRate)%compensationDelayBufferSize(sampleRate);
}
/** Ring bytes: effective delay + 1 doubles per channel reproduce native's power-of-two ring (write before read, so delay 0 reads the current sample). */
const ringBytes=(step:AudioCompensationDelayStep,sampleRate:number,channels:number)=>BigInt(compensationDelayEffectiveSamples(step,sampleRate)+1)*BigInt(channels)*8n;
async function* compensate(step:AudioCompensationDelayStep,frames:AsyncIterable<AudioFrameData>,options:AudioConversionOptions,negotiated:(input:AudioSampleFormat)=>AudioSampleFormat):AsyncIterable<AudioFrameData> {
  const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1)invalid('Invalid compensationdelay allocation limit');
  let rings:Float64Array[]=[],size=0,write=0,format:{sampleRate:number;channels:number;channelLayout:string}|null=null;
  const {dry,wet}=step;
  for await(const frame of frames){
    signal?.throwIfAborted();
    if(!Number.isSafeInteger(frame.samples)||frame.samples<0||!Number.isSafeInteger(frame.channels)||frame.channels<1)invalid('Invalid compensationdelay input frame');
    if(!format){
      if(ringBytes(step,frame.sampleRate,frame.channels)>BigInt(maxFrameBytes))invalid('compensationdelay delay buffer exceeds allocation limit');
      size=compensationDelayEffectiveSamples(step,frame.sampleRate)+1;rings=Array.from({length:frame.channels},()=>new Float64Array(size));
      format={sampleRate:frame.sampleRate,channels:frame.channels,channelLayout:frame.channelLayout};
    }else if(frame.sampleRate!==format.sampleRate||frame.channels!==format.channels||frame.channelLayout!==format.channelLayout)invalid('compensationdelay requires a stable input format');
    const target=negotiated(frame.sampleFormat as AudioSampleFormat);if(target!=='dblp')invalid(`compensationdelay cannot work in ${target}`);
    const input=convertAudioFrame(frame,'dblp',{maxFrameBytes,...(signal?{signal}:{})}),bytes=frame.samples*8;
    if(bytes*frame.channels>maxFrameBytes)invalid('compensationdelay frame exceeds allocation limit');
    const data=new Uint8Array(bytes*frame.channels),planes:Uint8Array[]=[];let next=write;
    for(let channel=0;channel<frame.channels;channel++){
      signal?.throwIfAborted();
      const plane=input.planes[channel]!,source=new Float64Array(plane.buffer.slice(plane.byteOffset,plane.byteOffset+bytes)),out=data.subarray(channel*bytes,(channel+1)*bytes),dst=new Float64Array(out.buffer,out.byteOffset,frame.samples),buffer=rings[channel]!;
      // native: buffer[w] = x; dst = dry*x + wet*buffer[r]; r = (w + buf_size - delay) & mask, which is w+1 for an effective delay+1 ring.
      let w=write,r=w+1===size?0:w+1;
      for(let n=0;n<frame.samples;n++){const sample=source[n]!;buffer[w]=sample;dst[n]=dry*sample+wet*buffer[r]!;w=w+1===size?0:w+1;r=r+1===size?0:r+1;}
      next=w;planes.push(out);
    }
    write=next;
    yield {...frame,sampleFormat:'dblp',planes};
  }
}
/** Distance-based delay line in pinned dblp: dry*x + wet*x[n-delay], same length and timestamps as the input. */
export const compensationdelay=defineAudioFilter<AudioCompensationDelayStep>({
  name:'compensationdelay',
  examples:['compensationdelay','compensationdelay=cm=33:mm=7:dry=0.3:wet=0.6','compensationdelay=5:3:1:1:1:-50'],
  parse,
  capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['dblp'],
  stream:(step,frames,options,_configured,negotiated)=>compensate(step,frames,options,negotiated),
  // One output frame plus the per-channel ring of effective delay+1 doubles.
  reserve:(step,{sampleRate,channels})=>({frames:1,buffers:[],stateBytes:ringBytes(step,sampleRate,channels)})
});
