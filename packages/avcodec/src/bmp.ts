/* BMP behavior adapted from FFmpeg libavcodec/bmp.c and bmpenc.c.
 * Copyright (c) 2005 Mans Rullgard
 * Copyright (c) 2006, 2007 Michel Bardiaux
 * Copyright (c) 2009 Daniel Verkamp
 * Systematic palettes adapted from FFmpeg libavutil/imgutils.c (see provenance).
 * SPDX-License-Identifier: LGPL-2.1-or-later
 * See packages/avcodec/NOTICE-BMP and COPYING.LGPLv2.1.
 */
import type {MediaPacket,VideoFrameData} from '@edge-ffmpeg/avutil';
import {decodeBmpRle} from './bmp-rle.js';
export class BmpError extends Error {}
export interface BmpOptions {readonly maxFrameBytes:number;readonly maxPacketBytes:number;readonly rleLineAlignment?:8|16|32|64;readonly signal?:AbortSignal}
/** Finite BMP packet decoder. The output owns tight, top-to-bottom pixel storage. */
export function decodeBmp(packet:MediaPacket,options:BmpOptions):VideoFrameData {
  options.signal?.throwIfAborted();
  for(const value of [options.maxFrameBytes,options.maxPacketBytes])if(!Number.isSafeInteger(value)||value<1||value>2147483647)throw new BmpError('Invalid BMP resource budget');
  const lineAlignment=options.rleLineAlignment??16;
  if(![8,16,32,64].includes(lineAlignment))throw new BmpError('Invalid BMP RLE alignment profile');
  const data=packet.data;
  if(!(data instanceof Uint8Array)||data.length>options.maxPacketBytes||data.length<18)throw new BmpError('Invalid BMP packet size');
  if(packet.timeBase.num<=0n||packet.timeBase.den<=0n)throw new BmpError('Invalid BMP time base');
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  if(view.getUint16(0,true)!==0x4d42)throw new BmpError('Invalid BMP magic');
  const declared=view.getUint32(2,true),offset=view.getUint32(10,true),header=view.getUint32(14,true);
  if(![12,40,56,64,108,124].includes(header)||14+header>offset||offset>data.length||14+header>data.length)throw new BmpError('Unsupported or truncated BMP header');
  let fileSize=Math.min(declared,data.length);
  if(fileSize===14||fileSize===14+header)fileSize=data.length-2;
  if(fileSize<=offset)throw new BmpError('BMP declared size does not include pixels');
  const core=header===12,width=core?view.getUint16(18,true):view.getInt32(18,true),signedHeight=core?view.getUint16(20,true):view.getInt32(22,true);
  const height=Math.abs(signedHeight),planes=view.getUint16(core?22:26,true),depth=view.getUint16(core?24:28,true),compression=core?0:view.getUint32(30,true);
  if(width<=0||height===0||height>2147483647||planes!==1)throw new BmpError('Invalid BMP dimensions or planes');
  if(![0,1,2,3].includes(compression)||![1,4,8,16,24,32].includes(depth))throw new BmpError('Unsupported BMP compression or depth');
  const rle=compression===1||compression===2;
  if(rle&&depth!==4&&depth!==8)throw new BmpError('Unsupported BMP RLE depth');
  let pixelFormat=depth===24?'bgr24':depth===32?'bgra':depth===16?'rgb555le':'gray';
  const estimated=width*height*(depth<=8?1:depth/8)+(depth<=8&&offset>14+header?1024:0);
  if(!Number.isSafeInteger(estimated)||estimated>options.maxFrameBytes)throw new BmpError('BMP frame exceeds allocation budget');
  let palette:Uint8Array|undefined;
  if(compression===3){
    if(![16,32].includes(depth)||offset<66||data.length<66)throw new BmpError('Invalid BMP bitfields');
    const masks=[view.getUint32(54,true),view.getUint32(58,true),view.getUint32(62,true)];
    const alpha=header>40?(data.length>=70?view.getUint32(66,true):0):0;
    const key=masks.join(',');
    if(depth===16){
      const formats:Record<string,string>={'63488,2016,31':'rgb565le','31744,992,31':'rgb555le','3840,240,15':'rgb444le'};
      pixelFormat=formats[key]??'';
    }else{
      const formats:Record<string,string[]>={'4278190080,16711680,65280':['0bgr','abgr'],'16711680,65280,255':['bgr0','bgra'],'65280,16711680,4278190080':['0rgb','argb'],'255,65280,16711680':['rgb0','rgba']};
      pixelFormat=formats[key]?.[alpha?1:0]??'';
    }
    if(!pixelFormat)throw new BmpError('Unsupported BMP bitfield masks');
  }
  if(depth<=8&&offset>14+header){
    pixelFormat='pal8';
    let colors=1<<depth;
    if(header>=36){const count=view.getUint32(46,true);if(count>0&&count<=colors)colors=count;}
    else colors=Math.min(256,Math.floor((offset-header-14)/3));
    const entryBytes=offset-header-14<colors*4?3:4;
    if(offset-header-14<colors*entryBytes)throw new BmpError('Truncated BMP palette');
    palette=new Uint8Array(1024);
    for(let i=0;i<colors;i++){const start=14+header+i*entryBytes;palette.set(data.subarray(start,start+3),i*4);palette[i*4+3]=255;}
  }else if(depth<8)throw new BmpError('Missing BMP palette');
  const packedRow=Math.ceil(width*depth/8),rowBytes=width*(depth<=8?1:depth/8),bytes=rowBytes*height;
  if(!Number.isSafeInteger(bytes)||bytes+(palette?.length??0)>options.maxFrameBytes)throw new BmpError('BMP frame exceeds allocation budget');
  let stride=Math.ceil(packedRow/4)*4;
  if(stride*height>data.length-offset)stride=packedRow;
  if(!rle&&stride*height>data.length-offset)throw new BmpError('Truncated BMP pixel rows');
  const pixels=new Uint8Array(bytes);
  if(rle)decodeBmpRle(data,offset,pixels,width,height,depth as 4|8,signedHeight<0,lineAlignment,options.signal);
  else for(let row=0;row<height;row++){
    options.signal?.throwIfAborted();
    const source=offset+(signedHeight>0?height-1-row:row)*stride;
    if(depth>=8)pixels.set(data.subarray(source,source+rowBytes),row*rowBytes);
    else for(let x=0;x<width;x++)pixels[row*rowBytes+x]=(data[source+Math.floor(x*depth/8)]!>>(8-depth-(x*depth)%8))&((1<<depth)-1);
  }
  if(pixelFormat==='bgra'){let alpha=false;for(let i=3;i<pixels.length;i+=4)if(pixels[i]){alpha=true;break;}if(!alpha)pixelFormat='bgr0';}
  return {width,height,pixelFormat,planes:palette?[pixels,palette]:[pixels],linesizes:palette?[rowBytes,1024]:[rowBytes],pts:packet.pts===null?null:{value:packet.pts,timeBase:{...packet.timeBase}},metadata:{}};
}
/** Encode a finite frame into an owned BMP packet, including canonical zero row padding. */
export function encodeBmp(frame:VideoFrameData,options:BmpOptions):MediaPacket {
  options.signal?.throwIfAborted();
  for(const value of [options.maxFrameBytes,options.maxPacketBytes])if(!Number.isSafeInteger(value)||value<1||value>2147483647)throw new BmpError('Invalid BMP resource budget');
  const formats:Record<string,number>={bgr24:24,bgra:32,rgb555le:16,rgb565le:16,rgb444le:16,gray:8,pal8:8,monob:1,rgb8:8,bgr8:8,rgb4_byte:8,bgr4_byte:8};
  const depth=Object.hasOwn(formats,frame.pixelFormat)?formats[frame.pixelFormat]!:0;
  if(!depth||!Number.isSafeInteger(frame.width)||!Number.isSafeInteger(frame.height)||frame.width<1||frame.height<1||frame.width>2147483647||frame.height>2147483647)throw new BmpError('Unsupported BMP encoder format or dimensions');
  const masks=frame.pixelFormat==='rgb565le'?[63488,2016,31]:frame.pixelFormat==='rgb444le'?[3840,240,15]:undefined;
  const count=masks?3:depth===8?256:depth===1?2:0,offset=54+count*4,rowBytes=Math.ceil(frame.width*depth/8),stride=Math.ceil(rowBytes/4)*4,size=offset+stride*frame.height;
  if(!Number.isSafeInteger(size)||size>options.maxPacketBytes)throw new BmpError('BMP packet exceeds allocation budget');
  if(frame.planes.length!==(frame.pixelFormat==='pal8'?2:1)||frame.linesizes.length!==frame.planes.length)throw new BmpError('Invalid BMP input plane count');
  let resident=0;
  for(const plane of frame.planes){if(!(plane instanceof Uint8Array))throw new BmpError('Invalid BMP input plane');resident+=plane.length;}
  if(resident>options.maxFrameBytes)throw new BmpError('BMP frame exceeds allocation budget');
  const input=frame.planes[0]!,inputStride=frame.linesizes[0]!;
  if(!Number.isSafeInteger(inputStride)||inputStride<rowBytes||input.length<inputStride*(frame.height-1)+rowBytes)throw new BmpError('Invalid BMP input stride or storage');
  if(frame.pixelFormat==='pal8'&&frame.planes[1]!.length<1024)throw new BmpError('Truncated BMP input palette');
  if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new BmpError('Invalid BMP timestamp');
  const data=new Uint8Array(size),view=new DataView(data.buffer);
  view.setUint16(0,0x4d42,true);view.setUint32(2,size,true);view.setUint32(10,offset,true);view.setUint32(14,40,true);view.setInt32(18,frame.width,true);view.setInt32(22,frame.height,true);view.setUint16(26,1,true);view.setUint16(28,depth,true);view.setUint32(30,masks?3:0,true);view.setUint32(34,stride*frame.height,true);
  for(let i=0;i<count;i++){
    if(masks)view.setUint32(54+i*4,masks[i]!,true);
    else if(frame.pixelFormat==='pal8')data.set(frame.planes[1]!.subarray(i*4,i*4+3),54+i*4);
    else {
      let r=depth===1?i*255:i,g=r,b=r;
      if(frame.pixelFormat==='rgb8'){r=(i>>5)*36;g=((i>>2)&7)*36;b=(i&3)*85;}
      else if(frame.pixelFormat==='bgr8'){b=(i>>6)*85;g=((i>>3)&7)*36;r=(i&7)*36;}
      else if(frame.pixelFormat==='rgb4_byte'){r=(i>>3)*255;g=((i>>1)&3)*85;b=(i&1)*255;}
      else if(frame.pixelFormat==='bgr4_byte'){b=(i>>3)*255;g=((i>>1)&3)*85;r=(i&1)*255;}
      view.setUint32(54+i*4,(b+(g<<8)+(r<<16))&0xffffff,true);
    }
  }
  for(let row=0;row<frame.height;row++){options.signal?.throwIfAborted();data.set(input.subarray(row*inputStride,row*inputStride+rowBytes),offset+(frame.height-1-row)*stride);}
  const timeBase=frame.pts?{...frame.pts.timeBase}:{num:1n,den:25n},pts=frame.pts?.value??null;
  return {streamIndex:0,data,pts,dts:pts,duration:1n,timeBase,flags:1};
}
