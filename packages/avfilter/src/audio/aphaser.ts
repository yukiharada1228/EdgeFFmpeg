import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioConversionOptions,AudioSampleFormat} from '@edge-ffmpeg/swresample';
import {AudioFilterError,defineAudioFilter,packed} from './descriptor.js';
/** AV_OPT_TYPE_DOUBLE values as native stores them; type is always WAVE_TRI (sinusoidal is refused). */
export interface AudioPhaserStep {readonly name:'aphaser';readonly inGain:number;readonly outGain:number;readonly delay:number;readonly decay:number;readonly speed:number}
type Key='in_gain'|'out_gain'|'delay'|'decay'|'speed'|'type';
type PhaserKind='s16'|'s32'|'flt'|'dbl';
/** AVOption order (positional shorthand), ranges and defaults from af_aphaser.c. */
const keys:readonly Key[]=['in_gain','out_gain','delay','decay','speed','type'];
const ranges:Readonly<Record<Exclude<Key,'type'>,readonly [number,number,string]>>={in_gain:[0,1,'[0 - 1]'],out_gain:[0,1e9,'[0 - 1e+09]'],delay:[0,5,'[0 - 5]'],decay:[0,.99,'[0 - 0.99]'],speed:[.1,2,'[0.1 - 2]']};
const kinds:Readonly<Record<string,PhaserKind>>={s16:'s16',s32:'s32',flt:'flt',dbl:'dbl'},widths:Readonly<Record<PhaserKind,number>>={s16:2,s32:4,flt:4,dbl:8};
/** int: modulation_buffer_length and the uint32 `4 * point` in ff_generate_wave_table stay exact below 2^30. */
const maximumModulation=2**30;
function invalid(message:string):never{throw new AudioFilterError(message);}
/** Parses `aphaser[=options]` by name or position, with native's range checks. Plain decimals only: native's expressions, SI suffixes and exponents are not implemented. */
function parse(text:string):AudioPhaserStep {
  const values:Record<Exclude<Key,'type'>,number>={in_gain:.4,out_gain:.74,delay:3,decay:.4,speed:.5};let named=false;
  if(text!=='aphaser'){
    if(!text.startsWith('aphaser=')||text.length===8)invalid(`Unsupported audio filter: ${text}`);
    for(const [index,option]of text.slice(8).split(':').entries()){
      const parts=option.includes('=')?option.split('='):[named?'':keys[index]??'',option];named||=option.includes('=');
      if(parts.length!==2||parts[0]==='')invalid('Invalid aphaser option');
      const [name,value]=parts as [string,string];
      if(name==='enable')invalid('aphaser timeline enable is not implemented');
      if(!(keys as readonly string[]).includes(name))invalid(`Unsupported aphaser option: ${name}`);
      if(name==='type'){
        if(value==='s'||value==='sinusoidal'||value==='0')invalid('aphaser type sinusoidal requires unimplemented libm arithmetic');
        if(value!=='t'&&value!=='triangular'&&value!=='1')invalid(`Unsupported aphaser type value: ${value}`);
        continue;
      }
      const key=name as Exclude<Key,'type'>;
      if(!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))invalid(`Only decimal aphaser ${key} values are implemented`);
      const number=Number(value),[low,high,label]=ranges[key];
      if(!(number>=low&&number<=high))invalid(`aphaser ${key} is out of range ${label}`);
      values[key]=number;
    }
  }
  const {in_gain:inGain,out_gain:outGain,delay,decay,speed}=values;
  // init()'s "out_gain may cause clipping" condition in double arithmetic. The integer kernels convert v*out_gain by C truncation, undefined out of range;
  // inside the condition every output stays within the input peak (docs/contributing/aphaser.md), so refusing it keeps every kernel defined.
  if(inGain/(1-decay)>1/outGain)invalid('aphaser in_gain/(1-decay) above 1/out_gain (out_gain may cause clipping) is not implemented');
  return Object.freeze({name:'aphaser',inGain,outGain,delay,decay,speed});
}
/** config_output: delay_buffer_length=(int)(delay*0.001*sample_rate+0.5), modulation_buffer_length=(int)(sample_rate/speed+0.5). */
export function audioPhaserLengths(step:AudioPhaserStep,sampleRate:number):{readonly delay:number;readonly modulation:number} {
  if(!Number.isSafeInteger(sampleRate)||sampleRate<1||sampleRate>2147483647)invalid('aphaser requires a valid sample rate');
  const delay=Math.trunc(step.delay*0.001*sampleRate+0.5),modulation=Math.trunc(sampleRate/step.speed+0.5);
  if(delay<=0)invalid('aphaser delay is too small');
  if(modulation<1||modulation>=maximumModulation)invalid('aphaser modulation buffer length is out of the implemented range');
  return Object.freeze({delay,modulation});
}
/** ff_generate_wave_table's phase_offset for M_PI / 2.0: (uint32_t)(phase / M_PI / 2 * table_size + 0.5). */
const phaseOffset=(size:number)=>Math.trunc((Math.PI/2.0)/Math.PI/2*size+0.5);
/** WAVE_TRI value at `point` scaled to [1, max], rounded half away from zero and truncated to int32, in the C double operations. */
function triangle(point:number,size:number,max:number):number {
  let d=point*2/size;
  // 4 * point / table_size in uint32: exact in doubles below 2^30.
  switch(Math.floor(4*point/size)){case 0:d=d+0.5;break;case 1:case 2:d=1.5-d;break;case 3:d=d-1.5;break;}
  d=d*(max-1.)+1.;d+=d<0?-0.5:0.5;
  return Math.trunc(d);
}
/** ff_generate_wave_table(WAVE_TRI, AV_SAMPLE_FMT_S32, table, size, 1., max, M_PI / 2.0) entry `index`, computed on demand instead of held. */
export const audioPhaserTriangle=(index:number,size:number,max:number):number=>triangle((index+phaseOffset(size))%size,size,max);
/** Working format: the negotiated format, which is always one of the native list. */
const kindOf=(format:AudioSampleFormat):PhaserKind=>{const kind=kinds[packed(format)];if(!kind)invalid(`aphaser cannot work in ${format}`);return kind;};
const ringBytes=(step:AudioPhaserStep,sampleRate:number,channels:number)=>BigInt(audioPhaserLengths(step,sampleRate).delay)*BigInt(channels)*8n;
/** phaser_<fmt> / phaser_<fmt>p: v = src*in_gain + buffer[MOD(delay_pos + modulation[modulation_pos], L)]*decay in double, buffer[++delay_pos] = v,
 * dst = v*out_gain converted as C does. Packed and planar kernels compute identically, so one per-channel loop serves both layouts. */
function phaser(step:AudioPhaserStep,sampleRate:number,channels:number) {
  const {delay:length,modulation:size}=audioPhaserLengths(step,sampleRate),rings=Array.from({length:channels},()=>new Float64Array(length)),{inGain,outGain,decay}=step;
  const offset=phaseOffset(size);let delayPosition=0,modulationPosition=0;
  return (planes:readonly Uint8Array[],count:number,kind:PhaserKind,planar:boolean,signal?:AbortSignal)=>{
    const width=widths[kind],stride=planar?width:width*channels;let dp=delayPosition,mp=modulationPosition;
    for(let channel=0;channel<channels;channel++){
      signal?.throwIfAborted();
      const plane=planes[planar?channel:0]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength),buffer=rings[channel]!;
      dp=delayPosition;mp=modulationPosition;
      for(let sample=0,at=planar?0:channel*width;sample<count;sample++,at+=stride){
        const input=kind==='s16'?view.getInt16(at,true):kind==='s32'?view.getInt32(at,true):kind==='flt'?view.getFloat32(at,true):view.getFloat64(at,true);
        let point=mp+offset;if(point>=size)point-=size;
        let read=dp+triangle(point,size,length);if(read>=length)read-=length;
        const v=input*inGain+buffer[read]!*decay;
        if(++mp>=size)mp-=size;
        if(++dp>=length)dp-=length;
        buffer[dp]=v;
        const out=v*outGain;
        if(kind==='s16')view.setInt16(at,Math.trunc(out),true);
        else if(kind==='s32')view.setInt32(at,Math.trunc(out),true);
        else{if(!Number.isFinite(out))invalid('Non-finite aphaser samples are not yet supported');if(kind==='flt')view.setFloat32(at,out,true);else view.setFloat64(at,out,true);}
      }
    }
    delayPosition=dp;modulationPosition=mp;
  };
}
async function* phase(step:AudioPhaserStep,frames:AsyncIterable<AudioFrameData>,options:AudioConversionOptions,negotiated:(input:AudioSampleFormat)=>AudioSampleFormat):AsyncIterable<AudioFrameData> {
  const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1)invalid('Invalid aphaser allocation limit');
  let format:{sampleRate:number;channels:number;channelLayout:string;sampleFormat:AudioSampleFormat}|null=null,run:ReturnType<typeof phaser>|null=null;
  for await(const frame of frames){
    signal?.throwIfAborted();
    if(!Number.isSafeInteger(frame.samples)||frame.samples<1||!Number.isSafeInteger(frame.channels)||frame.channels<1||!Number.isSafeInteger(frame.sampleRate)||frame.sampleRate<1)invalid('Invalid aphaser input frame');
    const target=negotiated(frame.sampleFormat as AudioSampleFormat),kind=kindOf(target);
    if(!format){
      if(ringBytes(step,frame.sampleRate,frame.channels)>BigInt(maxFrameBytes))invalid('aphaser delay buffer exceeds allocation limit');
      run=phaser(step,frame.sampleRate,frame.channels);format={sampleRate:frame.sampleRate,channels:frame.channels,channelLayout:frame.channelLayout,sampleFormat:target};
    }else if(frame.sampleRate!==format.sampleRate||frame.channels!==format.channels||frame.channelLayout!==format.channelLayout||target!==format.sampleFormat)invalid('aphaser requires a stable input format');
    const output=convertAudioFrame(frame,target,{maxFrameBytes,...(signal?{signal}:{})});
    if(kind==='flt'||kind==='dbl')for(const plane of output.planes){
      const view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength),width=widths[kind];
      for(let at=0;at<plane.byteLength;at+=width)if(!Number.isFinite(kind==='flt'?view.getFloat32(at,true):view.getFloat64(at,true)))invalid('Non-finite aphaser samples are not yet supported');
    }
    run!(output.planes,output.samples,kind,target.endsWith('p'),signal);
    yield output;
  }
}
/** Triangular-modulated phaser (libavfilter/af_aphaser.c): same length and timestamps as the input, per-channel delay rings of delay_buffer_length doubles. */
export const aphaser=defineAudioFilter<AudioPhaserStep>({
  name:'aphaser',
  examples:['aphaser','aphaser=in_gain=0.5:out_gain=0.5:delay=1.5:decay=0.6:speed=1.2:type=t','aphaser=0.3:1:5:0.5:0.1:triangular'],
  parse,
  capabilities:()=>({generatesOutput:false,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  formats:()=>['dbl','dblp','flt','fltp','s32','s32p','s16','s16p'],
  constraint:step=>format=>{audioPhaserLengths(step,format.sampleRate);},
  stream:(step,frames,options,_configured,negotiated)=>phase(step,frames,options,negotiated),
  // One output frame plus delay_buffer_length doubles per channel; the triangle table is computed per sample instead of held.
  reserve:(step,{sampleRate,channels})=>({frames:1,buffers:[],stateBytes:ringBytes(step,sampleRate,channels)})
});
