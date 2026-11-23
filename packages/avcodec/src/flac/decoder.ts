import type {FlacDecoder, FlacDecoderInput, FlacDecoderOptions, FlacDecoderMetadata, FlacDecoderResult} from './decoder-types.js';
import {waitForDecoder} from './decoder-wait.js';
/** Original TypeScript host adapter for libFLAC 1.5.0, BSD-3-Clause.
 * Pinned source archive SHA256 f2c1c76592a82ffff8413ba3c4a1299b6c7ab06c734dee03fd88630485c2b920.
 * ABI: edge wrapper v1, 29 words, standalone fixed 16MiB Asyncify.
 * Caller must supply a trusted compiled module; structural validation is not a sandbox for arbitrary modules.
 */
type FlacExports = {
 memory: WebAssembly.Memory;
 _initialize?: () => void;
 edge_flac_abi: () => number; edge_flac_info_words: () => number;
 edge_flac_create: (read: number, frame: number, md5: number) => number;
 edge_flac_destroy: (handle: number) => void; edge_flac_step: (handle: number) => number;
 edge_flac_info: (handle: number) => number; edge_flac_async_data: (reset: number) => number;
 asyncify_start_unwind: (pointer: number) => void; asyncify_stop_unwind: () => void;
 asyncify_start_rewind: (pointer: number) => void; asyncify_stop_rewind: () => void;
};
const MEMORY_BYTES=16777216;
const fail=(message: string)=>new Error('FLAC decoder: '+message);
function bounds(memory: WebAssembly.Memory,pointer: number,length: number){if(!Number.isSafeInteger(pointer)||pointer<0||!Number.isSafeInteger(length)||length<0||pointer+length>memory.buffer.byteLength)throw fail('invalid Wasm buffer range');}
export async function createFlacDecoder(module: WebAssembly.Module,input: FlacDecoderInput,options: FlacDecoderOptions): Promise<FlacDecoder>{
 const maxReadBytes=options.maxReadBytes??65536,maxFrameBytes=options.maxFrameBytes??4194304;
 if(!(module instanceof WebAssembly.Module)||typeof input.size!=='bigint')throw fail('invalid module/input');
 if(!Number.isInteger(maxReadBytes)||maxReadBytes<1||maxReadBytes>1048576||!Number.isInteger(maxFrameBytes)||maxFrameBytes<1||maxFrameBytes>0xffffffff)throw fail('invalid limits');
 const reserve=options.reserveExternalMemory,checkpoint=options.checkpoint,md5Checking=options.md5Checking===true;
 if(typeof reserve!=='function')throw fail('external memory reservation capability required');
 const inputSize=input.size,readAt=input.readAt.bind(input);
 if(inputSize<0n||inputSize>0x7fffffffffffffffn)throw fail('invalid input size');
 const controller=new AbortController(),external=options.signal;
 external?.throwIfAborted();
 const forward=()=>{controller.abort(external!.reason);void close().catch(()=>{});};
 let reservation: (()=>void)|undefined,instance: WebAssembly.Instance|undefined,exports: FlacExports,memory: WebAssembly.Memory,handle=0,phase: string='idle',request: {pointer:number;capacity:number;offset:bigint}|undefined,result: Uint8Array|null|undefined,hostFailure: unknown,hasHostFailure=false,offset=0n,busy=false,active: Promise<FlacDecoderResult>|undefined,closing=false,closed=false,closePromise: Promise<void>|undefined,releaseBorrowed: (()=>void)|undefined,metadata: FlacDecoderMetadata|null=null;
 if(external)external.addEventListener('abort',forward,{once:true});
 function asyncData(reset: number): number {
  const pointer=exports.edge_flac_async_data(reset);bounds(memory,pointer,8);if(pointer%4)throw fail('unaligned Asyncify data');
  const data=new Uint32Array(memory.buffer,pointer,2);
  if(data[0]!>=data[1]!)throw fail('invalid Asyncify stack');bounds(memory,data[0]!,data[1]!-data[0]!);return pointer;
 }
 function readImport(pointer: number,capacity: number){
  bounds(memory,pointer,capacity);if(capacity<1||capacity>maxReadBytes)throw fail('invalid read callback capacity');
  if(phase==='rewinding'){
   if(!request||request.pointer!==pointer||request!.capacity!==capacity)throw fail('rewind request changed');
   exports.asyncify_stop_rewind();phase='running';const value=result;result=undefined;request=undefined;
   if(value instanceof Uint8Array){new Uint8Array(memory.buffer,pointer,value.length).set(value);offset+=BigInt(value.length);return value.length;}
   return -1;
  }
  if(phase!=='running')throw fail('unexpected read callback state');
  request={pointer,capacity,offset};phase='unwinding';exports.asyncify_start_unwind(asyncData(1));return 0;
 }
 async function runStep(): Promise<FlacDecoderResult>{
  if(phase!=='idle')throw fail('decoder is not idle');if(memory.buffer.byteLength!==MEMORY_BYTES)throw fail('unexpected Wasm memory');controller.signal.throwIfAborted();await waitForDecoder(checkpoint?.(),controller.signal);controller.signal.throwIfAborted();phase='running';
  try{while(true){const status=exports.edge_flac_step(handle);
   if(phase==='unwinding'){
    exports.asyncify_stop_unwind();phase='awaiting';
    try{controller.signal.throwIfAborted();const remaining=inputSize-request!.offset,amount=remaining>BigInt(request!.capacity)?request!.capacity:Number(remaining);
     const bytes=amount===0?new Uint8Array(0):await waitForDecoder(readAt(request!.offset,amount,controller.signal),controller.signal);
     controller.signal.throwIfAborted();
     if(!(bytes instanceof Uint8Array)||bytes.length>amount||(amount>0&&bytes.length===0))throw fail('invalid or premature input read');result=bytes;
    }catch(error){if(!hasHostFailure){hostFailure=error;hasHostFailure=true;}result=null;}
    phase='rewinding';exports.asyncify_start_rewind(asyncData(0));continue;
   }
   if(phase!=='running')throw fail('unbalanced Asyncify transition');phase='idle';
   const pointer=exports.edge_flac_info(handle);bounds(memory,pointer,29*4);if(pointer===0||pointer%4)throw fail('unaligned or null result ABI');const info=Array.from(new Uint32Array(memory.buffer,pointer,29));
   if(memory.buffer.byteLength!==MEMORY_BYTES||info[0]! !==1||info[1]! !==status)throw fail('invalid result ABI');
   if(hasHostFailure)throw hostFailure;if(status===4)throw fail(`decode rejected(state=${info[2]!},codec=${info[3]!},wrapper=${info[4]!},finish=${info[27]!})`);
   if(info[12]!>0x7fffffff||info[24]! !==maxReadBytes||info[25]! !==maxFrameBytes)throw fail('invalid result limits');
   if(info[5]!<1||info[5]!>8||info[6]!<1||info[6]!>655350||info[7]!<4||info[7]!>32||info[13]!>65535)throw fail('invalid stream parameters');
   metadata=Object.freeze({channels:info[5]!,sampleRate:info[6]!,bitsPerSample:info[7]!,totalSamples:BigInt(info[11]!)|(BigInt(info[12]!)<<32n),maxBlockSamples:info[13]!});
   controller.signal.throwIfAborted();await waitForDecoder(checkpoint?.(),controller.signal);controller.signal.throwIfAborted();
   if(status===1)return {status:'metadata',metadata};if(status===3)return {status:'end',metadata};
   if(status!==2||info[14]! !==info[5]!||info[14]!<1||info[14]!>8||info[8]!<1||info[8]!>65535||info[23]! !==info[14]!*info[8]!*4||info[23]!>maxFrameBytes)throw fail('invalid frame result');
   const samplePosition=BigInt(info[9]!)|(BigInt(info[10]!)<<32n);
   if(samplePosition+BigInt(info[8]!)>0x7fffffffffffffffn)throw fail('invalid sample position');
   const planes: Int32Array[]=[];for(let channel=0;channel<info[14]!;channel++){const pointer=info[15+channel]!;bounds(memory,pointer,info[8]!*4);if(pointer===0||pointer%4)throw fail('unaligned or null PCM plane');planes.push(new Int32Array(memory.buffer,pointer,info[8]!));}
   Object.freeze(planes);
   let alive=true;const release=()=>{if(!alive)return;alive=false;releaseBorrowed=undefined;};releaseBorrowed=release;
   return Object.freeze({status:'frame',metadata,samples:info[8]!,samplePosition,get planes(){if(!alive)throw fail('frame was released');return planes;},release});
  }}catch(error){if(phase!=='idle')phase='failed';throw error;}
 }
 async function close(){if(closePromise)return closePromise;closing=true;controller.abort(fail('decoder closed'));closePromise=Promise.resolve().then(async()=>{try{if(active)await active.catch(()=>{});releaseBorrowed?.();if(handle&&phase!=='failed')exports.edge_flac_destroy(handle);}finally{handle=0;closed=true;external?.removeEventListener('abort',forward);instance=undefined;exports=undefined!;memory=undefined!;const release=reservation;reservation=undefined;release?.();}});return closePromise;}
 try{
  reservation=reserve(MEMORY_BYTES);if(typeof reservation!=='function')throw fail('invalid reservation release');
  controller.signal.throwIfAborted();
  const imports: Record<string,Record<string,WebAssembly.ImportValue>>={env:{edge_host_read:readImport},wasi_snapshot_preview1:{proc_exit(code: number){throw fail('unexpected WASI exit:'+code);},fd_write(){throw fail('unexpected stdio write');},fd_read(){throw fail('unexpected stdio read');},fd_close(){throw fail('unexpected file close');},fd_seek(){throw fail('unexpected file seek');}}};
  for(const item of WebAssembly.Module.imports(module))if(item.kind!=='function'||!Object.hasOwn(imports,item.module)||!Object.hasOwn(imports[item.module]!,item.name)||typeof imports[item.module]?.[item.name]!=='function')throw fail('unapproved Wasm import:'+item.module+'.'+item.name);
  instance=new WebAssembly.Instance(module,imports);exports=instance.exports as unknown as FlacExports;memory=exports.memory;
  if(!(memory instanceof WebAssembly.Memory)||!(memory.buffer instanceof ArrayBuffer)||memory.buffer.byteLength!==MEMORY_BYTES)throw fail('unexpected Wasm memory');
  for(const name of ['edge_flac_abi','edge_flac_info_words','edge_flac_create','edge_flac_destroy','edge_flac_step','edge_flac_info','edge_flac_async_data'])if(typeof (instance.exports[name])!=='function')throw fail('missing decoder export:'+name);
  exports._initialize?.();if(exports.edge_flac_abi()!==1||exports.edge_flac_info_words()!==29)throw fail('unsupported ABI');
  for(const name of ['asyncify_start_unwind','asyncify_stop_unwind','asyncify_start_rewind','asyncify_stop_rewind'])if(typeof instance.exports[name]!=='function')throw fail('missing Asyncify export:'+name);
  handle=exports.edge_flac_create(maxReadBytes,maxFrameBytes,md5Checking?1:0);if(!Number.isSafeInteger(handle)||handle<=0||handle>=MEMORY_BYTES)throw fail('decoder allocation/init failed');controller.signal.throwIfAborted();
  return {get metadata(){return metadata;},get bytesRead(){return offset;},get memoryBytes(){return closed?0:memory.buffer.byteLength;},async next(){if(closed||closing||busy||releaseBorrowed)throw fail('closed,busy,or unreleased frame');busy=true;active=Promise.resolve().then(runStep);try{const value=await active;if(closing)throw fail('decoder closed');return value;}catch(error){busy=false;active=undefined;await close();throw error;}finally{busy=false;active=undefined;}},close};
 }catch(error){await close();throw error;}
}
