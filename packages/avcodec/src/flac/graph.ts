// SPDX-License-Identifier: LGPL-2.1-or-later; see ../../NOTICE-FLAC-PARSER.
import {crc16Between} from './crc.js';
import {isEncodableFlacHeader} from './header-validation.js';
import type {FlacFrameHeader,FlacHeaderCandidate} from './types.js';
const UNKNOWN=100000;
export class FlacWindowLimitError extends Error{}
interface GraphOptions {readonly maxHeaders?:number;readonly maxCrcQueries?:number}
interface ScoreOptions extends GraphOptions {readonly lastHeader?:FlacFrameHeader|null}
interface FlacNode extends FlacHeaderCandidate {penalties:number[];score:number;best:FlacNode|null}
function mismatch(a:FlacFrameHeader,b:FlacFrameHeader):number{return (a.sampleRate!==b.sampleRate?7:0)+(a.bitsPerSample!==b.bitsPerSample?7:0)+(a.variable!==b.variable?10:0)+(a.channels!==b.channels?7:0);}
function scoreNodes(nodes:FlacNode[],crc:(start:bigint,end:bigint)=>number,lastHeader:FlacFrameHeader|null=null){
 const last=lastHeader??{variable:false,number:0n,blockSamples:0};
 function penalty(index:number,childIndex:number,dist:number):number{const a=nodes[index]!,b=nodes[childIndex]!;let deduction=mismatch(a.header,b.header),expected=0;
  if(b.header.number-a.header.number!==BigInt(a.header.blockSamples)&&b.header.number!==a.header.number+1n){let expectedFrame=a.header.number,expectedSample=a.header.number;for(let at=index;at<childIndex;at++)if(nodes[at]!.penalties.some(value=>value<50)){expectedFrame++;expectedSample+=BigInt(nodes[at]!.header.blockSamples);}if(expectedFrame===b.header.number||expectedSample===b.header.number)expected=deduction?0:1;deduction+=7;}
  let checkCrc;if(last.variable===a.header.variable&&(last.variable?last.number+BigInt(last.blockSamples)===a.header.number:last.number+1n===a.header.number))checkCrc=false;else checkCrc=!deduction&&!expected;
  if(checkCrc||deduction&&!expected){let value=1,inverted=false;
   if(a.penalties[dist]! <50||a.penalties[dist]! ===UNKNOWN){let start=index,end=childIndex;if(dist>0&&a.penalties[dist-1]! >=50){start=childIndex-1;inverted=true;}else if(dist>0&&nodes[index+1]!.penalties[dist-1]! >=50){end=index+1;inverted=true;}value=crc(nodes[start]!.offset,nodes[end]!.offset);}
   if(!!value!==inverted)deduction+=50;
  }return deduction;
 }
 // Children are acyclic. Reverse order avoids recursion over untrusted headers.
 for(let at=nodes.length-1;at>=0;at--){const node=nodes[at]!,baseScore=10-(lastHeader?mismatch(lastHeader,node.header):0);node.score=baseScore;for(let dist=0;dist<4&&at+dist+1<nodes.length;dist++){const child=at+dist+1,p=node.penalties[dist]! ===UNKNOWN?penalty(at,child,dist):node.penalties[dist]!;node.penalties[dist]=p;const childScore=nodes[child]!.score-p;if(10+childScore>node.score){node.best=nodes[child]!;node.score=baseScore+childScore;}}}
 return nodes;
}
export function scoreFlacCandidateSequence(candidates:readonly FlacHeaderCandidate[],{maxHeaders=128,maxCrcQueries=4096,lastHeader=null}:ScoreOptions={}){
 if(!Number.isSafeInteger(maxHeaders)||maxHeaders<1||maxHeaders>1024||!Number.isSafeInteger(maxCrcQueries)||maxCrcQueries<1)throw new RangeError('Invalid candidate graph limits');
 if(lastHeader!==null&&!isEncodableFlacHeader(lastHeader))throw new TypeError('Invalid previous header');
 const nodes:FlacNode[]=[];let previous=-1n;for(const candidate of candidates){if(nodes.length>=maxHeaders)throw new FlacWindowLimitError('FLAC candidate graph budget exceeded');const {offset,header,prefixCrc16}=candidate;
  if(typeof offset!=='bigint'||offset<0n||offset<=previous||!isEncodableFlacHeader(header)||!Number.isSafeInteger(prefixCrc16)||prefixCrc16<0||prefixCrc16>65535)throw new TypeError('Invalid candidate graph descriptor');
  nodes.push({offset,header,prefixCrc16,penalties:[UNKNOWN,UNKNOWN,UNKNOWN,UNKNOWN],score:10,best:null});previous=offset;
 }
 const prefixes=new Map(nodes.map(node=>[node.offset,node.prefixCrc16]));let crcQueries=0;
 scoreNodes(nodes,(start,end)=>{if(crcQueries>=maxCrcQueries)throw new FlacWindowLimitError('FLAC CRC query budget exceeded');crcQueries++;return crc16Between(prefixes.get(start)!,prefixes.get(end)!,end-start);},lastHeader);
 return Object.freeze({headers:Object.freeze(nodes.map(node=>Object.freeze({offset:node.offset,header:node.header,score:node.score,bestOffset:node.best?.offset??null,penalties:Object.freeze(node.penalties.slice())}))),crcQueries,sourcePayloadRetained:false,streamingHistoryImplemented:false});
}

/** Bounded persistent link graph. Intake batches/packet publication remain the
 * responsibility of a future parser; offsets are absolute and never rebased. */
export function createFlacCandidateGraph({maxHeaders=128,maxCrcQueries=4096}:GraphOptions={}){
 // Reuse descriptor API's bounds validation without allocating payload storage.
 scoreFlacCandidateSequence([],{maxHeaders,maxCrcQueries});
 let nodes:FlacNode[]=[],lastOffset=-1n,closed=false,failed=false,totalQueries=0;
 const active=()=>{if(closed||failed)throw new Error('FLAC graph is closed or failed');};
 return {
  append(candidate:FlacHeaderCandidate){active();if(nodes.length>=maxHeaders)throw new FlacWindowLimitError('FLAC persistent header budget exceeded');
   scoreFlacCandidateSequence([candidate],{maxHeaders,maxCrcQueries});if(candidate.offset<=lastOffset)throw new TypeError('Nonmonotonic FLAC graph input');
   const header=Object.freeze({...candidate.header});nodes.push({offset:candidate.offset,header,prefixCrc16:candidate.prefixCrc16,penalties:[UNKNOWN,UNKNOWN,UNKNOWN,UNKNOWN],score:10,best:null});lastOffset=candidate.offset;
  },
  rescore({lastHeader=null}:{readonly lastHeader?:FlacFrameHeader|null}={}){active();scoreFlacCandidateSequence([],{maxHeaders,maxCrcQueries,lastHeader});let crcQueries=0;
   const prefixes=new Map(nodes.map(node=>[node.offset,node.prefixCrc16]));
   try{scoreNodes(nodes,(start,end)=>{if(crcQueries>=maxCrcQueries)throw new FlacWindowLimitError('FLAC persistent CRC query budget exceeded');crcQueries++;totalQueries++;return crc16Between(prefixes.get(start)!,prefixes.get(end)!,end-start);},lastHeader);}
   catch(error){failed=true;throw error;}
   return Object.freeze({headers:Object.freeze(nodes.map(node=>Object.freeze({offset:node.offset,header:node.header,score:node.score,bestOffset:node.best?.offset??null,penalties:Object.freeze(node.penalties.slice())}))),crcQueries,sourcePayloadRetained:false,linkPenaltyCacheRetained:true,parserIntakeImplemented:false});
  },
  discardBefore(offset:bigint){active();const index=nodes.findIndex(node=>node.offset===offset);if(index<0)throw new RangeError('FLAC drain requires a retained header');nodes=nodes.slice(index);},
  discardThrough(offset:bigint){active();const index=nodes.findIndex(node=>node.offset===offset);if(index<0)throw new RangeError('FLAC drain requires a retained header');nodes=nodes.slice(index+1);},
  close(){nodes=[];closed=true;},
  get metrics(){return Object.freeze({headers:nodes.length,totalQueries,closed,failed});}
 };
}
