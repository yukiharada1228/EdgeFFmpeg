/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Descriptor adaptation of pinned FFmpeg flac_parser.c and parser.c.
 * See ../../NOTICE-FLAC-PARSER. Input discovery is supplied by the caller.
 */
import {createFlacParserTimestamps,validateFlacTimestamp} from './parser-timestamps.js';
import type {FlacParserInput} from './types.js';
export const PARSER_FLAG_COMPLETE_FRAMES=1;
export const PARSER_FLAG_USE_CODEC_TS=4096;
import {createFlacCandidateGraph,FlacWindowLimitError} from './graph.js';
import type {FlacDescriptorParser,FlacParserOptions,FlacParserResult,FlacPacketRange,FlacScoredHeader,FlacFrameHeader} from './types.js';
/** Low-level FLAC parser state. Discovery supplies bounded header/CRC descriptors;
 * no payload is retained here. AVIO scheduling and demux timestamps belong to
 * the caller. Consumed bytes clamp negative raw indices like av_parser_parse2. */
export function createFlacDescriptorParser({discover,flags=0,inspectCompleteHeader,maxHeaders=128,maxCrcQueries=4096,maxLogicalFifoBytes=0x7fffffff}:FlacParserOptions):FlacDescriptorParser{
 if(!Number.isSafeInteger(maxLogicalFifoBytes)||maxLogicalFifoBytes<1||maxLogicalFifoBytes>0x7fffffff)throw RangeError('Invalid logical FIFO budget');
 if(![0,1,4096,4097].includes(flags))throw RangeError('Unsupported FLAC parser flags');
 if((flags&1)&&typeof inspectCompleteHeader!=='function')throw TypeError('Complete frames requires trusted header inspection');
 const timestamps=createFlacParserTimestamps();let duration=0;
 if(typeof discover!=='function')throw TypeError('FLAC parser requires descriptor discovery');
 const graph=createFlacCandidateGraph({maxHeaders,maxCrcQueries});let busy=false;let rows:readonly FlacScoredHeader[]=[],selected:FlacScoredHeader|null=null,selectedValid=false,lastHeader:FlacFrameHeader|null=null;
 let capacity=106496,start=0n,end=0n,initialized=false,eofPadded=false,closed=false,failed=false,current=0n,nextFrame=0n,expected=0n,calls=0,blockedCalls=0;
 const size=()=>Number(end-start);
 async function parse(input:FlacParserInput):Promise<FlacParserResult>{
  const {offset,bytes}=input;
  if(closed||failed)throw Error('FLAC descriptor parser closed or failed');
  if(busy)throw Error('Concurrent FLAC parser calls are not allowed');
  if(typeof offset!=='bigint'||offset<0n||!Number.isSafeInteger(bytes)||bytes<0||bytes>0x7fffffff||offset+BigInt(bytes)>0x7fffffffffffffffn)throw RangeError('Invalid parser call');
  validateFlacTimestamp(input.pts);validateFlacTimestamp(input.dts);
  if(input.pos!==undefined&&(typeof input.pos!=='bigint'||input.pos< -0x8000000000000000n||input.pos>0x7fffffffffffffffn))throw RangeError('Invalid parser position');
  if((initialized?current:input.pos??offset)+BigInt(bytes)>0x7fffffffffffffffn)throw RangeError('Invalid parser position range');
  if(initialized&&offset!==expected)throw RangeError('Noncontiguous parser input');
  if(eofPadded&&bytes)throw Error('FLAC input after EOF');
  if(!initialized){initialized=true;start=end=expected=offset;current=nextFrame=input.pos??offset;}
  busy=true;calls++;let read=0;
  timestamps.begin(input,current,nextFrame);
  function finish(rawIndex:number,packet:FlacPacketRange|null=null):FlacParserResult{const consumed=Math.max(rawIndex,0);const timestampFields=timestamps.finish(!!packet&&packet.bytes>0n,nextFrame);let frameOffset:bigint|null=null;if(packet&&packet.bytes>0n){frameOffset=nextFrame;nextFrame=current+BigInt(rawIndex);}else packet=null;current+=BigInt(consumed);expected+=BigInt(consumed);return Object.freeze({consumed,rawIndex,packet,frameOffset,nextFrameOffset:nextFrame,currentOffset:current,...timestampFields,parserDuration:duration});}
  function frame(node:FlacScoredHeader):FlacParserResult{const bytes=(node.bestOffset??end)-node.offset;lastHeader=node.header;duration=node.header.blockSamples;if(flags&4096)timestamps.codec(node.header.variable?node.header.number:node.bestOffset!==null?node.header.number*BigInt(node.header.blockSamples):null);selected=node;selectedValid=false;const raw=node.bestOffset!==null&&node.bestOffset-end>-(1n<<28n)?Number(node.bestOffset-end):0;return finish(raw,Object.freeze({kind:'frame',sourceOffset:node.offset,bytes,parserDuration:node.header.blockSamples,codecPts:node.header.variable?node.header.number:node.bestOffset!==null?node.header.number*BigInt(node.header.blockSamples):null}));}
  try{
   if(flags&1){
    if(!bytes){eofPadded=true;return finish(0);}
    const header=await inspectCompleteHeader!(Object.freeze({physicalOffset:offset,bytes,maxInspectedBytes:17 as const}));
    if(closed)throw Error('FLAC descriptor parser closed during header inspection');
    if(header!==null){
     if(typeof header!=='object'||typeof header.variable!=='boolean'||typeof header.number!=='bigint'||header.number<0n||header.number>(header.variable?0xfffffffffn:0x7fffffffn)||!Number.isInteger(header.blockSamples)||header.blockSamples<1||header.blockSamples>65536)throw RangeError('Invalid trusted complete header');
     duration=header.blockSamples;
     if(flags&4096)timestamps.codec(header.variable?header.number:header.number*BigInt(header.blockSamples));
    }
    return finish(bytes,Object.freeze({kind:'frame',sourceOffset:offset,bytes:BigInt(bytes),parserDuration:duration,codecPts:header===null?null:header.number*BigInt(header.variable?1:header.blockSamples)}));
   }
   if(selectedValid&&graph.metrics.headers>=10)return frame(selected!);
   if(selected){
    if(selected.bestOffset!==null){const child=selected.bestOffset,index=rows.findIndex(r=>r.offset===child);if(index<0)throw Error('Missing FLAC child');graph.discardBefore(child);rows=rows.slice(index);start=child;selected=rows[0]!;selectedValid=false;if(graph.metrics.headers>=10)return frame(selected!);selected=null;
    }else{const selectedOffset=selected.offset,index=rows.findIndex(r=>r.offset===selectedOffset);graph.discardThrough(selectedOffset);rows=rows.slice(index+1);selected=null;}
   }
   while(bytes&&read<bytes&&graph.metrics.headers<10||!bytes&&!eofPadded){
    const padding=!bytes,amount=padding?16:Math.min(bytes-read,(11-graph.metrics.headers)*8192);
    if(padding)eofPadded=true;else read+=amount;
    if(capacity===size()&&Math.floor(size()/8192)>graph.metrics.headers*20){blockedCalls++;return finish(bytes?read:0);}
    if(size()+amount>maxLogicalFifoBytes)throw new FlacWindowLimitError('FLAC logical FIFO budget exceeded');
    if(capacity-size()<amount)capacity+=Math.max(size(),amount);
    const before=end,searchStart=before-15n>start?before-15n:start;end+=BigInt(amount);
    const candidates=await discover(Object.freeze({physicalOffset:padding?null:offset+BigInt(read-amount),bytes:amount,padding,searchStart,searchEndExclusive:end-15n,fifoStart:start,fifoEnd:end}));
    if(closed)throw Error('FLAC descriptor parser closed during discovery');
    if(!Array.isArray(candidates))throw TypeError('Invalid discovery response');
    for(const candidate of candidates){if(candidate.offset<searchStart||candidate.offset>=end-15n)throw RangeError('Candidate outside Native search range');graph.append(candidate);}
    if(!eofPadded&&graph.metrics.headers<10){if(read<bytes)continue;return finish(read);}
    if(eofPadded||candidates.length)rows=graph.rescore({lastHeader}).headers;
    if(padding){end-=16n;read=0;}
   }
   let best:FlacScoredHeader|null=selected;for(const row of rows)if(!best||row.score>best.score)best=row;
   if(best&&best.score<=0&&(!bytes||read!==0||graph.metrics.headers<10))best=null;
   if(best){selected=best;selectedValid=true;if(best.offset>start){duration=0;return finish(bytes?read:Number(best.offset-end),Object.freeze({kind:'junk',sourceOffset:start,bytes:best.offset-start,parserDuration:0,codecPts:null}));}if(!bytes)return frame(best);}
   return finish(bytes?read:0);
  }catch(error){failed=true;throw error;}finally{busy=false;}
 }
 return Object.freeze({parse,close(){graph.close();rows=[];selected=null;lastHeader=null;closed=true;},get metrics(){return Object.freeze({calls,blockedCalls,logicalFifoBytes:size(),logicalFifoCapacity:capacity,headers:graph.metrics.headers,sourcePayloadRetained:false,eofPadded,closed,failed});}});
}
