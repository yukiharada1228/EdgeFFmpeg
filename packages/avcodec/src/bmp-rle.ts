/* BMP RLE behavior adapted from FFmpeg libavcodec/msrledec.c.
 * Copyright (C) 2008 Konstantin Shishkov
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */
/** Native retains partial frames on RLE errors. Padding affects parser state;
 * simulate that capacity without allocating or exposing padding storage.
 */
export function decodeBmpRle(data:Uint8Array,offset:number,pixels:Uint8Array,width:number,height:number,depth:4|8,topDown:boolean,lineAlignment:number,signal?:AbortSignal):void {
  let cursor=offset,x=0,line=0;
  const capacity=Math.ceil(width/lineAlignment)*lineAlignment;
  const read=()=>cursor<data.length?data[cursor++]!:0;
  const put=(value:number)=>{if(line>=0&&line<height&&x>=0&&x<width)pixels[(topDown?line:height-1-line)*width+x]=value;x++;};
  while(cursor<data.length&&line<height&&(depth===8||x<=width)){
    signal?.throwIfAborted();
    const count=read();
    if(count){
      if(depth===8&&x+count>capacity)continue; // Native does not consume the value.
      if(depth===4&&x+count>width+1)return;
      const value=read();
      for(let i=0;i<count&&(depth===8||x<width);i++)put(depth===8?value:(value>>(i%2?0:4))&15);
      continue;
    }
    const value=read();
    if(value===0){line++;x=0;}
    else if(value===1)return;
    else if(value===2){x+=read();line+=read();if(line>=height||depth===8&&x>=capacity)return;}
    else{
      const packed=depth===8?value:Math.ceil(value/2);
      if(depth===8&&x+value>capacity){cursor=Math.min(data.length,cursor+2);continue;}
      if(cursor+packed>data.length||depth===4&&x+value>width)return;
      for(let i=0;i<value;i++)put(depth===8?data[cursor+i]!:(data[cursor+Math.floor(i/2)]!>>(i%2?0:4))&15);
      cursor+=packed+(packed&1);
    }
  }
}
