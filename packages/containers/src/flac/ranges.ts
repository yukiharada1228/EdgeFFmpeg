/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Bounded FLAC packet-range scheduling.
 * See ../../NOTICE-FLAC-PARSER and ../../COPYING.LGPLv2.1. Native AVIO partial-read scheduling remains open.
 */
import{createFlacDescriptorParser}from'@edge-ffmpeg/avcodec';
import type{FlacDescriptorParser,FlacParserResult}from'@edge-ffmpeg/avcodec';
import{waitForFlacAbort}from'./abort-wait.js';
import{createFlacIntakeDiscovery}from'./discovery.js';
import type{FlacRangeSource,FlacRangeStreamOptions,FlacRangeStream,FlacIntakeRange}from'./types.js';
/** Read raw FLAC frame ranges beginning at startOffset, with an explicit parser
 * input schedule. This API does not parse file metadata or fill demux timestamps.
 * Discovery owns34bytes; provider buffers and object overhead need separate
 * runtime accounting. The consumer must close or return the iterator. */
export function openFlacPacketRanges(input:FlacRangeSource,{startOffset=0n,parserChunkBytes=1024,maxParserCalls=1000000,maxHeaders=128,maxCrcQueries=4096,maxLogicalFifoBytes=0x7fffffff,maxReadBytes=65536,maxScanBytes,maxCandidates=1024,signal,resources,checkpoint}:FlacRangeStreamOptions):FlacRangeStream{
 if(!signal||typeof signal.throwIfAborted!=='function'||typeof resources?.allocate!=='function')throw TypeError('Intake stream requires signal and resources');signal.throwIfAborted();
 if(typeof input?.size!=='bigint'||input.size>0x7fffffffffffffffn||typeof input.readAt!=='function'||typeof startOffset!=='bigint'||startOffset<0n||startOffset>input.size||!Number.isSafeInteger(parserChunkBytes)||parserChunkBytes<1||parserChunkBytes>0x7fffffff||!Number.isSafeInteger(maxParserCalls)||maxParserCalls<1)throw RangeError('Invalid intake stream bounds');
 const parentSignal=signal,controller=new AbortController(),forward=()=>close(parentSignal.reason);signal=controller.signal;
 let started=false,closed=false,parser:FlacDescriptorParser|undefined,discovery:ReturnType<typeof createFlacIntakeDiscovery>|undefined,calls=0,packets=0;
 function close(reason:unknown=new Error('FLAC intake stream closed')){closed=true;parentSignal.removeEventListener('abort',forward);controller.abort(reason);discovery?.close();parser?.close();}
 parentSignal.addEventListener('abort',forward,{once:true});if(parentSignal.aborted)forward();
 async function* iterate():AsyncGenerator<FlacIntakeRange,void,unknown>{try{
  signal.throwIfAborted();discovery=createFlacIntakeDiscovery(input,{startOffset,signal,resources,maxReadBytes,maxScanBytes,maxCandidates});parser=createFlacDescriptorParser({discover:discovery.discover,maxHeaders,maxCrcQueries,maxLogicalFifoBytes});let position=startOffset;
  async function call(bytes:number):Promise<FlacParserResult>{signal.throwIfAborted();if(calls>=maxParserCalls)throw RangeError('FLAC parser call budget exceeded');await waitForFlacAbort(checkpoint?.(),signal);signal.throwIfAborted();calls++;return parser!.parse({offset:position,bytes});}
  while(position<input.size){const available=input.size-position,chunkEnd=position+(available<BigInt(parserChunkBytes)?available:BigInt(parserChunkBytes));while(position<chunkEnd){const result=await call(Number(chunkEnd-position));signal.throwIfAborted();position+=BigInt(result.consumed);if(!result.consumed&&!result.packet)throw Error('FLAC parser stalled');if(result.packet){packets++;yield Object.freeze({...result.packet,parserFrameOffset:result.frameOffset!,parserRawIndex:result.rawIndex});}}}
  for(;;){const result=await call(0);signal.throwIfAborted();if(!result.packet)break;packets++;yield Object.freeze({...result.packet,parserFrameOffset:result.frameOffset!,parserRawIndex:result.rawIndex});}
 }finally{close();}}
 return Object.freeze({[Symbol.asyncIterator](){if(started)throw Error('FLAC intake stream is one-shot');started=true;return iterate();},close,get metrics(){return Object.freeze({calls,packets,closed,parser:parser?.metrics??null,discovery:discovery?.metrics??null,avioPartialSchedulingImplemented:false});}});
}
