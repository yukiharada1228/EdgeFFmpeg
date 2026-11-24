import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {convertAudioFrame} from '@edge-ffmpeg/swresample';
import type {AudioSampleFormat} from '@edge-ffmpeg/swresample';
import type {AudioPadFormat} from '../pad-checkpoint.js';
import {AudioFilterError,defineAudioFilter} from './descriptor.js';
/** Gains are float32 option values; delays (ms) and decays are float32 sscanf('%f') values in tap order. */
export interface AudioEchoStep {readonly name:'aecho';readonly inGain:number;readonly outGain:number;readonly delays:readonly number[];readonly decays:readonly number[]}
/** Native tail frames (request_frame) hold at most 2048 samples. */
export const audioEchoPacketSamples=2048;
type EchoKind='s16'|'s32'|'flt'|'dbl';
const working:Readonly<Record<string,EchoKind>>={u8:'s16',s16:'s16',s32:'s32',flt:'flt',dbl:'dbl'},widths:Readonly<Record<EchoKind,number>>={s16:2,s32:4,flt:4,dbl:8};
const limits:Readonly<Record<EchoKind,readonly [number,number]>>={s16:[-32768,32767],s32:[-2147483648,2147483647],flt:[-1,1],dbl:[-1,1]};
const decimal=/^(?:\d+(?:\.\d*)?|\.\d+)$/;
function invalid(message:string):never{throw new AudioFilterError(message);}
/** Double value exactly between two floats: fround(Number(text)) may differ from direct float32 decimal rounding (sscanf '%f'). */
function midpoint(value:number):boolean {
  const rounded=Math.fround(value);if(rounded===value)return false;
  const bits=new Uint32Array(new Float32Array([rounded]).buffer);bits[0]=bits[0]!+(rounded<value?1:-1);
  return value*2===rounded+new Float32Array(bits.buffer)[0]!;
}
/** AV_OPT_TYPE_FLOAT in [0,1]: the double is range-checked, then stored as float. Expressions and SI suffixes are unimplemented. */
function gain(name:string,text:string):number {
  if(!decimal.test(text))invalid(`Only decimal aecho ${name} values are implemented`);
  const value=Number(text);if(!(value>=0&&value<=1))invalid(`aecho ${name} is out of range [0, 1]`);
  return Math.fround(value);
}
/** fill_items: av_strtok skips empty '|' fields; every read token must be a plain decimal (signs, exponents, hex, inf/nan and trailing text are unimplemented). */
function list(name:string,text:string):readonly number[] {
  return Object.freeze(text.split('|').filter(item=>item!=='').map(item=>{
    const value=Number(item);if(!decimal.test(item)||!Number.isFinite(value)||midpoint(value))invalid(`Unsupported aecho ${name} value: ${item}`);
    return Math.fround(value);
  }));
}
/** Parses `aecho[=in_gain:out_gain:delays:decays]` positionally or by name, with init()'s count and range checks. */
export function parseAudioEcho(text:string):AudioEchoStep {
  if(text!=='aecho'&&!text.startsWith('aecho='))invalid(`Unsupported audio filter: ${text}`);
  const names=['in_gain','out_gain','delays','decays'],values:Record<string,string>={in_gain:'0.6',out_gain:'0.3',delays:'1000',decays:'0.5'};let named=false;
  if(text!=='aecho')for(const [index,option]of text.slice(6).split(':').entries()){
    named||=option.includes('=');
    const parts=option.includes('=')?option.split('='):[named?'':names[index]??'',option];
    if(parts.length!==2||parts[0]==='')invalid('Invalid aecho option');
    const [name,value]=parts as [string,string];
    if(!names.includes(name))invalid(`Unsupported aecho option: ${name}`);
    values[name]=value;
  }
  const inGain=gain('in_gain',values.in_gain!),outGain=gain('out_gain',values.out_gain!),delays=list('delays',values.delays!),decays=list('decays',values.decays!);
  if(delays.length!==decays.length)invalid(`Number of aecho delays ${delays.length} differs from number of decays ${decays.length}`);
  if(!delays.length)invalid('aecho requires at least one delay and decay');
  for(const [index,delay]of delays.entries()){
    if(!(delay>0&&delay<=90000))invalid(`aecho delay[${index}] is out of allowed range (0, 90000]`);
    if(!(decays[index]!>0&&decays[index]!<=1))invalid(`aecho decay[${index}] is out of allowed range (0, 1]`);
  }
  return Object.freeze({name:'aecho',inGain,outGain,delays,decays});
}
/** config_output: samples[i] = (int)(float(delay * sample_rate) / 1000.0); max_samples starts at 0 and must end positive. */
export function audioEchoSamples(step:AudioEchoStep,sampleRate:number|undefined):{readonly samples:readonly number[];readonly maximum:number} {
  if(sampleRate===undefined||!Number.isInteger(sampleRate)||sampleRate<1||sampleRate>2147483647)invalid('aecho requires a valid sample rate');
  const samples=step.delays.map(delay=>{const value=Math.trunc(Math.fround(delay*Math.fround(sampleRate))/1000);if(value>2147483647)invalid('aecho delay exceeds int samples');return value;});
  const maximum=samples.reduce((high,value)=>value>high?value:high,0);
  if(maximum<=0)invalid('aecho has nothing to echo: missing delay samples');
  return Object.freeze({samples:Object.freeze(samples),maximum});
}
/** Working format for an arriving sample format: the native pick from {s16p,s32p,fltp,dblp}. */
export const audioEchoFormat=(format:string):AudioSampleFormat=>{const kind=working[format.endsWith('p')?format.slice(0,-1):format];if(!kind)invalid('Unsupported aecho sample format');return `${kind}p`;};
/** echo_samples_<fmt>p: in*in_gain plus each tap's dbuf*decay (float product for float and integer types, double for dbl), times out_gain, av_clipd, C conversion. */
function echoer(step:AudioEchoStep,kind:EchoKind,samples:readonly number[],maximum:number,channels:number) {
  const width=widths[kind],[low,high]=limits[kind],rings=Array.from({length:channels},()=>kind==='s16'?new Int16Array(maximum):kind==='s32'?new Int32Array(maximum):kind==='flt'?new Float32Array(maximum):new Float64Array(maximum)),offsets=samples.map(value=>maximum-value);
  const decays=step.decays,taps=decays.length,inGain=step.inGain,outGain=step.outGain;let position=0;
  const read=kind==='s16'?(view:DataView,at:number)=>view.getInt16(at,true):kind==='s32'?(view:DataView,at:number)=>view.getInt32(at,true):kind==='flt'?(view:DataView,at:number)=>view.getFloat32(at,true):(view:DataView,at:number)=>view.getFloat64(at,true);
  const write=kind==='s16'?(view:DataView,at:number,value:number)=>view.setInt16(at,Math.trunc(value),true):kind==='s32'?(view:DataView,at:number,value:number)=>view.setInt32(at,Math.trunc(value),true):kind==='flt'?(view:DataView,at:number,value:number)=>view.setFloat32(at,value,true):(view:DataView,at:number,value:number)=>view.setFloat64(at,value,true);
  // dbuf holds the input type (dbuf[index] = in is exact); an s32 tap converts the int to float before the float multiply.
  const tap=kind==='dbl'?(value:number,decay:number)=>value*decay:kind==='s32'?(value:number,decay:number)=>Math.fround(Math.fround(value)*decay):(value:number,decay:number)=>Math.fround(value*decay);
  /** Processes planar planes in place; every channel starts at the shared delay_index. */
  return (planes:readonly Uint8Array[],count:number,signal?:AbortSignal)=>{
    let index=position;
    for(let channel=0;channel<channels;channel++){
      signal?.throwIfAborted();
      const plane=planes[channel]!,view=new DataView(plane.buffer,plane.byteOffset,plane.byteLength),ring=rings[channel]!;index=position;
      for(let sample=0;sample<count;sample++){
        const input=read(view,sample*width);let out=input*inGain;
        for(let j=0;j<taps;j++){let at=index+offsets[j]!;if(at>=maximum)at-=maximum;out+=tap(ring[at]!,decays[j]!);}
        out*=outGain;const clipped=out>low?out:low;
        write(view,sample*width,clipped>high?high:clipped);ring[index]=input;
        if(++index>=maximum)index-=maximum;
      }
    }
    position=index;
  };
}
const timestamp=(pts:AudioFrameData['pts'],rate:number):bigint|null=>{
  if(!pts)return null;const {num,den}=pts.timeBase;if(typeof pts.value!=='bigint'||typeof num!=='bigint'||typeof den!=='bigint')invalid('aecho requires sample-aligned timestamps');
  const value=pts.value*num*BigInt(rate);if(num<=0n||den<=0n||value%den!==0n)invalid('aecho requires sample-aligned timestamps');return value/den;
};
/** Echoes each frame in its negotiated planar format (one owned output frame per input frame), then emits max_samples of tail fed with silence in 2048-sample frames. */
async function* echoAudio(step:AudioEchoStep,frames:AsyncIterable<AudioFrameData>,options:{readonly maxFrameBytes:number;readonly signal?:AbortSignal|undefined},configured:AudioPadFormat|undefined,negotiated:(input:AudioSampleFormat)=>AudioSampleFormat):AsyncIterable<AudioFrameData> {
  const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
  if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1)invalid('Invalid aecho allocation limit');
  let format=null as Omit<AudioPadFormat,'pts'>|null,kind:EchoKind='s16',maximum=0,run:ReturnType<typeof echoer>|null=null,next:bigint|null=null;
  const configure=(input:Omit<AudioPadFormat,'pts'>,target:AudioSampleFormat)=>{
    const resolved=working[target.endsWith('p')?target.slice(0,-1):target];if(!resolved||target!==`${resolved}p`)invalid(`aecho cannot run in ${target}`);
    kind=resolved;const plan=audioEchoSamples(step,input.sampleRate);maximum=plan.maximum;
    if(maximum*input.channels*widths[kind]>maxFrameBytes)invalid('aecho delay buffer exceeds allocation limit');
    run=echoer(step,kind,plan.samples,maximum,input.channels);format={sampleRate:input.sampleRate,channels:input.channels,channelLayout:input.channelLayout,sampleFormat:target};
  };
  for await(const frame of frames){
    signal?.throwIfAborted();
    if(!Number.isSafeInteger(frame.samples)||frame.samples<1||!Number.isSafeInteger(frame.channels)||frame.channels<1||!Number.isSafeInteger(frame.sampleRate)||frame.sampleRate<1)invalid('Invalid aecho input frame');
    const target=negotiated(frame.sampleFormat as AudioSampleFormat);
    const active=format as Omit<AudioPadFormat,'pts'>|null;
    if(!active)configure(frame,target);
    else if(frame.sampleRate!==active.sampleRate||frame.channels!==active.channels||frame.channelLayout!==active.channelLayout||target!==active.sampleFormat)invalid('aecho requires a stable input format');
    const at=timestamp(frame.pts,frame.sampleRate),output=convertAudioFrame(frame,target,{maxFrameBytes,...(signal?{signal}:{})});
    run!(output.planes,output.samples,signal);
    next=at===null?null:at+BigInt(frame.samples);
    yield {...output,pts:at===null?null:{value:at,timeBase:{num:1n,den:BigInt(frame.sampleRate)}}};
  }
  if(!format){
    if(!configured)invalid('aecho requires a configured empty input format');
    configure(configured,negotiated(configured.sampleFormat as AudioSampleFormat));next=timestamp(configured.pts,configured.sampleRate);
  }
  const current=(format as Omit<AudioPadFormat,'pts'>|null)!,width=widths[kind];
  for(let fade=maximum;fade>0;){
    signal?.throwIfAborted();
    const count=Math.min(fade,audioEchoPacketSamples),bytes=count*width;fade-=count;
    if(bytes*current.channels>maxFrameBytes)invalid('aecho frame exceeds allocation limit');
    const data=new Uint8Array(bytes*current.channels),planes=Array.from({length:current.channels},(_,channel)=>data.subarray(channel*bytes,(channel+1)*bytes));
    run!(planes,count,signal);
    yield {...current,samples:count,planes,pts:next===null?null:{value:next,timeBase:{num:1n,den:BigInt(current.sampleRate)}}};
    if(next!==null)next+=BigInt(count);
  }
}
/** Multi-tap echo (libavfilter/af_aecho.c): per-channel rings of max_samples input samples, and a max_samples tail after EOF. */
export const aecho=defineAudioFilter<AudioEchoStep>({
  name:'aecho',
  examples:['aecho','aecho=0.8:0.9:20|7.3:0.5|0.3','aecho=in_gain=0.6:out_gain=0.5:delays=300:decays=0.4'],
  parse:parseAudioEcho,
  capabilities:()=>({generatesOutput:true,reframes:true,allocatesFrames:true,formatConstraint:false,rateConversion:false,timeSelection:false}),
  count(step,samples,rate){
    const tail=BigInt(audioEchoSamples(step,rate).maximum),chunk=BigInt(audioEchoPacketSamples);
    return {samples:samples+tail,buffers:[Number(tail<chunk?tail:chunk)],packets:{trailing:{samples:tail,span:chunk}}};
  },
  formats:()=>['s16p','s32p','fltp','dblp'],
  constraint:step=>format=>{audioEchoSamples(step,format.sampleRate);},
  stream:(step,frames,options,configured,negotiated)=>echoAudio(step,frames,options,configured,negotiated),
  // One output frame per input or tail frame, plus max_samples per channel of delay ring at the working width.
  reserve(step,{sampleRate,channels,sampleFormat}){
    return {frames:1,buffers:[],stateBytes:BigInt(audioEchoSamples(step,sampleRate).maximum)*BigInt(channels)*BigInt(widths[audioEchoFormat(sampleFormat).slice(0,-1) as EchoKind])};
  }
});
