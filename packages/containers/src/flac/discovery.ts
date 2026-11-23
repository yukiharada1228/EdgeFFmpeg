/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Bounded VFS discovery for FLAC frame-header candidates.
 * See ../../NOTICE-FLAC-PARSER and ../../COPYING.LGPLv2.1. Provider buffers are outside owned metrics.
 */
import{parseFlacHeaderCandidate,updateFlacCrc16}from'@edge-ffmpeg/avcodec';
import type{FlacHeaderCandidate,FlacDiscoveryRequest}from'@edge-ffmpeg/avcodec';
import type{FlacRangeSource,FlacDiscoveryOptions,FlacDiscoveryMetrics}from'./types.js';
function cancellable<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{return new Promise<T>((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});Promise.resolve(pending).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});if(signal.aborted)abort();});}
export function createFlacIntakeDiscovery(input:FlacRangeSource,{startOffset=0n,signal,resources,maxReadBytes=65536,maxScanBytes,maxCandidates=1024}:FlacDiscoveryOptions){
 if(!signal||typeof signal.throwIfAborted!=='function'||typeof resources?.allocate!=='function')throw TypeError('Discovery requires signal and allocator');signal.throwIfAborted();
 if(typeof input?.readAt!=='function'||typeof input.size!=='bigint'||typeof startOffset!=='bigint'||startOffset<0n||startOffset>input.size||!Number.isSafeInteger(maxReadBytes)||maxReadBytes<1||maxReadBytes>65536||typeof maxScanBytes!=='bigint'||maxScanBytes<0n||!Number.isSafeInteger(maxCandidates)||maxCandidates<1)throw RangeError('Invalid discovery bounds');
 const parentSignal=signal,controller=new AbortController(),forwardAbort=()=>controller.abort(parentSignal.reason);signal=controller.signal;
 let owned:ReturnType<typeof resources.allocate>|null=resources.allocate(34),ring:Uint8Array|null=owned.data.subarray(0,17),scratch:Uint8Array|null=owned.data.subarray(17);let head=0,count=0,position=startOffset,readOffset=startOffset,crc=0,closed=false,padded=false,busy=false;
 const stats={readCalls:0,bytesRead:0n,candidates:0,maximumRead:0,ownedBufferBytes:34,peakOwnedBufferBytes:34};
 function close(){if(closed)return;closed=true;signal.removeEventListener('abort',close);parentSignal.removeEventListener('abort',forwardAbort);controller.abort(new Error('FLAC discovery closed'));owned!.release();owned=null;ring=scratch=null;stats.ownedBufferBytes=0;}
 signal.addEventListener('abort',close,{once:true});parentSignal.addEventListener('abort',forwardAbort,{once:true});if(parentSignal.aborted){forwardAbort();signal.throwIfAborted();}
 function candidate(offset:bigint,start:bigint,end:bigint):FlacHeaderCandidate|null{if(offset<start||offset>=end||offset>=readOffset||ring![head]!==255||(ring![(head+1)%17]!&254)!==248)return null;
  for(let i=0;i<17;i++)scratch![i]=i<count?ring![(head+i)%17]!:0;
  const header=parseFlacHeaderCandidate(scratch!);if(header.kind!=='candidate')return null;if(stats.candidates>=maxCandidates)throw RangeError('FLAC discovery candidate budget exceeded');stats.candidates++;return Object.freeze({offset,header,prefixCrc16:crc});
 }
 async function discover(request:FlacDiscoveryRequest):Promise<readonly FlacHeaderCandidate[]>{
  signal.throwIfAborted();if(closed)throw Error('FLAC discovery closed');if(busy)throw Error('Concurrent FLAC discovery');busy=true;
  const found:FlacHeaderCandidate[]=[];let realEnd=readOffset;
  try{
   if(padded)throw Error('Discovery input after EOF padding');
   if(request.padding){if(request.bytes!==16)throw RangeError('Invalid EOF padding');padded=true;}
   else{if(request.physicalOffset!==readOffset||!Number.isSafeInteger(request.bytes)||request.bytes<1||request.physicalOffset+BigInt(request.bytes)>input.size)throw RangeError('Noncontiguous discovery range');if(stats.bytesRead+BigInt(request.bytes)>maxScanBytes)throw RangeError('FLAC discovery scan budget exceeded');realEnd+=BigInt(request.bytes);}
   function feed(byte:number):void{ring![(head+count)%17]=byte;count++;if(count<17)return;const c=candidate(position,request.searchStart,request.searchEndExclusive);if(c)found.push(c);if(position<realEnd)crc=updateFlacCrc16(crc,ring![head]!);head=(head+1)%17;count--;position++;}
   if(request.padding){for(let i=0;i<16;i++)feed(0);}
   else{
    while(readOffset<realEnd){signal.throwIfAborted();const amount=Number(realEnd-readOffset<BigInt(maxReadBytes)?realEnd-readOffset:BigInt(maxReadBytes));stats.readCalls++;stats.maximumRead=Math.max(stats.maximumRead,amount);let pending;try{pending=input.readAt(readOffset,amount,signal);}catch(error){signal.throwIfAborted();throw error;}const chunk=await cancellable(pending,signal);signal.throwIfAborted();if(closed)throw Error('Discovery closed during read');if(!(chunk instanceof Uint8Array)||chunk.length<1||chunk.length>amount)throw Error('Invalid or premature discovery read');readOffset+=BigInt(chunk.length);stats.bytesRead+=BigInt(chunk.length);for(const byte of chunk){signal.throwIfAborted();feed(byte);}}
    // Native scans through fifo_end-16 inclusive, before the next input call.
    if(count===16){const c=candidate(position,request.searchStart,request.searchEndExclusive);if(c)found.push(c);}
   }
   return found;
  }catch(error){close();throw error;}finally{busy=false;}
 }
 return Object.freeze({discover,close,get metrics():FlacDiscoveryMetrics{return Object.freeze({...stats,closed,padded,providerBuffersIncluded:false});}});
}
