/** Experimental standalone-Wasm/Asyncify adapter. No generated JS or Native fallback.
 * Frame planes are borrowed until release();next() rejects unreleased frames.
 * This source has not yet been exercised against a compiled FLAC module. */
const MEMORY_BYTES=16777216;
const fail=message=>new Error('FLAC prototype: '+message);
function bounds(memory,pointer,length){if(!Number.isSafeInteger(pointer)||pointer<0||!Number.isSafeInteger(length)||length<0||pointer+length>memory.buffer.byteLength)throw fail('invalid Wasm buffer range');}
function cancellable(promise,signal){return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason??fail('cancelled'));};signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();});}
export async function createPrototypeFlacDecoder(module,input,options={}){
 const maxReadBytes=options.maxReadBytes??65536,maxFrameBytes=options.maxFrameBytes??4194304;
 if(!(module instanceof WebAssembly.Module)||typeof input.size!=='bigint'||input.size<0n)throw fail('invalid module/input');
 if(!Number.isInteger(maxReadBytes)||maxReadBytes<1||maxReadBytes>1048576||!Number.isInteger(maxFrameBytes)||maxFrameBytes<1||maxFrameBytes>0xffffffff)throw fail('invalid limits');
 if((options.maxMemoryBytes??MEMORY_BYTES)<MEMORY_BYTES)throw fail('Wasm reservation exceeds memory budget');
 const inputSize=input.size,readAt=input.readAt.bind(input);
 const controller=new AbortController(),external=options.signal,forward=()=>controller.abort(external.reason);if(external){if(external.aborted)forward();else external.addEventListener('abort',forward,{once:true});}controller.signal.throwIfAborted();
 let reservation,instance,exports,memory,handle=0,phase='idle',request,result,hostFailure,offset=0n,busy=false,active,closing=false,closed=false,closePromise,releaseBorrowed,metadata=null;
 function readImport(pointer,capacity){
  bounds(memory,pointer,capacity);if(capacity<1||capacity>maxReadBytes)throw fail('invalid read callback capacity');
  if(phase==='rewinding'){
   if(!request||request.pointer!==pointer||request.capacity!==capacity)throw fail('rewind request changed');
   exports.asyncify_stop_rewind();phase='running';const value=result;result=undefined;request=undefined;
   if(value instanceof Uint8Array){new Uint8Array(memory.buffer,pointer,value.length).set(value);offset+=BigInt(value.length);return value.length;}
   return -1;
  }
  if(phase!=='running')throw fail('unexpected read callback state');
  request={pointer,capacity,offset};phase='unwinding';exports.asyncify_start_unwind(exports.edge_flac_async_data(1));return 0;
 }
 async function runStep(){
  if(phase!=='idle')throw fail('decoder is not idle');controller.signal.throwIfAborted();await options.checkpoint?.();phase='running';
  try{while(true){const status=exports.edge_flac_step(handle);
   if(phase==='unwinding'){
    exports.asyncify_stop_unwind();phase='awaiting';
    try{controller.signal.throwIfAborted();const remaining=inputSize-request.offset,amount=remaining>BigInt(request.capacity)?request.capacity:Number(remaining);
     const bytes=amount===0?new Uint8Array(0):await cancellable(readAt(request.offset,amount,controller.signal),controller.signal);
     if(!(bytes instanceof Uint8Array)||bytes.length>amount||(amount>0&&bytes.length===0))throw fail('invalid or premature input read');result=bytes;
    }catch(error){hostFailure??=error;result=null;}
    phase='rewinding';exports.asyncify_start_rewind(exports.edge_flac_async_data(0));continue;
   }
   if(phase!=='running')throw fail('unbalanced Asyncify transition');phase='idle';
   const pointer=exports.edge_flac_info(handle);bounds(memory,pointer,29*4);const info=new Uint32Array(memory.buffer,pointer,29).slice();
   if(memory.buffer.byteLength!==MEMORY_BYTES||info[0]!==1||info[1]!==status)throw fail('invalid result ABI');
   if(hostFailure!==undefined)throw hostFailure;if(status===4)throw fail(`decode rejected(state=${info[2]},codec=${info[3]},wrapper=${info[4]},finish=${info[27]})`);
   metadata=Object.freeze({channels:info[5],sampleRate:info[6],bitsPerSample:info[7],totalSamples:BigInt(info[11])|(BigInt(info[12])<<32n),maxBlockSamples:info[13]});
   controller.signal.throwIfAborted();await options.checkpoint?.();
   if(status===1)return {status:'metadata',metadata};if(status===3)return {status:'end',metadata};
   if(status!==2||info[14]!==info[5]||info[14]<1||info[14]>8||info[8]<1||info[8]>65535||info[23]!==info[14]*info[8]*4||info[23]>maxFrameBytes)throw fail('invalid frame result');
   const planes=[];for(let channel=0;channel<info[14];channel++){const pointer=info[15+channel];bounds(memory,pointer,info[8]*4);if(pointer%4)throw fail('unaligned PCM plane');planes.push(new Int32Array(memory.buffer,pointer,info[8]));}
   let alive=true;const release=()=>{if(!alive)return;alive=false;releaseBorrowed=undefined;};releaseBorrowed=release;
   return Object.freeze({status:'frame',metadata,samples:info[8],samplePosition:BigInt(info[9])|(BigInt(info[10])<<32n),get planes(){if(!alive)throw fail('frame was released');return planes;},release});
  }}catch(error){if(phase!=='idle')phase='failed';throw error;}
 }
 async function close(){if(closePromise)return closePromise;closing=true;controller.abort(fail('decoder closed'));closePromise=Promise.resolve().then(async()=>{try{if(active)await active.catch(()=>{});releaseBorrowed?.();if(handle&&phase!=='failed')exports.edge_flac_destroy(handle);}finally{handle=0;closed=true;external?.removeEventListener('abort',forward);instance=undefined;exports=undefined;memory=undefined;reservation?.();reservation=undefined;}});return closePromise;}
 try{
  reservation=options.reserve?.(MEMORY_BYTES);
  const imports={env:{edge_host_read:readImport},wasi_snapshot_preview1:{proc_exit(code){throw fail('unexpected WASI exit:'+code);},fd_write(){throw fail('unexpected stdio write');},fd_read(){throw fail('unexpected stdio read');},fd_close(){throw fail('unexpected file close');},fd_seek(){throw fail('unexpected file seek');}}};
  for(const item of WebAssembly.Module.imports(module))if(item.kind!=='function'||typeof imports[item.module]?.[item.name]!=='function')throw fail('unapproved Wasm import:'+item.module+'.'+item.name);
  instance=new WebAssembly.Instance(module,imports);exports=instance.exports;memory=exports.memory;
  if(!(memory instanceof WebAssembly.Memory)||memory.buffer.byteLength!==MEMORY_BYTES)throw fail('unexpected Wasm memory');
  exports._initialize?.();if(exports.edge_flac_abi()!==1||exports.edge_flac_info_words()!==29)throw fail('unsupported ABI');
  for(const name of ['asyncify_start_unwind','asyncify_stop_unwind','asyncify_start_rewind','asyncify_stop_rewind'])if(typeof exports[name]!=='function')throw fail('missing Asyncify export:'+name);
  handle=exports.edge_flac_create(maxReadBytes,maxFrameBytes,options.md5Checking?1:0);if(!handle)throw fail('decoder allocation/init failed');
  return {get metadata(){return metadata;},get bytesRead(){return offset;},get memoryBytes(){return memory?.buffer.byteLength??0;},async next(){if(closed||closing||busy||releaseBorrowed)throw fail('closed,busy,or unreleased frame');busy=true;active=Promise.resolve().then(runStep);try{const value=await active;if(closing)throw fail('decoder closed');return value;}finally{busy=false;active=undefined;}},close};
 }catch(error){await close();throw error;}
}
