import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioConversionOptions} from '@edge-ffmpeg/swresample';
export class AudioPadError extends Error {}
export type AudioPadFormat = Pick<AudioFrameData, 'sampleRate' | 'channels' | 'channelLayout' | 'sampleFormat' | 'pts'>;
export interface AudioPadOptions extends AudioConversionOptions {readonly emptyInput?:AudioPadFormat;readonly padSamples?:bigint;readonly wholeSamples?:bigint;readonly padDurationMicros?:bigint;readonly wholeDurationMicros?:bigint;readonly packetSamples?:number}
export type AudioPadMode = 'pad_len' | 'whole_len' | 'pad_dur' | 'whole_dur';
export interface AudioPadStateFormat {readonly sampleRate:number;readonly channels:number;readonly channelLayout:string;readonly sampleFormat:string}
export interface AudioPadCheckpointDescriptor extends AudioPadStateFormat {readonly pts:{readonly value:string;readonly num:string;readonly den:string}|null}
export interface AudioPadCheckpoint {
 readonly version:1;readonly kind:'audio-pad';readonly mode:AudioPadMode;readonly limit:string;readonly packetSamples:number;readonly emptyInput:AudioPadCheckpointDescriptor|null;
 readonly format:AudioPadStateFormat|null;readonly origin:string|null;readonly received:string;readonly padded:string;readonly eof:boolean;readonly finished:boolean;
}
/** push() validates and returns the borrowed input frame unchanged. finish(maxPackets?) yields owned silence packets. */
export interface AudioPadState {push(frame:AudioFrameData):AudioFrameData;finish(maxPackets?:number):Generator<AudioFrameData,void,unknown>;readonly finished:boolean;checkpoint():AudioPadCheckpoint;dispose():void}
const widths:Readonly<Record<string,number>>={u8:1,s16:2,s32:4,flt:4,dbl:8},modes:readonly AudioPadMode[]=['pad_len','whole_len','pad_dur','whole_dur'],signed64=(1n<<63n)-1n,int64=(value:unknown)=>typeof value==='bigint'&&value>=-signed64-1n&&value<=signed64;
function invalid(message:string):never{throw new AudioPadError(message);}
const fields=['version','kind','mode','limit','packetSamples','emptyInput','format','origin','received','padded','eof','finished'],formatFields=['sampleRate','channels','channelLayout','sampleFormat'],descriptorFields=[...formatFields,'pts'],ptsFields=['value','num','den'];
const exact=(value:unknown,names:readonly string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
export function paddingDurationSamples(microseconds:bigint,rate:number):bigint{
  if(typeof microseconds!=='bigint'||microseconds<0n||!Number.isInteger(rate)||rate<1||rate>2147483647)throw new AudioPadError('Invalid padding duration or rate');
  const samples=(microseconds*BigInt(rate)+500000n)/1000000n;if(samples>signed64)throw new AudioPadError('Padding duration exceeds signed64 samples');return samples;
}
interface Configuration {readonly mode:AudioPadMode;readonly limit:bigint;readonly packetSamples:number;readonly emptyInput:AudioPadCheckpointDescriptor|null}
function configuration(options:AudioPadOptions):Configuration {
  const {padSamples,wholeSamples,padDurationMicros,wholeDurationMicros,maxFrameBytes}=options,values=[padSamples,wholeSamples,padDurationMicros,wholeDurationMicros],limits=values.filter(value=>value!==undefined),limit=limits[0],packetSamples=options.packetSamples??4096;
  if(limits.length!==1||typeof limit!=='bigint'||limit<0n||limit>signed64||!Number.isInteger(packetSamples)||packetSamples<1||packetSamples>2147483647||!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1)invalid('Invalid finite audio padding limits');
  const empty=options.emptyInput;let emptyInput:AudioPadCheckpointDescriptor|null=null;
  if(empty!==undefined){if(!empty||typeof empty.sampleFormat!=='string'||empty.sampleFormat.length>64||typeof empty.channelLayout!=='string'||empty.channelLayout.length>4096||typeof empty.sampleRate!=='number'||typeof empty.channels!=='number'||(empty.pts&&(!int64(empty.pts.value)||!int64(empty.pts.timeBase?.num)||!int64(empty.pts.timeBase.den)||empty.pts.timeBase.num<1n||empty.pts.timeBase.den<1n)))invalid('Invalid configured audio padding format');layout(empty);emptyInput={sampleRate:empty.sampleRate,channels:empty.channels,channelLayout:empty.channelLayout,sampleFormat:empty.sampleFormat,pts:empty.pts?{value:String(empty.pts.value),num:String(empty.pts.timeBase.num),den:String(empty.pts.timeBase.den)}:null};}
  return {mode:modes[values.indexOf(limit)]!,limit,packetSamples,emptyInput};
}
/** Throws for an unsupported configured format, returning per-sample byte width and planarity. */
function layout(format:AudioPadStateFormat,message='Invalid configured audio padding format'):{width:number;planar:boolean} {
  const planar=format.sampleFormat.endsWith('p'),base=planar?format.sampleFormat.slice(0,-1):format.sampleFormat;
  if(!Object.hasOwn(widths,base)||!Number.isInteger(format.sampleRate)||format.sampleRate<1||format.sampleRate>2147483647||!Number.isSafeInteger(format.channels)||format.channels<1||!Number.isSafeInteger(format.channels*widths[base]!))invalid(message);
  return {width:widths[base]!,planar};
}
function sampleOrigin(pts:{readonly value:bigint;readonly timeBase:{readonly num:bigint;readonly den:bigint}}|null,rate:number):bigint|null {
  if(!pts)return null;const {num,den}=pts.timeBase;if(typeof pts.value!=='bigint'||typeof num!=='bigint'||typeof den!=='bigint')invalid('Padding requires sample-aligned timestamps');const value=pts.value*num*BigInt(rate);if(num<=0n||den<=0n||value%den!==0n)invalid('Padding requires sample-aligned timestamps');return value/den;
}
const descriptorPts=(descriptor:AudioPadCheckpointDescriptor)=>descriptor.pts?{value:BigInt(descriptor.pts.value),timeBase:{num:BigInt(descriptor.pts.num),den:BigInt(descriptor.pts.den)}}:null;
function resolved(config:Pick<Configuration,'mode'|'limit'>,rate:number):{pad:bigint|null;whole:bigint|null} {
  const samples=config.mode.endsWith('_dur')?paddingDurationSamples(config.limit,rate):config.limit;return config.mode.startsWith('pad')?{pad:samples,whole:null}:{pad:null,whole:samples};
}
const total=(target:{pad:bigint|null;whole:bigint|null},received:bigint)=>target.pad??(target.whole!>received?target.whole!-received:0n);
function packet(remaining:bigint,packetSamples:number,format:AudioPadStateFormat,width:number,maxFrameBytes:number):void {const largest=remaining<BigInt(packetSamples)?remaining:BigInt(packetSamples);if(largest*BigInt(format.channels)*BigInt(width)>BigInt(maxFrameBytes))invalid('Audio padding packet exceeds allocation limit');}
function decimal(value:unknown,signed=false):bigint {
  if(typeof value!=='string'||value.length>128||!(signed?/^(?:0|-?[1-9][0-9]*)$/:/^(?:0|[1-9][0-9]*)$/).test(value))invalid('Invalid audio padding checkpoint counter');
  // Native limits, counts and timestamps are int64; a snapshot never carries a value native state could not hold.
  const result=BigInt(value);if(!int64(result))invalid('Audio padding checkpoint integer exceeds signed64');return result;
}
function sameFormat(left:AudioPadStateFormat,right:AudioPadStateFormat):boolean {return left.sampleRate===right.sampleRate&&left.channels===right.channels&&left.channelLayout===right.channelLayout&&left.sampleFormat===right.sampleFormat;}
function sameDescriptor(left:AudioPadCheckpointDescriptor|null,right:AudioPadCheckpointDescriptor|null):boolean {return left===null||right===null?left===right:sameFormat(left,right)&&(left.pts===null||right.pts===null?left.pts===right.pts:left.pts.value===right.pts.value&&left.pts.num===right.pts.num&&left.pts.den===right.pts.den);}
function validate(cp:AudioPadCheckpoint,maxFrameBytes:number):void {
  if(!cp||typeof cp!=='object'||cp.version!==1||cp.kind!=='audio-pad'||typeof cp.eof!=='boolean'||typeof cp.finished!=='boolean')invalid('Invalid audio padding checkpoint version or kind');
  if(!modes.includes(cp.mode)||!Number.isInteger(cp.packetSamples)||cp.packetSamples<1||cp.packetSamples>2147483647||!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1)invalid('Invalid audio padding checkpoint configuration');
  const limit=decimal(cp.limit),received=decimal(cp.received),padded=decimal(cp.padded),origin=cp.origin===null?null:decimal(cp.origin,true);
  const empty=cp.emptyInput;
  if(empty!==null){if(!empty||typeof empty!=='object'||Array.isArray(empty)||typeof empty.sampleFormat!=='string'||empty.sampleFormat.length>64||typeof empty.channelLayout!=='string'||empty.channelLayout.length>4096||typeof empty.sampleRate!=='number'||typeof empty.channels!=='number'||(empty.pts!==null&&(!empty.pts||typeof empty.pts!=='object')))invalid('Invalid audio padding checkpoint empty-input descriptor');
    // The same ranges configuration() enforces, so a decodable descriptor is exactly one createAudioPadState accepts.
    layout(empty,'Invalid audio padding checkpoint empty-input descriptor');if(empty.pts){decimal(empty.pts.value,true);if(decimal(empty.pts.num)<1n||decimal(empty.pts.den)<1n)invalid('Invalid audio padding checkpoint empty-input descriptor');}}
  if(cp.format===null){if(received!==0n||padded!==0n||origin!==null||cp.finished!==cp.eof||(cp.eof&&empty!==null))invalid('Unconfigured audio padding checkpoint contains samples');return;}
  if(!cp.format||typeof cp.format!=='object'||typeof cp.format.sampleFormat!=='string'||cp.format.sampleFormat.length>64||typeof cp.format.channelLayout!=='string'||cp.format.channelLayout.length>4096)invalid('Invalid audio padding checkpoint format');
  const {width}=layout(cp.format),target=resolved({mode:cp.mode,limit},cp.format.sampleRate);
  if(received===0n&&(!cp.eof||empty===null||!sameFormat(cp.format,empty)||sampleOrigin(descriptorPts(empty),empty.sampleRate)!==origin))invalid('Audio padding checkpoint format lacks input or matching empty-input descriptor');
  if(target.pad!==null)packet(target.pad,cp.packetSamples,cp.format,width,maxFrameBytes);
  if(!cp.eof){if(padded!==0n||cp.finished)invalid('Invalid pending audio padding checkpoint counters');return;}
  const required=total(target,received);
  if(padded>required||cp.finished!==(padded===required)||(!cp.finished&&padded%BigInt(cp.packetSamples)!==0n))invalid('Invalid finished audio padding checkpoint counters');
  packet(required-padded,cp.packetSamples,cp.format,width,maxFrameBytes);
}
function metadata(cp:AudioPadCheckpoint):AudioPadCheckpoint {
  const empty=cp.emptyInput,format=cp.format;
  return {version:cp.version,kind:cp.kind,mode:cp.mode,limit:cp.limit,packetSamples:cp.packetSamples,emptyInput:empty?{sampleRate:empty.sampleRate,channels:empty.channels,channelLayout:empty.channelLayout,sampleFormat:empty.sampleFormat,pts:empty.pts?{value:empty.pts.value,num:empty.pts.num,den:empty.pts.den}:null}:null,format:format?{sampleRate:format.sampleRate,channels:format.channels,channelLayout:format.channelLayout,sampleFormat:format.sampleFormat}:null,origin:cp.origin,received:cp.received,padded:cp.padded,eof:cp.eof,finished:cp.finished};
}
/** Binary layout: four-byte little-endian header length followed by exactly that many bytes of BOM-free UTF-8 JSON; apad carries no sample payload.
 * Version policy: decoders accept exactly version 1 in its canonical encoding (this serializer's bytes). Any field or encoding change
 * needs a new version number; other versions, unknown or missing fields and non-canonical JSON are rejected, never migrated.
 */
export function serializeAudioPadCheckpoint(cp:AudioPadCheckpoint,options:{readonly maxFrameBytes:number}):Uint8Array {
  validate(cp,options.maxFrameBytes);const header=new TextEncoder().encode(JSON.stringify(metadata(cp)));
  if(header.byteLength>16384)invalid('Audio padding checkpoint header exceeds limit');
  const bytes=new Uint8Array(4+header.byteLength);new DataView(bytes.buffer).setUint32(0,header.byteLength,true);bytes.set(header,4);return bytes;
}
export function deserializeAudioPadCheckpoint(bytes:Uint8Array,options:{readonly maxFrameBytes:number}):AudioPadCheckpoint {
  if(!(bytes instanceof Uint8Array)||bytes.length<4||bytes.length>4+16384||!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<1)invalid('Invalid audio padding checkpoint bytes');
  const headerBytes=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true);
  if(headerBytes<2||headerBytes>16384||4+headerBytes!==bytes.length)invalid('Invalid audio padding checkpoint header length');
  let decoded:AudioPadCheckpoint;
  try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(4))) as AudioPadCheckpoint;}catch{invalid('Invalid audio padding checkpoint metadata');}
  if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))invalid('Invalid audio padding checkpoint metadata');
  const empty=decoded.emptyInput as unknown,format=decoded.format as unknown;
  if(!exact(decoded,fields)||(empty!==null&&(!exact(empty,descriptorFields)||(decoded.emptyInput!.pts!==null&&!exact(decoded.emptyInput!.pts,ptsFields))))||(format!==null&&!exact(format,formatFields)))invalid('Unknown or missing audio padding checkpoint fields');
  validate(decoded,options.maxFrameBytes);const result=metadata(decoded),canonical=new TextEncoder().encode(JSON.stringify(result)),header=bytes.subarray(4);
  // One encoding per state: whitespace, key order, escapes, number spellings and duplicate keys all fail here.
  if(canonical.byteLength!==header.byteLength||canonical.some((value,index)=>value!==header[index]))invalid('Non-canonical audio padding checkpoint metadata');
  return result;
}
/** Stateful finite apad. Input frames retain ownership; every padding frame owns new storage.
 * Snapshot only while no finish() iterator is suspended. Early return from finish() poisons the state.
 */
export function createAudioPadState(options:AudioPadOptions,checkpoint?:AudioPadCheckpoint):AudioPadState {
  const config=configuration(options),{maxFrameBytes,signal}=options,packetSamples=config.packetSamples;signal?.throwIfAborted();
  let template:AudioPadStateFormat|null=null,target:{pad:bigint|null;whole:bigint|null}={pad:null,whole:null},width=0,planar=false,received=0n,padded=0n,origin:bigint|null=null,eof=false,finished=false,busy=false,disposed=false,poisoned=false;
  if(checkpoint){
    validate(checkpoint,maxFrameBytes);if(checkpoint.mode!==config.mode||checkpoint.limit!==String(config.limit)||checkpoint.packetSamples!==packetSamples||!sameDescriptor(checkpoint.emptyInput,config.emptyInput))invalid('Audio padding checkpoint configuration mismatch');
    template=checkpoint.format?{...checkpoint.format}:null;received=BigInt(checkpoint.received);padded=BigInt(checkpoint.padded);origin=checkpoint.origin===null?null:BigInt(checkpoint.origin);eof=checkpoint.eof;finished=checkpoint.finished;
    if(template){({width,planar}=layout(template));target=resolved(config,template.sampleRate);}
  }
  const usable=()=>{if(disposed||poisoned)invalid('Audio padding state is disposed or poisoned');signal?.throwIfAborted();};
  const idle=()=>{usable();if(busy)invalid('Audio padding state is busy');};
  const initialize=(format:AudioPadStateFormat,pts:bigint|null)=>{
    const current=layout(format),next=resolved(config,format.sampleRate);if(next.pad!==null)packet(next.pad,packetSamples,format,current.width,maxFrameBytes);
    template={sampleRate:format.sampleRate,channels:format.channels,channelLayout:format.channelLayout,sampleFormat:format.sampleFormat};origin=pts;({width,planar}=current);target=next;
  };
  function* drain(limit:number):Generator<AudioFrameData,void,unknown>{
    usable();
    if(!eof){const empty=config.emptyInput;if(!template&&empty)initialize(empty,sampleOrigin(descriptorPts(empty),empty.sampleRate));eof=true;if(!template){finished=true;return;}}
    const format=template!,required=total(target,received);packet(required-padded,packetSamples,format,width,maxFrameBytes);
    for(let count=0;count<limit&&padded<required;count++){
      usable();const remaining=required-padded,samples=Number(remaining<BigInt(packetSamples)?remaining:BigInt(packetSamples)),data=new Uint8Array(samples*format.channels*width);if(format.sampleFormat==='u8'||format.sampleFormat==='u8p')data.fill(128);
      const planes=planar?Array.from({length:format.channels},(_,channel)=>data.subarray(channel*samples*width,(channel+1)*samples*width)):[data];
      const output:AudioFrameData={...format,samples,planes,pts:origin===null?null:{value:origin+received+padded,timeBase:{num:1n,den:BigInt(format.sampleRate)}}};padded+=BigInt(samples);if(padded===required)finished=true;yield output;
    }
    if(padded===required)finished=true;
  }
  return {
    push(frame){
      idle();if(eof)invalid('Audio padding state has reached end of input');
      try{
        const isPlanar=frame.sampleFormat.endsWith('p'),base=isPlanar?frame.sampleFormat.slice(0,-1):frame.sampleFormat,w=widths[base],size=frame.samples*frame.channels*(w??0);
        if(!Object.hasOwn(widths,base)||!Number.isSafeInteger(frame.samples)||frame.samples<1||!Number.isSafeInteger(frame.channels)||frame.channels<1||!Number.isSafeInteger(frame.sampleRate)||frame.sampleRate<1||!Number.isSafeInteger(size)||size>maxFrameBytes||!Array.isArray(frame.planes)||frame.planes.length!==(isPlanar?frame.channels:1))invalid('Invalid audio padding input');
        for(let channel=0;channel<frame.planes.length;channel++){signal?.throwIfAborted();const plane=frame.planes[channel];if(!(plane instanceof Uint8Array)||plane.length!==frame.samples*(isPlanar?1:frame.channels)*w!)invalid('Invalid audio padding plane');}
        const pts=sampleOrigin(frame.pts,frame.sampleRate);
        if(!template)initialize(frame,pts);
        else if(frame.sampleFormat!==template.sampleFormat||frame.channels!==template.channels||frame.channelLayout!==template.channelLayout||frame.sampleRate!==template.sampleRate||(origin===null?pts!==null:pts!==origin+received))invalid('Padding requires stable format and contiguous timestamps');
        received+=BigInt(frame.samples);return frame;
      }catch(error){poisoned=true;throw error;}
    },
    finish(maxPackets?:number){
      idle();if(maxPackets!==undefined&&(!Number.isSafeInteger(maxPackets)||maxPackets<1))invalid('Invalid audio padding packet limit');busy=true;
      const engine=drain(maxPackets??Number.POSITIVE_INFINITY),advance=engine.next.bind(engine),close=engine.return.bind(engine),raise=engine.throw.bind(engine);let done=false;
      const poison=()=>{poisoned=true;busy=false;};
      // Same ownership discipline as the audio FIFO: completed iterators never modify a later finish's busy/poison state.
      return Object.assign(engine,{
        next(value?:unknown):IteratorResult<AudioFrameData,void>{if(done)return {done:true,value:undefined};try{usable();const result=advance(value);if(result.done){done=true;busy=false;}return result;}catch(error){done=true;poison();throw error;}},
        return():IteratorResult<AudioFrameData,void>{if(done)return {done:true,value:undefined};try{return close();}finally{poison();done=true;}},
        throw(error?:unknown):IteratorResult<AudioFrameData,void>{if(done)throw error;try{return raise(error);}finally{poison();done=true;}}
      });
    },
    get finished(){return finished;},
    checkpoint(){idle();return metadata({version:1,kind:'audio-pad',mode:config.mode,limit:String(config.limit),packetSamples,emptyInput:config.emptyInput,format:template,origin:origin===null?null:String(origin),received:String(received),padded:String(padded),eof,finished});},
    dispose(){disposed=true;template=null;}
  };
}
