/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Bounded port of FFmpeg parser.c, Copyright (c) 2003 Fabrice Bellard and
 * Michael Niedermayer. See ../../NOTICE-FLAC-PARSER and upstream COPYING.LGPLv2.1.
 */
import type {FlacParserInput} from './types.js';
export function validateFlacTimestamp(value:bigint|null|undefined):void {
 if(value!==undefined&&value!==null&&(typeof value!=='bigint'||value<=-0x8000000000000000n||value>0x7fffffffffffffffn))throw RangeError('Invalid parser timestamp');
}
export function createFlacParserTimestamps(){
 const slots=Array.from({length:4},()=>({start:0n,end:0n,pts:0n as bigint|null,dts:0n as bigint|null,pos:0n}));
 let index=0,fetch=true,frame=0n,pts:bigint|null=0n,dts:bigint|null=0n,pos=0n,offset=0n;
 return {
  begin(input:FlacParserInput,current:bigint,next:bigint){
   if(input.bytes&&current+BigInt(input.bytes)!==slots[index]!.end){index=(index+1)&3;slots[index]={start:current,end:current+BigInt(input.bytes),pts:input.pts??null,dts:input.dts??null,pos:input.pos??-1n};}
   if(fetch){fetch=false;pts=dts=null;pos=-1n;offset=0n;
    for(const slot of slots)if(current>=slot.start&&(frame<slot.start||(!frame&&!next))&&slot.end!==0n){pts=slot.pts;dts=slot.dts;pos=slot.pos;offset=next-slot.start;if(current<slot.end)break;}
   }
  },
  codec(value:bigint|null){if(value!==null)pts=value;},
  finish(packet:boolean,next:bigint){if(packet){frame=next;fetch=true;}return {parserPts:pts,parserDts:dts,parserPos:pos,timestampOffset:offset};}
 };
}
