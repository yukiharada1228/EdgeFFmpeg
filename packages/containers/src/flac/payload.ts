/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Bounded, owned packet payload reads for FLAC ranges.
 * One borrowed chunk at a time; caller must release before requesting another.
 */
import{waitForFlacAbort}from'./abort-wait.js';
import type{FlacRangeSource,FlacPacketChunkOptions,FlacPacketChunkReader,FlacPacketChunk}from'./types.js';
export function readFlacPacketChunks(input:FlacRangeSource,range:{readonly sourceOffset:bigint;readonly bytes:bigint},{resources,signal,maxReadBytes=65536,maxPacketBytes,checkpoint}:FlacPacketChunkOptions):FlacPacketChunkReader{
 if(typeof resources?.allocate!=='function'||typeof signal?.throwIfAborted!=='function')throw new TypeError('Packet reader requires allocator and signal');signal.throwIfAborted();
 const size=input.size,readAt=input.readAt.bind(input),readInto=input.readInto?.bind(input),offset=range.sourceOffset,length=range.bytes;
 if(typeof size!=='bigint'||size<0n||size>0x7fffffffffffffffn||typeof offset!=='bigint'||offset<0n||typeof length!=='bigint'||length<0n||offset+length>size||typeof maxPacketBytes!=='bigint'||maxPacketBytes<0n||length>maxPacketBytes||!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1||maxReadBytes>65536)throw new RangeError('Packet read bounds exceeded');
 let started=false;const stats={readCalls:0,bytesRead:0n,ownedBufferBytes:0,peakOwnedBufferBytes:0,completed:false,closed:false};
 async function* iterate():AsyncGenerator<FlacPacketChunk,void,unknown>{let held:(()=>void)|null=null;try{let consumed=0n;
  while(consumed<length){signal.throwIfAborted();await waitForFlacAbort(checkpoint?.(),signal);signal.throwIfAborted();const amount=Number(length-consumed<BigInt(maxReadBytes)?length-consumed:BigInt(maxReadBytes)),owned=resources.allocate(amount);let released=false,reading=false;
   const release=()=>{if(!released&&!reading){released=true;signal.removeEventListener('abort',release);owned.release();stats.ownedBufferBytes-=amount;}};held=release;stats.ownedBufferBytes+=amount;stats.peakOwnedBufferBytes=Math.max(stats.peakOwnedBufferBytes,stats.ownedBufferBytes);signal.addEventListener('abort',release,{once:true});
   signal.throwIfAborted();stats.readCalls++;let received:number;if(readInto){reading=true;try{received=readInto(offset+consumed,owned.data,signal);}finally{reading=false;}signal.throwIfAborted();if(!Number.isSafeInteger(received)||received<1||received>amount)throw new Error('Invalid or premature packet read');}else{let pending;try{pending=readAt(offset+consumed,amount,signal);}catch(error){signal.throwIfAborted();throw error;}const bytes=await waitForFlacAbort(pending,signal);signal.throwIfAborted();if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>amount)throw new Error('Invalid or premature packet read');owned.data.set(bytes);received=bytes.length;}const view=owned.data.subarray(0,received),chunkOffset=offset+consumed;consumed+=BigInt(received);stats.bytesRead+=BigInt(received);
   yield Object.freeze({offset:chunkOffset,get data(){if(released)throw new Error('Packet chunk is released');return view;},release});
   signal.throwIfAborted();if(!released)throw new Error('Release packet chunk before advancing');held=null;
  }stats.completed=true;
 }finally{held?.();stats.closed=true;}}
 return {get metrics(){return Object.freeze({...stats,providerBufferAccounted:false});},[Symbol.asyncIterator](){if(started)throw new Error('Packet chunk reader is one-shot');started=true;return iterate();}};
}
