import {reduceBoundedRational} from '@edge-ffmpeg/avutil';
import type {MediaPacket,VideoFrameData,Rational,Timestamp} from '@edge-ffmpeg/avutil';
import {inspectH264AnnexB,H264InputError,H264ResourceError,H264ParameterSets} from './sps.js';
import type {H264Sps} from './sps.js';
export interface H264DecoderOptions {readonly maxPacketBytes:number;readonly maxFrameBytes:number;readonly maxMemoryBytes:number;readonly maxResidentBytes:number;readonly maxPendingPackets:number;readonly maxNalUnits:number;readonly signal?:AbortSignal}
export interface H264VideoParameters {readonly width:number;readonly height:number;readonly pixelFormat:string;readonly sampleAspectRatio:Rational;readonly frameRate:Rational}
export interface H264DecodedFrame {readonly discard?:boolean;readonly packetDts?:bigint|null;readonly bestEffortTimestamp?:Timestamp|null;readonly frame:VideoFrameData;readonly duration:bigint|null;readonly packetToken:bigint;readonly streamIndex:number;readonly pictureOrder:{readonly poc:number;readonly reset:boolean;readonly key:boolean;readonly type:'I'|'P'|'B';readonly restricted:boolean;readonly reorder:number}}
function videoParameters(sps:H264Sps,pixelFormat:string):Readonly<H264VideoParameters>{const rate=reduceBoundedRational(BigInt(sps.timingNum),BigInt(sps.timingDen));return Object.freeze({width:sps.width,height:sps.height,pixelFormat,frameRate:Object.freeze({num:rate.num,den:rate.den}),sampleAspectRatio:Object.freeze({num:BigInt(sps.sarNum),den:BigInt(sps.sarDen)})});}
interface Api extends WebAssembly.Exports {readonly edge_abi_version:()=>number;readonly edge_create:()=>number;readonly edge_decode_order:(handle:number,enabled:number)=>void;readonly edge_destroy:(handle:number)=>void;readonly edge_decode:(handle:number,packet:number,length:number,token:bigint,flush:number)=>number;readonly edge_info:(handle:number)=>number;readonly edge_forbidden_thread_calls:()=>number;readonly malloc:(bytes:number)=>number;readonly free:(pointer:number)=>void}
interface Pending {discard:boolean;sps:H264Sps;pixelFormat:'yuv420p'|'yuvj420p';colorRange:number;colorSpace:number;key:boolean;pts:bigint|null;duration:bigint|null;timeBase:Rational;streamIndex:number}
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n;

export function validateH264DecoderOptions(options:H264DecoderOptions):Readonly<H264DecoderOptions>{
 const settings={...options},signal=settings.signal;signal?.throwIfAborted();
 for(const key of ['maxPacketBytes','maxFrameBytes','maxMemoryBytes','maxResidentBytes','maxPendingPackets','maxNalUnits'] as const)if(!Number.isSafeInteger(settings[key])||settings[key]<1||settings[key]>2147483647)throw new H264InputError('Invalid H264 '+key);
 if(settings.maxMemoryBytes<16777216||settings.maxMemoryBytes>67108864||settings.maxMemoryBytes%65536!==0)throw new H264InputError('Unsupported H264 Wasm memory budget');
 const reserve=147456n+BigInt(settings.maxMemoryBytes)+6n*BigInt(settings.maxPacketBytes)+2n*BigInt(settings.maxFrameBytes)+1024n*BigInt(settings.maxPendingPackets)+512n*BigInt(settings.maxNalUnits);
 if(reserve>BigInt(settings.maxResidentBytes))throw new H264ResourceError('resident-bytes','H264 aggregate payload reservation exceeds resident budget');
 return Object.freeze(settings);
}
function instantiateH264(module:WebAssembly.Module,settings:Readonly<H264DecoderOptions>){
 let memory:WebAssembly.Memory;
 try{memory=new WebAssembly.Memory({initial:256,maximum:settings.maxMemoryBytes/65536});}catch(error){if(error instanceof RangeError)throw new H264ResourceError('wasm-memory','H264 Wasm memory allocation failed',{cause:error});throw error;}
 let hostCalls=0,peakWasmMemoryBytes=memory.buffer.byteLength;
 const denied=()=>{hostCalls++;return 8;};
 const instance=new WebAssembly.Instance(module,{env:{memory,emscripten_notify_memory_growth(){peakWasmMemoryBytes=Math.max(peakWasmMemoryBytes,memory.buffer.byteLength);}},wasi_snapshot_preview1:{clock_time_get(clock:number,_precision:bigint,out:number){if(clock!==0&&clock!==1){hostCalls++;return 58;}const value=clock===0?BigInt(Date.now())*1000000n:BigInt(Math.floor(performance.now()*1000000));new DataView(memory.buffer).setBigUint64(out,value,true);return 0;},fd_write:denied,fd_close:denied,fd_seek:denied}}),api=instance.exports as Api;
 for(const key of ['edge_abi_version','edge_create','edge_decode_order','edge_destroy','edge_decode','edge_info','edge_forbidden_thread_calls','malloc','free'] as const)if(typeof api[key]!=='function')throw new H264InputError('Incomplete H264 Wasm ABI');
 if(api.edge_abi_version()!==2)throw new H264InputError('Unsupported H264 Wasm ABI version');
 return {memory,api,get peakWasmMemoryBytes(){return Math.max(peakWasmMemoryBytes,memory.buffer.byteLength);},get hostCalls(){return hostCalls;}};
}
/** Trusted precompiled module, one instance per decoder; no native fallback. */
export function createDecodeOrderH264Decoder(module:WebAssembly.Module,options:H264DecoderOptions){
 const settings=validateH264DecoderOptions(options),signal=settings.signal;
 const allowed=new Set(['env:memory:memory','env:emscripten_notify_memory_growth:function','wasi_snapshot_preview1:clock_time_get:function','wasi_snapshot_preview1:fd_write:function','wasi_snapshot_preview1:fd_close:function','wasi_snapshot_preview1:fd_seek:function']);
 for(const item of WebAssembly.Module.imports(module))if(!allowed.has(`${item.module}:${item.name}:${item.kind}`))throw new H264InputError('Unsupported H264 Wasm import');
 let runtime:ReturnType<typeof instantiateH264>|undefined=instantiateH264(module,settings);
 let parameters:Readonly<H264VideoParameters>|null=null;
 let handle=runtime.api.edge_create(),closed=false,drained=false,flushing=false,flushCalls=0,nextToken=1n,streamIndex:number|undefined;const pending=new Map<bigint,Pending>(),parameterSets=new H264ParameterSets();
 if(!handle){runtime=undefined;throw new H264ResourceError('wasm-memory','H264 decoder initialization failed');}
 runtime.api.edge_decode_order(handle,1);let peakWasmMemoryBytes=runtime.peakWasmMemoryBytes;
 const close=()=>{if(closed)return;closed=true;parameters=null;pending.clear();parameterSets.clear();const current=handle;handle=0;const released=runtime;runtime=undefined;try{released?.api.edge_destroy(current);}finally{peakWasmMemoryBytes=Math.max(peakWasmMemoryBytes,released?.peakWasmMemoryBytes??0);}};
 const fail=(error:unknown):never=>{try{close();}catch(cleanup){throw new AggregateError([error,cleanup],'H264 decoder and cleanup failed');}throw error;};
 const check=()=>{signal?.throwIfAborted();if(closed)throw new H264InputError('H264 decoder is closed');};
 const output=():H264DecodedFrame|null=>{
  if(!runtime)throw new H264InputError('H264 decoder is closed');
  const {memory,api}=runtime;
  if(runtime.hostCalls||api.edge_forbidden_thread_calls())throw new H264InputError('H264 attempted an unsupported runtime operation');
  const at=api.edge_info(handle);if(at<=0||at%4||at+72>memory.buffer.byteLength)throw new H264InputError('Invalid H264 frame metadata');
  const info=Array.from(new Uint32Array(memory.buffer,at,18));if(!info[0])return null;
  const width=info[2]!,height=info[3]!,token=BigInt(info[9]!)+(BigInt(info[10]!)<<32n),stamp=pending.get(token);
  if(!stamp||info[11]!==23||width<1||height<1)throw new H264InputError('Invalid H264 decoded frame or timestamp token');
  const columns=[width,Math.ceil(width/2),Math.ceil(width/2)],rows=[height,Math.ceil(height/2),Math.ceil(height/2)],bytes=columns.reduce((n,w,i)=>n+w*rows[i]!,0);
  if(!Number.isSafeInteger(bytes))throw new H264InputError('Invalid H264 decoded frame geometry');if(bytes>settings.maxFrameBytes)throw new H264ResourceError('frame-bytes','H264 decoded frame exceeds budget');
  for(let p=0;p<3;p++){const stride=info[p===0?4:5]!,pointer=info[6+p]!;if(stride<columns[p]!||pointer<1||pointer+stride*(rows[p]!-1)+columns[p]!>memory.buffer.byteLength)throw new H264InputError('Invalid H264 decoded plane bounds');}
  const data=new Uint8Array(bytes),planes:Uint8Array[]=[];let position=0;
  for(let p=0;p<3;p++){signal?.throwIfAborted();const start=position;for(let y=0;y<rows[p]!;y++){data.set(new Uint8Array(memory.buffer,info[6+p]!+y*info[p===0?4:5]!,columns[p]),position);position+=columns[p]!;}planes.push(data.subarray(start,position));}
  pending.delete(token);return {discard:stamp.discard,frame:{width,height,pixelFormat:stamp.pixelFormat,planes,linesizes:columns,pts:stamp.pts===null?null:{value:stamp.pts,timeBase:{...stamp.timeBase}},metadata:{colorRange:stamp.colorRange,colorSpace:stamp.colorSpace,sampleAspectRatio:Object.freeze({num:BigInt(stamp.sps.sarNum),den:BigInt(stamp.sps.sarDen)})}},duration:stamp.duration,packetToken:token,streamIndex:stamp.streamIndex,pictureOrder:{poc:info[12]!|0,reset:info[17]===1,key:stamp.key,restricted:stamp.sps.restricted,reorder:stamp.sps.maxReorder,type:info[16]===1?'B':info[16]===2||info[16]===4?'I':'P'}};
 };
 return Object.freeze({
  get parameters(){return parameters;},
  get memoryBytes(){return runtime?.memory.buffer.byteLength??0;},get peakWasmMemoryBytes(){return Math.max(peakWasmMemoryBytes,runtime?.peakWasmMemoryBytes??0);},get pendingPackets(){return pending.size;},get isClosed(){return closed;},
  feed(packet:MediaPacket):readonly H264DecodedFrame[]{try{
   check();if(!runtime)throw new H264InputError('H264 decoder is closed');const {memory,api}=runtime;if(flushing||drained)throw new H264InputError('H264 decoder is already draining');
   if(!(packet.data instanceof Uint8Array)||packet.data.length<1)throw new H264InputError('Invalid H264 packet');if(packet.data.length>settings.maxPacketBytes)throw new H264ResourceError('packet-bytes','H264 packet exceeds budget');
   if(!Number.isSafeInteger(packet.streamIndex)||packet.streamIndex<0||streamIndex!==undefined&&packet.streamIndex!==streamIndex)throw new H264InputError('H264 decoder requires one input stream');
   for(const stamp of [packet.pts,packet.dts,packet.duration])if(stamp!==null&&(typeof stamp!=='bigint'||stamp<MIN||stamp>MAX))throw new H264InputError('Invalid H264 packet timestamp');
   if(typeof packet.timeBase.num!=='bigint'||typeof packet.timeBase.den!=='bigint'||packet.timeBase.num<1n||packet.timeBase.den<1n||packet.timeBase.num>2147483647n||packet.timeBase.den>2147483647n)throw new H264InputError('Invalid H264 packet time base');
   const owned=new Uint8Array(packet.data),inspection=inspectH264AnnexB(owned,settings.maxFrameBytes,settings.maxNalUnits),activeSps=parameterSets.update(inspection),token=inspection.hasVcl?nextToken++:0n;
   if(inspection.hasVcl&&pending.size>=settings.maxPendingPackets)throw new H264ResourceError('pending-packets','H264 pending packet budget exceeded');
   if(token>MAX)throw new H264InputError('H264 packet token overflow');
   if(inspection.hasVcl){const pixelFormat=parameterSets.formatForPicture(activeSps!);parameters=videoParameters(activeSps!,pixelFormat);pending.set(token,{discard:!!(packet.flags&4),sps:activeSps!,pixelFormat,colorRange:parameterSets.pictureColorRange,colorSpace:parameterSets.pictureColorSpace,key:inspection.units.some(unit=>unit.type===5),pts:packet.pts===MIN?null:packet.pts,duration:packet.duration,timeBase:{...packet.timeBase},streamIndex:packet.streamIndex});}streamIndex=packet.streamIndex;
   const pointer=api.malloc(owned.length);if(!pointer)throw new H264ResourceError('wasm-memory','H264 packet allocation failed');
   let result:H264DecodedFrame|null;
   try{new Uint8Array(memory.buffer,pointer,owned.length).set(owned);const status=api.edge_decode(handle,pointer,owned.length,token,0);signal?.throwIfAborted();if(status>0&&(status&0x4000))throw new H264ResourceError('wasm-memory','H264 decoder memory allocation failed (status '+status+')');if(status!==0)throw new H264InputError('H264 decode status '+status);result=output();}finally{api.free(pointer);}
   return result?[result]:[];
  }catch(error){return fail(error);}},
  flush():H264DecodedFrame|null{try{
   check();if(!runtime)throw new H264InputError('H264 decoder is closed');const {api}=runtime;if(drained)return null;flushing=true;
   if(++flushCalls>settings.maxPendingPackets+1)throw new H264InputError('H264 flush exceeds pending packet bound');
   const status=api.edge_decode(handle,0,0,0n,1);signal?.throwIfAborted();if(status>0&&(status&0x4000))throw new H264ResourceError('wasm-memory','H264 flush memory allocation failed (status '+status+')');if(status!==0)throw new H264InputError('H264 flush status '+status);const frame=output();
   if(!frame){if(pending.size)throw new H264InputError('H264 decoder ended with pending pictures');drained=true;}return frame;
  }catch(error){return fail(error);}},close
 });
}
