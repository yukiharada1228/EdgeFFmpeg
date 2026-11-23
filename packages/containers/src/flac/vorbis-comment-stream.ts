/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Bounded VFS entry reader for adapted comment semantics; see NOTICE-vorbis-comment.
 * Vendor data is skipped. Returned strings/objects are separately bounded but
 * not charged as owned byte buffers. Invalid UTF8 retains a source range only.
 */
import {createVorbisCommentCollector,VorbisCommentLimitError} from './vorbis-comment.js';
import {waitForFlacAbort} from './abort-wait.js';
import type {FlacRangeSource} from './types.js';
import type {VorbisCommentReadOptions} from './comment-types.js';
export async function readVorbisCommentRange(input:FlacRangeSource,{payloadOffset,payloadBytes,resources,signal,maxReadBytes=65536,maxPayloadBytes=1048576,maxEntryBytes=65536,maxEntries=1024,maxDecodedBytes=65536,initialEntries=[],maxStateEntries=4096,maxStateChars=1048576,chapterState=null,checkpoint}:VorbisCommentReadOptions){
 if(typeof resources?.allocate!=='function'||typeof signal?.throwIfAborted!=='function')throw new TypeError('Comment reader requires allocator and signal');signal.throwIfAborted();const size=input.size,readAt=input.readAt.bind(input);
 if(typeof size!=='bigint'||size<0n||typeof payloadOffset!=='bigint'||payloadOffset<0n||!Number.isSafeInteger(payloadBytes)||payloadBytes<0||payloadOffset+BigInt(payloadBytes)>size||![maxReadBytes,maxPayloadBytes,maxEntryBytes].every(n=>Number.isSafeInteger(n)&&n>0)||maxReadBytes>65536)throw new RangeError('Invalid comment read bounds');if(payloadBytes>maxPayloadBytes)throw new VorbisCommentLimitError('Vorbis comment payload budget exceeded');
 const collector=createVorbisCommentCollector({maxEntries,maxDecodedBytes,initialEntries,maxStateEntries,maxStateChars,chapterState}),stats={readCalls:0,bytesRead:0,maximumRead:0,ownedBufferBytes:0,peakOwnedBufferBytes:0,closed:false};let position=0,remaining=0,parseError=false;
 async function withBytes<T>(length:number,consume:(bytes:Uint8Array,location:bigint)=>T):Promise<T>{const owned=resources.allocate(length);let released=false;const release=()=>{if(!released){released=true;signal.removeEventListener('abort',release);owned.release();stats.ownedBufferBytes-=length;}};stats.ownedBufferBytes+=length;stats.peakOwnedBufferBytes=Math.max(stats.peakOwnedBufferBytes,stats.ownedBufferBytes);signal.addEventListener('abort',release,{once:true});
  try{let written=0;while(written<length){signal.throwIfAborted();await waitForFlacAbort(checkpoint?.(),signal);signal.throwIfAborted();const amount=Math.min(maxReadBytes,length-written);stats.readCalls++;stats.maximumRead=Math.max(stats.maximumRead,amount);let pending;try{pending=readAt(payloadOffset+BigInt(position+written),amount,signal);}catch(error){signal.throwIfAborted();throw error;}const bytes=await waitForFlacAbort(pending,signal);signal.throwIfAborted();if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>amount)throw new Error('Invalid or premature comment read');owned.data.set(bytes,written);written+=bytes.length;stats.bytesRead+=bytes.length;}signal.throwIfAborted();const value=consume(owned.data,payloadOffset+BigInt(position));position+=length;return value;}finally{release();}
 }
 const finish=()=>Object.freeze({...collector.snapshot({parseError,remainingBytes:payloadBytes-position,missingComments:remaining}),get metrics(){return Object.freeze({...stats,providerBufferAccounted:false});}});
 try{
  if(payloadBytes<8){parseError=true;return finish();}const vendor=await withBytes(4,bytes=>new DataView(bytes.buffer,bytes.byteOffset,4).getInt32(0,true));if(vendor<0||payloadBytes-position-4<vendor){parseError=true;return finish();}position+=vendor;remaining=await withBytes(4,bytes=>new DataView(bytes.buffer,bytes.byteOffset,4).getUint32(0,true));
  while(payloadBytes-position>=4&&remaining>0){signal.throwIfAborted();if(collector.parsedEntries>=maxEntries)throw new VorbisCommentLimitError('Vorbis comment entry budget exceeded');const length=await withBytes(4,bytes=>new DataView(bytes.buffer,bytes.byteOffset,4).getInt32(0,true));if(length<0||payloadBytes-position<length)break;if(length>maxEntryBytes)throw new VorbisCommentLimitError('Vorbis single entry budget exceeded');await withBytes(length,(bytes,location)=>collector.accept(bytes,location));remaining--;}
  return finish();
 }finally{stats.closed=true;}
}
