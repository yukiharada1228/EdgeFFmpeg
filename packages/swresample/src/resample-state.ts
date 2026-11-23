import {rescale} from '@edge-ffmpeg/avutil';
import type {AudioFrameData} from '@edge-ffmpeg/avutil';
import {AudioConversionError,convertAudioFrame} from './convert.js';
import type {AudioSampleFormat} from './convert.js';
import {planAudioResample,resampleCoefficients,resampledSampleCount,resampledStreamingSampleCount} from './resample-plan.js';
import type {AudioResampleOptions,AudioResamplePlan,ResampleSampleFormat} from './resample-plan.js';
/** Plan identity bound into a snapshot. Coefficients are rebuilt from it, never serialized. */
export interface AudioResampleCheckpointPlan {readonly inputRate:number;readonly outputRate:number;readonly channels:number;readonly sampleFormat:ResampleSampleFormat;readonly taps:number;readonly phases:number;readonly interpolates:boolean}
/** Frame format (packed or planar spelling of the plan format), layout and the maxFrameBytes-derived output frame size. */
export interface AudioResampleCheckpointFormat {readonly sampleFormat:string;readonly channelLayout:string;readonly frameSamples:number}
export interface AudioResampleCheckpoint {
 readonly version:1;readonly kind:'audio-resample';readonly outputRate:number;readonly requestedFormat:ResampleSampleFormat|null;readonly plan:AudioResampleCheckpointPlan|null;readonly format:AudioResampleCheckpointFormat|null;
 readonly origin:string|null;readonly received:string;readonly emitted:string;readonly eof:boolean;readonly finished:boolean;readonly history:Uint8Array;readonly pending:Uint8Array;
}
export type AudioResampleCheckpointLimits=Pick<AudioResampleOptions,'maxFrameBytes'|'maxStateBytes'>;
/** push() drains one input frame; finish(maxFrames?) marks end of input and drains the reflected tail, at most maxFrames output frames per call. */
export interface AudioResampleState {push(frame:AudioFrameData):Generator<AudioFrameData,void,unknown>;finish(maxFrames?:number):Generator<AudioFrameData,void,unknown>;readonly finished:boolean;checkpoint():AudioResampleCheckpoint;dispose():void}
const widths:Readonly<Record<string,number>>={s16:2,flt:4,dbl:8},formats:readonly string[]=['s16','flt','dbl'],MIN=-(1n<<63n),MAX=(1n<<63n)-1n;
const fields=['version','kind','outputRate','requestedFormat','plan','format','origin','received','emitted','eof','finished'],planFields=['inputRate','outputRate','channels','sampleFormat','taps','phases','interpolates'],formatFields=['sampleFormat','channelLayout','frameSamples'];
function invalid(message:string):never{throw new AudioConversionError(message);}
const validRate=(value:unknown)=>typeof value==='number'&&Number.isInteger(value)&&value>0&&value<=2147483647;
const exact=(value:unknown,names:readonly string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
function limits(options:AudioResampleCheckpointLimits):void {if(!options||!Number.isSafeInteger(options.maxStateBytes)||options.maxStateBytes<1||!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<2)invalid('Invalid resampling resource limits');}
function decimal(value:unknown,signed=false):bigint {
 if(typeof value!=='string'||value.length>128||!(signed?/^(?:0|-?[1-9][0-9]*)$/:/^(?:0|[1-9][0-9]*)$/).test(value))invalid('Invalid resampling checkpoint counter');
 // Native sample counts and timestamps are int64; a snapshot never carries a value native state could not hold.
 const result=BigInt(value);if(result<MIN||result>MAX)invalid('Resampling checkpoint counter or origin exceeds signed64');return result;
}
/** First input sample that any later output, including the reflected EOF tail, can read. */
function retained(plan:AudioResamplePlan,received:bigint,emitted:bigint):bigint {
 const next=emitted*BigInt(plan.inputRate)/BigInt(plan.outputRate)-BigInt(Math.floor((plan.taps-1)/2)),tail=received-BigInt(plan.taps+1),earliest=next<tail?next:tail;return earliest<0n?0n:earliest;
}
interface Layout {readonly plan:AudioResamplePlan|null;readonly received:bigint;readonly emitted:bigint;readonly origin:bigint|null;readonly earliest:bigint;readonly historyBytes:number;readonly pendingBytes:number}
/** Validates everything except payload bytes, deriving exact payload lengths from counters before any payload allocation. */
function inspect(cp:Omit<AudioResampleCheckpoint,'history'|'pending'>,options:AudioResampleCheckpointLimits):Layout {
 limits(options);
 if(!cp||typeof cp!=='object'||cp.version!==1||cp.kind!=='audio-resample')invalid('Invalid resampling checkpoint version or kind');
 if(!validRate(cp.outputRate)||(cp.requestedFormat!==null&&!formats.includes(cp.requestedFormat))||typeof cp.eof!=='boolean'||typeof cp.finished!=='boolean'||(cp.finished&&!cp.eof))invalid('Invalid resampling checkpoint configuration');
 const received=decimal(cp.received),emitted=decimal(cp.emitted),origin=cp.origin===null?null:decimal(cp.origin,true);
 if(cp.plan===null||cp.format===null){if(cp.plan!==cp.format||received!==0n||emitted!==0n||origin!==null||cp.eof!==cp.finished)invalid('Unconfigured resampling checkpoint contains samples');return {plan:null,received,emitted,origin,earliest:0n,historyBytes:0,pendingBytes:0};}
 if(!exact(cp.plan,planFields)||!exact(cp.format,formatFields))invalid('Invalid resampling checkpoint plan or format fields');
 const {inputRate,outputRate,channels,sampleFormat,taps,phases,interpolates}=cp.plan,{sampleFormat:frameFormat,channelLayout,frameSamples}=cp.format;
 if(!validRate(inputRate)||outputRate!==cp.outputRate||!Number.isSafeInteger(channels)||channels<1||!formats.includes(sampleFormat)||(cp.requestedFormat!==null&&cp.requestedFormat!==sampleFormat)||!Number.isSafeInteger(taps)||!Number.isSafeInteger(phases)||typeof interpolates!=='boolean')invalid('Invalid resampling checkpoint plan');
 if((frameFormat!==sampleFormat&&frameFormat!==sampleFormat+'p')||typeof channelLayout!=='string'||channelLayout.length>4096||!Number.isSafeInteger(frameSamples)||frameSamples<1)invalid('Invalid resampling checkpoint format');
 const align=channels*widths[sampleFormat]!;if(!Number.isSafeInteger(frameSamples*align)||frameSamples*align>options.maxFrameBytes)invalid('Resampling checkpoint frame exceeds allocation limit');
 // Rejects an oversized coefficient/history reservation before anything is allocated.
 const plan=planAudioResample(inputRate,outputRate,channels,{maxFrameBytes:options.maxFrameBytes,maxStateBytes:options.maxStateBytes,sampleFormat});
 if(plan.taps!==taps||plan.phases!==phases||plan.interpolates!==interpolates)invalid('Resampling checkpoint plan mismatch');
 if(received<1n)invalid('Invalid resampling checkpoint counters');
 let history=0n,pending=0n,earliest=received;
 if(!plan.taps){if(emitted!==received||cp.eof!==cp.finished)invalid('Invalid resampling checkpoint counters');}
 else{
  const streaming=resampledStreamingSampleCount(received,inputRate,outputRate),total=resampledSampleCount(received,inputRate,outputRate),frame=BigInt(frameSamples);
  // Streaming states have drained every available output; bounded EOF steps stop only after a whole frame, before the total.
  if(!cp.eof?emitted!==streaming:cp.finished?emitted!==total:emitted<=streaming||emitted>=total||emitted%frame!==0n)invalid('Invalid resampling checkpoint counters');
  if(!cp.eof)pending=emitted%frame;if(!cp.finished){earliest=retained(plan,received,emitted);history=received-earliest;}
  if(history>BigInt(plan.historySamples))invalid('Resampling history exceeds reservation');
 }
 return {plan,received,emitted,origin,earliest,historyBytes:Number(history)*align,pendingBytes:Number(pending)*align};
}
function validate(cp:AudioResampleCheckpoint,options:AudioResampleCheckpointLimits):Layout {
 if(!exact(cp,[...fields,'history','pending']))invalid('Invalid resampling checkpoint fields');
 const layout=inspect(cp,options);
 if(!(cp.history instanceof Uint8Array)||!(cp.pending instanceof Uint8Array)||cp.history.byteLength!==layout.historyBytes||cp.pending.byteLength!==layout.pendingBytes)invalid('Resampling checkpoint payload length mismatch');
 const width=layout.plan?widths[layout.plan.sampleFormat]!:2,view=new DataView(cp.history.buffer,cp.history.byteOffset,cp.history.byteLength);
 if(width!==2)for(let offset=0;offset<cp.history.byteLength;offset+=width)if(!Number.isFinite(width===4?view.getFloat32(offset,true):view.getFloat64(offset,true)))invalid('Non-finite resampling checkpoint history');
 return layout;
}
function metadata(cp:Omit<AudioResampleCheckpoint,'history'|'pending'>):Omit<AudioResampleCheckpoint,'history'|'pending'> {
 const plan=cp.plan,format=cp.format;
 return {version:cp.version,kind:cp.kind,outputRate:cp.outputRate,requestedFormat:cp.requestedFormat,plan:plan?{inputRate:plan.inputRate,outputRate:plan.outputRate,channels:plan.channels,sampleFormat:plan.sampleFormat,taps:plan.taps,phases:plan.phases,interpolates:plan.interpolates}:null,format:format?{sampleFormat:format.sampleFormat,channelLayout:format.channelLayout,frameSamples:format.frameSamples}:null,origin:cp.origin,received:cp.received,emitted:cp.emitted,eof:cp.eof,finished:cp.finished};
}
/** Version 1 binary layout: four-byte little-endian header length, exactly that many bytes of canonical BOM-free UTF-8 JSON
 * (16 KiB maximum), the retained history window as interleaved little-endian samples in plan precision, then pending output
 * samples compacted per plane. Payload lengths are implied by the counters. Other versions are rejected, never migrated.
 */
export function serializeAudioResampleCheckpoint(cp:AudioResampleCheckpoint,options:AudioResampleCheckpointLimits):Uint8Array {
 validate(cp,options);const header=new TextEncoder().encode(JSON.stringify(metadata(cp)));
 if(header.byteLength>16384)invalid('Resampling checkpoint header exceeds limit');
 const bytes=new Uint8Array(4+header.byteLength+cp.history.byteLength+cp.pending.byteLength);new DataView(bytes.buffer).setUint32(0,header.byteLength,true);bytes.set(header,4);bytes.set(cp.history,4+header.byteLength);bytes.set(cp.pending,4+header.byteLength+cp.history.byteLength);return bytes;
}
/** Strict inverse of serializeAudioResampleCheckpoint: only the exact canonical bytes it produces decode. */
export function deserializeAudioResampleCheckpoint(bytes:Uint8Array,options:AudioResampleCheckpointLimits):AudioResampleCheckpoint {
 limits(options);if(!(bytes instanceof Uint8Array)||bytes.length<4||bytes.length>4+16384+options.maxStateBytes+options.maxFrameBytes)invalid('Invalid resampling checkpoint bytes');
 const headerBytes=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true);
 if(headerBytes<2||headerBytes>16384||4+headerBytes>bytes.length)invalid('Invalid resampling checkpoint header length');
 const header=bytes.subarray(4,4+headerBytes);let decoded:Omit<AudioResampleCheckpoint,'history'|'pending'>;
 try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(header)) as typeof decoded;}catch{invalid('Invalid resampling checkpoint metadata');}
 if(!exact(decoded,fields))invalid('Invalid resampling checkpoint fields');
 const layout=inspect(decoded,options),start=4+headerBytes;
 if(bytes.length!==start+layout.historyBytes+layout.pendingBytes)invalid('Resampling checkpoint payload length mismatch');
 const candidate:AudioResampleCheckpoint={...metadata(decoded),history:bytes.subarray(start,start+layout.historyBytes),pending:bytes.subarray(start+layout.historyBytes)};validate(candidate,options);
 // One encoding per state: whitespace, key order, escapes, number spellings and duplicate keys all fail here.
 const canonical=new TextEncoder().encode(JSON.stringify(metadata(candidate)));
 if(canonical.byteLength!==header.byteLength||canonical.some((value,index)=>value!==header[index]))invalid('Non-canonical resampling checkpoint metadata');
 return {...candidate,history:candidate.history.slice(),pending:candidate.pending.slice()};
}
/** Stateful default FIR behind resampleAudio: one implementation for continuous and restored execution.
 * Input planes are borrowed only while push() runs; yielded frames and snapshots own their storage. Snapshot only while no
 * push()/finish() iterator is suspended. Abandoning an iterator, malformed input or cancellation poisons the state.
 */
export function createAudioResampleState(outputRate:number,options:AudioResampleOptions,checkpoint?:AudioResampleCheckpoint):AudioResampleState {
 if(!validRate(outputRate))invalid('Invalid resampling output rate');
 if(!Number.isSafeInteger(options.maxStateBytes)||options.maxStateBytes<1||!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<2)invalid('Invalid resampling resource limits');
 if(options.sampleFormat!==undefined&&!formats.includes(options.sampleFormat))invalid('Unsupported resampling sample format');
 const signal=options.signal,requestedFormat=options.sampleFormat??null;signal?.throwIfAborted();
 let template:{sampleRate:number;channels:number;channelLayout:string;sampleFormat:string}|undefined,plan:AudioResamplePlan|undefined,bank:Int16Array|Float32Array|Float64Array|undefined,history:Int16Array|Float32Array|Float64Array|undefined,buffer:Uint8Array|undefined;
 let received=0n,emitted=0n,earliest=0n,origin:bigint|null=null,outputOrigin:bigint|null=null,started=false,filled=0,eof=false,finished=false,busy=false,disposed=false,poisoned=false;
 let inputRate=0,channels=0,center=0,outputCapacity=0,align=0,width=0,planar=false;
 const configure=(rate:number,count:number,format:string,channelLayout:string,pts:bigint|null)=>{
  const isPlanar=format.endsWith('p'),base=(isPlanar?format.slice(0,-1):format) as ResampleSampleFormat;
  plan=planAudioResample(rate,outputRate,count,{...options,sampleFormat:base});template={sampleRate:rate,channels:count,channelLayout,sampleFormat:format};inputRate=rate;channels=count;width=widths[base]!;planar=isPlanar;align=channels*width;outputCapacity=Math.floor(options.maxFrameBytes/align);origin=pts;outputOrigin=origin===null?null:rescale(origin,{num:1n,den:BigInt(inputRate)},{num:1n,den:BigInt(outputRate)});
  if(plan.taps){center=Math.floor((plan.taps-1)/2);bank=resampleCoefficients(plan,signal);history=plan.sampleFormat==='s16'?new Int16Array(plan.historySamples*channels):plan.sampleFormat==='flt'?new Float32Array(plan.historySamples*channels):new Float64Array(plan.historySamples*channels);}
 };
 if(checkpoint){
  const layout=validate(checkpoint,options);
  if(checkpoint.outputRate!==outputRate||checkpoint.requestedFormat!==requestedFormat||(checkpoint.plan&&Math.floor(options.maxFrameBytes/(checkpoint.plan.channels*widths[checkpoint.plan.sampleFormat]!))!==checkpoint.format!.frameSamples))invalid('Resampling checkpoint configuration mismatch');
  eof=checkpoint.eof;finished=checkpoint.finished;
  if(checkpoint.plan){
   configure(checkpoint.plan.inputRate,checkpoint.plan.channels,checkpoint.format!.sampleFormat,checkpoint.format!.channelLayout,layout.origin);
   received=layout.received;emitted=layout.emitted;earliest=layout.earliest;started=received>=BigInt(plan!.taps+1);
   const saved=new DataView(checkpoint.history.buffer,checkpoint.history.byteOffset,checkpoint.history.byteLength),count=layout.historyBytes/align;
   for(let sample=0;sample<count;sample++){if((sample&4095)===0)signal?.throwIfAborted();for(let channel=0;channel<channels;channel++){const offset=(sample*channels+channel)*width;history![Number((earliest+BigInt(sample))%BigInt(plan!.historySamples))*channels+channel]=width===2?saved.getInt16(offset,true):width===4?saved.getFloat32(offset,true):saved.getFloat64(offset,true);}}
   filled=layout.pendingBytes/align;
   if(filled){buffer=new Uint8Array(outputCapacity*align);const planeBytes=planar?width:align;for(let plane=0;plane<(planar?channels:1);plane++)buffer.set(checkpoint.pending.subarray(plane*filled*planeBytes,(plane+1)*filled*planeBytes),plane*outputCapacity*planeBytes);}
  }
 }
 const usable=()=>{if(disposed||poisoned)invalid('Resampling state is disposed or poisoned');signal?.throwIfAborted();};
 const idle=()=>{usable();if(busy)invalid('Resampling state is busy');};
 const poison=()=>{poisoned=true;busy=false;buffer=undefined;};
 const inputPosition=(frame:AudioFrameData):bigint|null=>{
  if(frame.pts===null)return null;
  const {num,den}=frame.pts.timeBase,value=frame.pts.value*num*BigInt(frame.sampleRate);
  if(num<=0n||den<=0n||value%den!==0n)throw new AudioConversionError('Resampling requires sample-aligned timestamps');return value/den;
 };
 const output=(data:Uint8Array,count:number):AudioFrameData=>({...template!,sampleRate:outputRate,samples:count,planes:planar?Array.from({length:channels},(_,channel)=>data.subarray(channel*outputCapacity*width,channel*outputCapacity*width+count*width)):[data.subarray(0,count*align)],pts:outputOrigin===null?null:{value:outputOrigin+emitted-BigInt(count),timeBase:{num:1n,den:BigInt(outputRate)}}});
 function* produce(final:boolean,limit:number):Generator<AudioFrameData,void,unknown>{
  const p=plan!;
  if(!started){const tail=final?((received+1n)/2n<BigInt(p.taps/2)?(received+1n)/2n:BigInt(p.taps/2)):0n;if(received+tail<BigInt(p.taps+1)){if(final)finished=true;return;}started=true;}
  const total=final?resampledSampleCount(received,inputRate,outputRate):null;
  for(let count=0;;){
   signal?.throwIfAborted();const numerator=emitted*BigInt(inputRate),whole=numerator/BigInt(outputRate);
   if(total!==null?emitted>=total:whole+BigInt(p.taps-center-1)>=received){if(total!==null){finished=true;if(buffer&&filled){const result=output(buffer,filled);buffer=undefined;filled=0;yield result;}}return;}
   const phasePosition=(numerator%BigInt(outputRate))*BigInt(p.phases),phase=Number(phasePosition/BigInt(outputRate));
   const fraction=p.interpolates?Number(phasePosition%BigInt(outputRate))/outputRate:0;
   if(!buffer)buffer=new Uint8Array(outputCapacity*align);const view=new DataView(buffer.buffer);
   for(let channel=0;channel<channels;channel++){
    let value=0,nextValue=0,odd=0,nextOdd=0;
    for(let tap=0;tap<p.taps;tap++){
     if((tap&4095)===0)signal?.throwIfAborted();
     // Reflect the start around sample zero and the tail around the half-sample boundary.
     let index=whole-BigInt(center)+BigInt(tap);if(index<0n)index=-index;if(index>=received)index=2n*received-1n-index;
     if(index<earliest||index<0n||index>=received)throw new AudioConversionError('Resampling history invariant failed');
     const sample=history![Number(index%BigInt(p.historySamples))*channels+channel]!;
     const product=sample*bank![phase*p.taps+tap]!;
     if(p.sampleFormat==='flt'){if(tap&1)odd=Math.fround(odd+Math.fround(product));else value=Math.fround(value+Math.fround(product));}else value+=product;
     if(fraction){
      // The extra phase is phase zero shifted by one tap, with a zero leading tap.
      const next=phase+1===p.phases?(tap===0?0:bank![tap-1]!):bank![(phase+1)*p.taps+tap]!;
      if(p.sampleFormat==='flt'){if(tap&1)nextOdd=Math.fround(nextOdd+Math.fround(sample*next));else nextValue=Math.fround(nextValue+Math.fround(sample*next));}else nextValue+=sample*next;
     }
    }
    const destination=planar?(channel*outputCapacity+filled)*width:filled*align+channel*width;
    if(p.sampleFormat==='s16'){
     if(fraction)value+=Number(BigInt(nextValue-value)*(phasePosition%BigInt(outputRate))/BigInt(outputRate));
     view.setInt16(destination,Math.max(-32768,Math.min(32767,Math.floor((value+16384)/32768))),true);
    }else if(p.sampleFormat==='flt'){
     value=Math.fround(value+odd);nextValue=Math.fround(nextValue+nextOdd);
     view.setFloat32(destination,fraction?Math.fround(value+Math.fround(nextValue-value)*fraction):value,true);
    }else view.setFloat64(destination,fraction?value+(nextValue-value)*fraction:value,true);
   }
   filled++;emitted++;
   if(filled===outputCapacity){const result=output(buffer,filled);buffer=undefined;filled=0;if(total!==null&&emitted>=total)finished=true;yield result;if(++count>=limit)return;}
  }
 }
 function* process(frame:AudioFrameData):Generator<AudioFrameData,void,unknown>{
  usable();
  const framePlanar=frame.sampleFormat.endsWith('p'),base=framePlanar?frame.sampleFormat.slice(0,-1):frame.sampleFormat;
  const frameWidth=base==='s16'?2:base==='flt'?4:base==='dbl'?8:0,totalBytes=frame.samples*frame.channels*frameWidth;
  if(!frameWidth||(requestedFormat!==null&&requestedFormat!==base)||!Number.isSafeInteger(frame.samples)||frame.samples<1||!Number.isSafeInteger(frame.channels)||frame.channels<1||!validRate(frame.sampleRate)||!Number.isSafeInteger(totalBytes)||totalBytes>options.maxFrameBytes||frame.planes.length!==(framePlanar?frame.channels:1))throw new AudioConversionError('Resampling requires bounded packed or planar s16/flt/dbl frames');
  for(let channel=0;channel<frame.planes.length;channel++){signal?.throwIfAborted();const plane=frame.planes[channel];if(!(plane instanceof Uint8Array)||plane.length!==frame.samples*(framePlanar?1:frame.channels)*frameWidth)throw new AudioConversionError('Invalid resampling plane');}
  const pts=inputPosition(frame);
  if(!plan)configure(frame.sampleRate,frame.channels,frame.sampleFormat,frame.channelLayout,pts);
  else if(frame.sampleFormat!==template!.sampleFormat||frame.sampleRate!==inputRate||frame.channels!==channels||frame.channelLayout!==template!.channelLayout||(origin===null?pts!==null:pts!==origin+received))throw new AudioConversionError('Resampling requires stable format and contiguous timestamps');
  const p=plan!,views=frame.planes.map(plane=>new DataView(plane.buffer,plane.byteOffset,plane.byteLength));
  for(let sample=0;sample<frame.samples;sample++){
   if((sample&4095)===0)signal?.throwIfAborted();
   for(let channel=0;channel<channels;channel++){const view=views[planar?channel:0]!,offset=(planar?sample:sample*channels+channel)*width,value=width===2?view.getInt16(offset,true):width===4?view.getFloat32(offset,true):view.getFloat64(offset,true);if(!Number.isFinite(value))throw new AudioConversionError('Non-finite resampling input is not implemented');if(history)history[Number(received%BigInt(p.historySamples))*channels+channel]=value;}
   received++;
   if(p.taps){yield*produce(false,Number.POSITIVE_INFINITY);earliest=retained(p,received,emitted);if(received-earliest>BigInt(p.historySamples))throw new AudioConversionError('Resampling history exceeds reservation');}
  }
  if(!p.taps){emitted+=BigInt(frame.samples);const owned=convertAudioFrame(frame,frame.sampleFormat as AudioSampleFormat,options);yield {...owned,pts:outputOrigin===null?null:{value:outputOrigin+emitted-BigInt(frame.samples),timeBase:{num:1n,den:BigInt(outputRate)}}};}
 }
 function* drain(limit:number):Generator<AudioFrameData,void,unknown>{
  usable();if(!eof){eof=true;if(!plan||!plan.taps)finished=true;}
  if(!finished)yield*produce(true,limit);
 }
 // Retain the native Generator prototype; completed iterators never modify a later transition's busy/poison state.
 const guard=(engine:Generator<AudioFrameData,void,unknown>):Generator<AudioFrameData,void,unknown>=>{
  const advance=engine.next.bind(engine),close=engine.return.bind(engine),raise=engine.throw.bind(engine);let done=false;
  return Object.assign(engine,{
   next(value?:unknown):IteratorResult<AudioFrameData,void>{if(done)return {done:true,value:undefined};try{usable();const result=advance(value);if(result.done){done=true;busy=false;}return result;}catch(error){done=true;poison();throw error;}},
   return():IteratorResult<AudioFrameData,void>{if(done)return {done:true,value:undefined};try{return close();}finally{poison();done=true;}},
   throw(error?:unknown):IteratorResult<AudioFrameData,void>{if(done)throw error;try{return raise(error);}finally{poison();done=true;}}
  });
 };
 return {
  push(frame){idle();if(eof)invalid('Resampling state has reached end of input');busy=true;return guard(process(frame));},
  finish(maxFrames?:number){idle();if(maxFrames!==undefined&&(!Number.isSafeInteger(maxFrames)||maxFrames<1))invalid('Invalid resampling frame limit');busy=true;return guard(drain(maxFrames??Number.POSITIVE_INFINITY));},
  get finished(){return finished;},
  checkpoint(){
   idle();
   if(!plan)return {version:1,kind:'audio-resample',outputRate,requestedFormat,plan:null,format:null,origin:null,received:'0',emitted:'0',eof,finished,history:new Uint8Array(0),pending:new Uint8Array(0)};
   const start=finished||!plan.taps?received:retained(plan,received,emitted),count=Number(received-start),saved=new Uint8Array(count*align),view=new DataView(saved.buffer);
   for(let sample=0;sample<count;sample++)for(let channel=0;channel<channels;channel++){const value=history![Number((start+BigInt(sample))%BigInt(plan.historySamples))*channels+channel]!,offset=(sample*channels+channel)*width;if(width===2)view.setInt16(offset,value,true);else if(width===4)view.setFloat32(offset,value,true);else view.setFloat64(offset,value,true);}
   const pending=new Uint8Array(filled*align),planeBytes=planar?width:align;if(buffer)for(let plane=0;plane<(planar?channels:1);plane++)pending.set(buffer.subarray(plane*outputCapacity*planeBytes,plane*outputCapacity*planeBytes+filled*planeBytes),plane*filled*planeBytes);
   return {version:1,kind:'audio-resample',outputRate,requestedFormat,plan:{inputRate,outputRate,channels,sampleFormat:plan.sampleFormat,taps:plan.taps,phases:plan.phases,interpolates:plan.interpolates},format:{sampleFormat:template!.sampleFormat,channelLayout:template!.channelLayout,frameSamples:outputCapacity},origin:origin===null?null:String(origin),received:String(received),emitted:String(emitted),eof,finished,history:saved,pending};
  },
  dispose(){disposed=true;buffer=undefined;history=undefined;bank=undefined;template=undefined;}
 };
}
