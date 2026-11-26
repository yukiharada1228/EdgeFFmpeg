// SPDX-License-Identifier: LGPL-2.1-or-later
// Placement follows FFmpeg vf_stack.c (xstack config_output, process_frame, process_slice) at the pinned upstream commit.
// Copyright (c) 2015 Paul B. Mahol. See ../NOTICE-XSTACK.
import {pixelLayout,videoStoragePixelFormat} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
export class VideoXstackError extends Error {}
export interface XstackOptions {readonly maxFrameBytes:number;readonly signal?:AbortSignal}
export interface XstackShape {readonly format:string;readonly width:number;readonly height:number}
/** One layout addend: w<i> or h<i> of another input, or a decimal pixel count. */
export interface XstackTerm {readonly kind:'w'|'h'|'n';readonly value:number}
export interface XstackPosition {readonly x:readonly XstackTerm[];readonly y:readonly XstackTerm[]}
/** grid=CxR (columns x rows) or layout=x_y|..., with one position per input. */
export type XstackLayout={readonly kind:'grid';readonly columns:number;readonly rows:number}|{readonly kind:'layout';readonly positions:readonly XstackPosition[]};
const INT_MAX=2147483647,maxInputs=32;
const term=/^([wh]?)(\d{1,10})$/;
/** The layout string as a strict subset of native av_strtok/sscanf parsing: exactly one x_y item per input, each coordinate
 * a +-joined list of w<i>, h<i> or decimal terms. Native EINVAL cases (self or out-of-range references, negative values) are
 * refused, and so are the lenient forms native would also accept (empty or extra items, whitespace, trailing text). */
export function parseXstackLayout(text:string,inputs:number):readonly XstackPosition[]{
 if(!Number.isInteger(inputs)||inputs<2||inputs>maxInputs)throw new VideoXstackError('Xstack requires two to thirty-two inputs');
 const items=text.split('|');if(items.length!==inputs)throw new VideoXstackError(`Xstack layout must give exactly ${inputs} positions`);
 return Object.freeze(items.map((item,index)=>{
  const coordinates=item.split('_');if(coordinates.length!==2)throw new VideoXstackError(`Invalid xstack layout position ${index}: expected x_y`);
  const [x,y]=coordinates.map(coordinate=>Object.freeze(coordinate.split('+').map(part=>{
   const match=term.exec(part);if(!match)throw new VideoXstackError(`Invalid xstack layout term ${JSON.stringify(part)} in position ${index}`);
   const value=Number(match[2]),kind=(match[1]||'n') as XstackTerm['kind'];
   if(value>INT_MAX)throw new VideoXstackError(`Xstack layout value out of range in position ${index}`);
   if(kind!=='n'&&(value===index||value>=inputs))throw new VideoXstackError(`Invalid xstack layout reference ${part} in position ${index}`);
   return Object.freeze({kind,value});
  }))) as [readonly XstackTerm[],readonly XstackTerm[]];
  return Object.freeze({x,y});
 }));
}
/** av_image_fill_linesizes(offset) for x and AV_CEIL_RSHIFT(offset, log2_chroma_h) for y, per plane; zero offsets are zero. */
const planeOffsets=(format:string,x:number,y:number)=>{const layout=pixelLayout(format,Math.max(x,1),Math.max(y,1));return layout.planes.map(plane=>({x:x?plane.rowBytes:0,y:y?plane.height:0}));};
/** config_output for xstack: luma offsets from the grid or layout, the bounding box as the output size, and per-plane byte
 * regions. Only exact tilings are accepted: rectangles that write outside an output plane (odd chroma sums), overlap (native
 * copies inputs on parallel slice threads) or leave any output byte unwritten (native leaves it uninitialised) are refused. */
export function xstackGeometry(inputs:readonly XstackShape[],layout:XstackLayout){
 if(inputs.length<2||inputs.length>maxInputs)throw new VideoXstackError('Xstack requires two to thirty-two inputs');
 const format=inputs[0]!.format,storage=videoStoragePixelFormat(format);
 if(inputs.some(input=>input.format!==format))throw new VideoXstackError('Xstack pixel formats differ');
 for(const input of inputs)if(!Number.isInteger(input.width)||!Number.isInteger(input.height)||input.width<1||input.height<1||input.width>INT_MAX||input.height>INT_MAX)throw new VideoXstackError('Invalid xstack input size');
 const offsets:{x:number;y:number}[]=[];let width=0,height=0;
 if(layout.kind==='grid'){
  const {columns,rows}=layout;if(!Number.isInteger(columns)||!Number.isInteger(rows)||columns<1||rows<1||columns*rows!==inputs.length)throw new VideoXstackError('Xstack grid does not match the input count');
  let inh=0;
  for(let row=0;row<rows;row++){
   const rowHeight=inputs[row*columns]!.height;let inw=0;
   for(let column=0;column<columns;column++){
    const k=row*columns+column,input=inputs[k]!;
    if(input.height!==rowHeight)throw new VideoXstackError(`Input ${k} height ${input.height} does not match current row's height ${rowHeight}`);
    offsets.push({x:inw,y:inh});if(inw>INT_MAX-input.width)throw new VideoXstackError('Xstack output width overflows');inw+=input.width;
   }
   if(inh>INT_MAX-rowHeight)throw new VideoXstackError('Xstack output height overflows');inh+=rowHeight;
   if(!row)width=inw;else if(width!==inw)throw new VideoXstackError(`Row ${row} width ${inw} does not match previous row width ${width}`);
  }
  height=inh;
 }else{
  const {positions}=layout;if(positions.length!==inputs.length)throw new VideoXstackError('Xstack layout does not match the input count');
  for(const [i,position]of positions.entries()){
   // Native adds the referenced input's width for w<i> in both coordinates, and its height for h<i>.
   const sum=(terms:readonly XstackTerm[])=>{let total=0;for(const item of terms){
    if(item.kind!=='n'&&(item.value===i||item.value>=inputs.length))throw new VideoXstackError(`Invalid xstack layout reference in position ${i}`);
    const value=item.kind==='w'?inputs[item.value]!.width:item.kind==='h'?inputs[item.value]!.height:item.value;
    if(!Number.isInteger(value)||value<0||total>INT_MAX-value)throw new VideoXstackError(`Xstack layout position ${i} overflows`);total+=value;}return total;};
   const x=sum(position.x),y=sum(position.y),input=inputs[i]!;
   if(input.width>INT_MAX-x||input.height>INT_MAX-y)throw new VideoXstackError(`Xstack layout position ${i} overflows`);
   offsets.push({x,y});width=Math.max(width,input.width+x);height=Math.max(height,input.height+y);
  }
 }
 const output=pixelLayout(storage,width,height);
 const regions=inputs.map((input,i)=>{
  const shape=pixelLayout(storage,input.width,input.height),start=planeOffsets(storage,offsets[i]!.x,offsets[i]!.y);
  return Object.freeze(shape.planes.map((plane,p)=>{
   const region=Object.freeze({x:start[p]!.x,y:start[p]!.y,width:plane.rowBytes,height:plane.height}),target=output.planes[p]!;
   if(region.x+region.width>target.rowBytes||region.y+region.height>target.height)throw new VideoXstackError(`Xstack input ${i} plane ${p} placement exceeds the output plane; native writes outside it`);
   return region;
  }));
 });
 // process_slice copies inputs on parallel slice jobs, so native output is racy wherever two inputs overlap (measured), and an
 // unwritten byte keeps the uninitialised pool buffer: only exact tilings are deterministic.
 for(const [p,plane]of output.planes.entries()){
  let area=0;
  for(let i=0;i<regions.length;i++){
   const a=regions[i]![p]!;area+=a.width*a.height;
   for(let j=0;j<i;j++){const b=regions[j]![p]!;if(Math.max(a.x,b.x)<Math.min(a.x+a.width,b.x+b.width)&&Math.max(a.y,b.y)<Math.min(a.y+a.height,b.y+b.height))throw new VideoXstackError(`Xstack inputs ${j} and ${i} overlap in plane ${p}; native copies them on parallel slice threads`);}
  }
  if(area!==plane.bytes)throw new VideoXstackError(`Xstack layout leaves plane ${p} bytes uncovered; native leaves them uninitialised`);
 }
 return Object.freeze({format,width,height,layout:output,regions:Object.freeze(regions)});
}
/** process_frame: a new output buffer (no props or metadata copied) with each input's planes copied into its own region. */
export function xstackVideoFrames(frames:readonly VideoFrameData[],layout:XstackLayout,options:XstackOptions):VideoFrameData{
 options.signal?.throwIfAborted();const plan=xstackGeometry(frames.map(frame=>({format:frame.pixelFormat,width:frame.width,height:frame.height})),layout),first=frames[0]!;
 if(!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<plan.layout.bytes)throw new VideoXstackError('Xstack output exceeds frame budget');
 for(const frame of frames){
  let storage=0n;const pts=frame.pts;
  if(pts&&(typeof pts.value!=='bigint'||typeof pts.timeBase.num!=='bigint'||typeof pts.timeBase.den!=='bigint'||pts.timeBase.num<=0n||pts.timeBase.den<=0n))throw new VideoXstackError('Invalid xstack timestamp');
  if(pts===null?first.pts!==null:first.pts===null||pts.value*pts.timeBase.num*first.pts.timeBase.den!==first.pts.value*first.pts.timeBase.num*pts.timeBase.den)throw new VideoXstackError('Xstack frames must have synchronized timestamps');
  const shape=pixelLayout(videoStoragePixelFormat(frame.pixelFormat),frame.width,frame.height);
  if(shape.bytes>options.maxFrameBytes||frame.planes.length!==shape.planes.length||frame.linesizes.length!==shape.planes.length)throw new VideoXstackError('Invalid xstack input layout');
  for(const [p,plane]of shape.planes.entries()){const bytes=frame.planes[p],stride=frame.linesizes[p];if(!(bytes instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>INT_MAX||BigInt(bytes.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoXstackError('Invalid xstack input storage');storage+=BigInt(bytes.length);}
  if(storage>BigInt(options.maxFrameBytes))throw new VideoXstackError('Xstack input storage exceeds frame budget');
 }
 const data=new Uint8Array(plan.layout.bytes);
 for(const [index,frame]of frames.entries())for(const [p,region]of plan.regions[index]!.entries()){
  const plane=plan.layout.planes[p]!,source=frame.planes[p]!,stride=frame.linesizes[p]!;
  for(let row=0;row<region.height;row++){options.signal?.throwIfAborted();const start=row*stride;data.set(source.subarray(start,start+region.width),plane.offset+(region.y+row)*plane.rowBytes+region.x);}
 }
 // vf_stack rescales the sync event without PASS_MINMAX, clamping MIN to MIN+1.
 return {width:plan.width,height:plan.height,pixelFormat:plan.format,planes:plan.layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:plan.layout.planes.map(plane=>plane.rowBytes),pts:first.pts===null?null:{value:first.pts.value===-(1n<<63n)?-(1n<<63n)+1n:first.pts.value,timeBase:{...first.pts.timeBase}},metadata:{}};
}
