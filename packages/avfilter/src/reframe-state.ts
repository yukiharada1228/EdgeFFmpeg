import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import type {AudioConversionOptions} from '@edge-ffmpeg/swresample';
export class AudioReframeError extends Error {}
export interface AudioReframeFormat {readonly sampleRate:number;readonly channels:number;readonly channelLayout:string;readonly sampleFormat:string}
export interface AudioReframeCheckpoint {
 readonly version:1;readonly kind:'audio-reframe';readonly samples:number;readonly pad:boolean;
 readonly format:AudioReframeFormat|null;readonly filled:number;readonly received:string;readonly emitted:string;readonly origin:string|null;readonly finished:boolean;readonly pending:Uint8Array;
}
export interface AudioReframeState {push(frame:AudioFrameData):Generator<AudioFrameData,void,unknown>;finish():AudioFrameData|null;checkpoint():AudioReframeCheckpoint;dispose():void}
const widths:Readonly<Record<string,number>>={u8:1,s16:2,s32:4,flt:4,dbl:8},MIN=-(1n<<63n),MAX=(1n<<63n)-1n;
function invalid(message:string):never{throw new AudioReframeError(message);}
const fields=['version','kind','samples','pad','format','filled','received','emitted','origin','finished'],formatFields=['sampleRate','channels','channelLayout','sampleFormat'];
const exact=(value:unknown,names:readonly string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
function limits(samples:number,pad:boolean,maxFrameBytes:number):void {if(typeof pad!=='boolean'||!Number.isInteger(samples)||samples<1||samples>2147483647||!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1)invalid('Invalid audio reframe limits');}
function format(value:AudioReframeFormat,maxFrameBytes:number,samples:number):{align:number;planeAlign:number;planeCount:number;base:string}{
 if(!value||typeof value.sampleFormat!=='string'||typeof value.channelLayout!=='string'||value.channelLayout.length>4096||!Number.isSafeInteger(value.sampleRate)||value.sampleRate<1||!Number.isSafeInteger(value.channels)||value.channels<1)invalid('Invalid audio reframe format');
 const planar=value.sampleFormat.endsWith('p'),base=planar?value.sampleFormat.slice(0,-1):value.sampleFormat;
 if(!Object.hasOwn(widths,base))invalid('Invalid audio reframe sample format');
 const align=value.channels*widths[base]!,bytes=samples*align;
 if(!Number.isSafeInteger(bytes)||bytes>maxFrameBytes)invalid('Reframed audio exceeds allocation limit');
 return {align,planeAlign:planar?widths[base]!:align,planeCount:planar?value.channels:1,base};
}
function decimal(value:string,signed=false):bigint {
 if(typeof value!=='string'||value.length>128||!(signed?/^(?:0|-?[1-9][0-9]*)$/:/^(?:0|[1-9][0-9]*)$/).test(value))invalid('Invalid audio reframe checkpoint counter');
 // Native sample counts and timestamps are int64; a snapshot never carries a value native state could not hold.
 const result=BigInt(value);if(result<MIN||result>MAX)invalid('Audio reframe checkpoint counter or origin exceeds signed64');return result;
}
function validate(cp:AudioReframeCheckpoint,maxFrameBytes:number):void {
 if(!cp||cp.version!==1||cp.kind!=='audio-reframe'||typeof cp.finished!=='boolean')invalid('Invalid audio reframe checkpoint version or kind');limits(cp.samples,cp.pad,maxFrameBytes);
 if(!Number.isInteger(cp.filled)||cp.filled<0||cp.filled>=cp.samples||!(cp.pending instanceof Uint8Array)||cp.pending.byteLength>maxFrameBytes)invalid('Invalid audio reframe checkpoint payload');
 const received=decimal(cp.received),emitted=decimal(cp.emitted);if(cp.origin!==null)decimal(cp.origin,true);
 if(cp.format===null){if(received!==0n||emitted!==0n||cp.filled!==0||cp.pending.length!==0||cp.origin!==null)invalid('Unconfigured audio reframe checkpoint contains samples');return;}
 const layout=format(cp.format,maxFrameBytes,cp.samples);
 if(cp.pending.byteLength!==cp.filled*layout.align)invalid('Audio reframe checkpoint payload length mismatch');
 if(cp.finished){const expected=cp.pad?(received+BigInt(cp.samples)-1n)/BigInt(cp.samples)*BigInt(cp.samples):received;if(cp.filled!==0||cp.pending.length!==0||emitted!==expected)invalid('Invalid finished audio reframe checkpoint counters');}
 else if(emitted%BigInt(cp.samples)!==0n||received!==emitted+BigInt(cp.filled))invalid('Invalid pending audio reframe checkpoint counters');
}
function metadata(cp:AudioReframeCheckpoint){return {version:cp.version,kind:cp.kind,samples:cp.samples,pad:cp.pad,format:cp.format?{sampleRate:cp.format.sampleRate,channels:cp.format.channels,channelLayout:cp.format.channelLayout,sampleFormat:cp.format.sampleFormat}:null,filled:cp.filled,received:cp.received,emitted:cp.emitted,origin:cp.origin,finished:cp.finished};}
/** Binary layout: four-byte little-endian header length, exactly that many bytes of canonical BOM-free UTF-8 JSON, then compact pending planes.
 * Version policy: decoders accept exactly version 1 in this serializer's canonical encoding. Any field or encoding change needs a new
 * version number; other versions, unknown or missing fields and non-canonical JSON are rejected, never migrated.
 */
export function serializeAudioReframeCheckpoint(cp:AudioReframeCheckpoint,options:{readonly maxFrameBytes:number}):Uint8Array {
 validate(cp,options.maxFrameBytes);const header=new TextEncoder().encode(JSON.stringify(metadata(cp)));
 if(header.byteLength>16384)invalid('Audio reframe checkpoint header exceeds limit');
 const total=4+header.byteLength+cp.pending.byteLength;if(!Number.isSafeInteger(total))invalid('Audio reframe checkpoint size overflow');
 const bytes=new Uint8Array(total);new DataView(bytes.buffer).setUint32(0,header.byteLength,true);bytes.set(header,4);bytes.set(cp.pending,4+header.byteLength);return bytes;
}
export function deserializeAudioReframeCheckpoint(bytes:Uint8Array,options:{readonly maxFrameBytes:number}):AudioReframeCheckpoint {
 if(!(bytes instanceof Uint8Array)||bytes.length<4||!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<1)invalid('Invalid audio reframe checkpoint bytes');
 const headerBytes=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true);
 if(headerBytes<2||headerBytes>16384||4+headerBytes>bytes.length||bytes.length-4-headerBytes>options.maxFrameBytes)invalid('Invalid audio reframe checkpoint header or payload length');
 let decoded:AudioReframeCheckpoint;
 try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(4,4+headerBytes))) as AudioReframeCheckpoint;}catch{invalid('Invalid audio reframe checkpoint metadata');}
 if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))invalid('Invalid audio reframe checkpoint metadata');
 const format=decoded.format as unknown;if(!exact(decoded,fields)||(format!==null&&!exact(format,formatFields)))invalid('Unknown or missing audio reframe checkpoint fields');
 const candidate={...decoded,pending:bytes.subarray(4+headerBytes)};validate(candidate,options.maxFrameBytes);
 // One encoding per state: whitespace, key order, escapes, number spellings, duplicate keys and a BOM all fail here.
 const result=metadata(candidate),canonical=new TextEncoder().encode(JSON.stringify(result)),header=bytes.subarray(4,4+headerBytes);
 if(canonical.byteLength!==header.byteLength||canonical.some((value,index)=>value!==header[index]))invalid('Non-canonical audio reframe checkpoint metadata');
 return {...result,pending:candidate.pending.slice()};
}
/** Stateful bounded FIFO. Snapshot only after completely draining push(). Output
 * buffers and snapshots never alias the pending state. Input planes are borrowed
 * until push is exhausted and must stay stable. Early return poisons the state.
 */
export function createAudioReframeState(samples:number,pad:boolean,options:AudioConversionOptions,checkpoint?:AudioReframeCheckpoint):AudioReframeState {
 const maxFrameBytes=options.maxFrameBytes,signal=options.signal;limits(samples,pad,maxFrameBytes);signal?.throwIfAborted();
 let template:AudioReframeFormat|null=null,buffer:Uint8Array|undefined,align=0,planeAlign=0,planeCount=0,base='',filled=0,received=0n,emitted=0n,origin:bigint|null=null,finished=false,busy=false,disposed=false,poisoned=false;
 if(checkpoint){
  validate(checkpoint,maxFrameBytes);if(checkpoint.samples!==samples||checkpoint.pad!==pad)invalid('Audio reframe checkpoint configuration mismatch');
  template=checkpoint.format?{...checkpoint.format}:null;filled=checkpoint.filled;received=BigInt(checkpoint.received);emitted=BigInt(checkpoint.emitted);origin=checkpoint.origin===null?null:BigInt(checkpoint.origin);finished=checkpoint.finished;
  if(template){({align,planeAlign,planeCount,base}=format(template,maxFrameBytes,samples));if(filled){buffer=new Uint8Array(samples*align);if(base==='u8')buffer.fill(128);for(let channel=0;channel<planeCount;channel++)buffer.set(checkpoint.pending.subarray(channel*filled*planeAlign,(channel+1)*filled*planeAlign),channel*samples*planeAlign);}}
 }
 const usable=()=>{if(disposed||poisoned)invalid('Audio reframe state is disposed or poisoned');signal?.throwIfAborted();};
 const idle=()=>{usable();if(busy)invalid('Audio reframe state is busy');};
 const poison=()=>{poisoned=true;busy=false;buffer=undefined;};
 const output=(data:Uint8Array,count:number):AudioFrameData=>({...template!,samples:count,planes:Array.from({length:planeCount},(_,channel)=>data.subarray(channel*samples*planeAlign,channel*samples*planeAlign+count*planeAlign)),pts:origin===null?null:{value:origin+emitted,timeBase:{num:1n,den:BigInt(template!.sampleRate)}}});
 function* process(frame:AudioFrameData):Generator<AudioFrameData,void,unknown>{
  usable();const current=format(frame,maxFrameBytes,samples),size=frame.samples*current.align;
  if(!Number.isSafeInteger(frame.samples)||frame.samples<1||!Number.isSafeInteger(size)||size>maxFrameBytes||!Array.isArray(frame.planes)||frame.planes.length!==current.planeCount)invalid('Invalid audio reframe input');
  for(const plane of frame.planes){signal?.throwIfAborted();if(!(plane instanceof Uint8Array)||plane.length!==frame.samples*current.planeAlign)invalid('Invalid audio reframe plane');}
  let pts:bigint|null=null;
  if(frame.pts!==null){const {value,timeBase:{num,den}}=frame.pts;if(typeof value!=='bigint'||typeof num!=='bigint'||typeof den!=='bigint'||num<=0n||den<=0n||value*num*BigInt(frame.sampleRate)%den!==0n)invalid('Reframing requires sample-aligned timestamps');pts=value*num*BigInt(frame.sampleRate)/den;}
  if(!template){template={sampleRate:frame.sampleRate,channels:frame.channels,channelLayout:frame.channelLayout,sampleFormat:frame.sampleFormat};({align,planeAlign,planeCount,base}=current);origin=pts;}
  else if(frame.sampleFormat!==template.sampleFormat||frame.sampleRate!==template.sampleRate||frame.channels!==template.channels||frame.channelLayout!==template.channelLayout||(origin===null?pts!==null:pts!==origin+received))invalid('Reframing requires stable format and contiguous timestamps');
  received+=BigInt(frame.samples);let offset=0;
  while(offset<frame.samples){
   usable();if(!buffer){buffer=new Uint8Array(samples*align);if(base==='u8')buffer.fill(128);}
   const count=Math.min(samples-filled,frame.samples-offset);
   for(let channel=0;channel<planeCount;channel++){signal?.throwIfAborted();buffer.set(frame.planes[channel]!.subarray(offset*planeAlign,(offset+count)*planeAlign),channel*samples*planeAlign+filled*planeAlign);}offset+=count;filled+=count;
   if(filled===samples){const result=output(buffer,samples);buffer=undefined;filled=0;emitted+=BigInt(samples);yield result;}
  }
 }
 return {
  push(frame){idle();if(finished)invalid('Audio reframe state is finished');busy=true;const engine=process(frame),advance=engine.next.bind(engine),close=engine.return.bind(engine),raise=engine.throw.bind(engine);let done=false;
   // Retain the native Generator prototype, including its disposal protocol.
   // Completed iterators must never modify a later push's busy/poison state.
   return Object.assign(engine,{
    next(value?:unknown):IteratorResult<AudioFrameData,void>{if(done)return {done:true,value:undefined};try{usable();const result=advance(value);if(result.done){done=true;busy=false;}return result;}catch(error){done=true;poison();throw error;}},
    return():IteratorResult<AudioFrameData,void>{if(done)return {done:true,value:undefined};try{return close();}finally{poison();done=true;}},
    throw(error?:unknown):IteratorResult<AudioFrameData,void>{if(done)throw error;try{return raise(error);}finally{poison();done=true;}}
   });
  },
  finish(){idle();if(finished)return null;finished=true;if(!buffer||!filled)return null;const count=pad?samples:filled,result=output(buffer,count);buffer=undefined;filled=0;emitted+=BigInt(count);return result;},
  checkpoint(){idle();const pending=new Uint8Array(filled*align);if(buffer)for(let channel=0;channel<planeCount;channel++)pending.set(buffer.subarray(channel*samples*planeAlign,channel*samples*planeAlign+filled*planeAlign),channel*filled*planeAlign);return {...metadata({version:1,kind:'audio-reframe',samples,pad,format:template,filled,received:String(received),emitted:String(emitted),origin:origin===null?null:String(origin),finished,pending}),pending};},
  dispose(){disposed=true;buffer=undefined;template=null;}
 };
}
