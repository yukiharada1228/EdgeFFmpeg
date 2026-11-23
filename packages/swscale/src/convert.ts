import {videoStoragePixelFormat} from '@edge-ffmpeg/avutil';
import {frameInverseCoefficients,defaultInverseCoefficients,convertedColorMetadata,sourceRangeMetadata} from './inverse-coefficients.js';
import {inversePlan,renderInverse} from './inverse.js';
import type {PixelArithmetic} from './inverse.js';
export {UnstablePixelReferenceError} from './inverse.js';
export type {PixelArithmetic} from './inverse.js';
import {chromaAxis,chromaRow,chromaStateBytes} from './chroma-filter.js';
import {rgbToYuv,rgbChromaQ6,rgbToYuvTruncated,rgbToGray,grayToLimited,limitedToGray,yuvToRgb} from './color.js';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData,VideoPixelFormat} from '@edge-ffmpeg/avutil';
export class PixelConversionError extends Error {}
export interface PixelConversionOptions {readonly maxFrameBytes:number;readonly maxStateBytes?:number;readonly arithmetic?:PixelArithmetic;readonly signal?:AbortSignal}
type ComponentName='R'|'G'|'B'|'Y'|'U'|'V'|'A';
interface Component {readonly name:ComponentName;readonly plane:number;readonly step:number;readonly offset:number}
interface Packing {readonly family:string;readonly components:readonly Component[]}
const packed=(family:string,names:readonly ComponentName[]):Packing=>({family,components:names.map((name,offset)=>({name,plane:0,step:names.length,offset}))});
const planar=(family:string,names:readonly ComponentName[]):Packing=>({family,components:names.map((name,plane)=>({name,plane,step:1,offset:0}))});
const packing={
 gray:planar('gray',['Y']),rgb24:packed('rgb',['R','G','B']),bgr24:packed('rgb',['B','G','R']),
 rgba:packed('rgb',['R','G','B','A']),bgra:packed('rgb',['B','G','R','A']),argb:packed('rgb',['A','R','G','B']),abgr:packed('rgb',['A','B','G','R']),gbrp:planar('rgb',['G','B','R']),
 yuv420p:planar('yuv420',['Y','U','V']),yuva420p:planar('yuv420',['Y','U','V','A']),
 nv12:{family:'yuv420',components:[{name:'Y',plane:0,step:1,offset:0},{name:'U',plane:1,step:2,offset:0},{name:'V',plane:1,step:2,offset:1}]},
 nv21:{family:'yuv420',components:[{name:'Y',plane:0,step:1,offset:0},{name:'U',plane:1,step:2,offset:1},{name:'V',plane:1,step:2,offset:0}]},
 yuv422p:planar('yuv422',['Y','U','V']),yuv444p:planar('yuv444',['Y','U','V'])
} satisfies Partial<Record<VideoPixelFormat,Packing>>;
function descriptor(format:string):Packing|undefined{format=videoStoragePixelFormat(format);return Object.hasOwn(packing,format==='gray8'?'gray':format)?packing[(format==='gray8'?'gray':format) as keyof typeof packing]:undefined;}
/** Format-level support; geometry, numeric profile and resource limits are validated separately. */
export function canConvertPixelFormat(input:string,output:string):boolean{const source=descriptor(input),destination=descriptor(output);if(videoStoragePixelFormat(output)!==output)return false;if(source===undefined||destination===undefined)return false;
 return true;}
/** Conservative typed filter/index/row payload bound; no allocation or pixel reads. */
export function pixelConversionStateBytes(input:string,output:string,width:number,height:number,arithmetic:PixelArithmetic='aarch64'):number{
 if(!['aarch64','scalar','x86_64'].includes(arithmetic))throw new PixelConversionError('Invalid pixel arithmetic profile');
 if(!canConvertPixelFormat(input,output))throw new PixelConversionError('Unsupported pixel conversion');
 const source=pixelLayout(videoStoragePixelFormat(input),width,height),destination=pixelLayout(output,width,height);
 const a=descriptor(input)!.family,b=descriptor(output)!.family;
 if(a.startsWith('yuv')&&a!=='yuv444'&&b==='rgb')return inversePlan(source.pixelFormat,destination.pixelFormat,width,height,arithmetic).stateBytes;
 if(a==='rgb'&&b.startsWith('yuv')&&b!=='yuv444'){if(source.pixelFormat==='bgr24'&&width%2===0&&['yuv420p','yuva420p'].includes(destination.pixelFormat))return 0;return chromaStateBytes(width%2===0?width/2:width,height,destination.planes[1]!.width,destination.planes[1]!.height);}
 if(!a.startsWith('yuv')||!b.startsWith('yuv'))return 0;
 return chromaStateBytes(source.planes[1]!.width,source.planes[1]!.height,destination.planes[1]!.width,destination.planes[1]!.height);
}
/** Converts visible pixels into one owned tight allocation with unchanged geometry. */
export function convertVideoFrame(frame:VideoFrameData,outputPixelFormat:string,options:PixelConversionOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options,arithmetic=options.arithmetic??'aarch64';if(!['aarch64','scalar','x86_64'].includes(arithmetic))throw new PixelConversionError('Invalid pixel arithmetic profile');signal?.throwIfAborted();
 const input=pixelLayout(videoStoragePixelFormat(frame.pixelFormat),frame.width,frame.height),output=pixelLayout(outputPixelFormat,frame.width,frame.height);
 if(!canConvertPixelFormat(input.pixelFormat,output.pixelFormat))throw new PixelConversionError(`Unsupported pixel conversion: ${input.pixelFormat} to ${output.pixelFormat}`);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||input.bytes>maxFrameBytes||output.bytes>maxFrameBytes)throw new PixelConversionError('Pixel conversion frame exceeds allocation limit');
 if(frame.planes.length!==input.planes.length||frame.linesizes.length!==input.planes.length)throw new PixelConversionError('Invalid pixel conversion plane count');
 let resident=0n;
 for(const [index,plane]of input.planes.entries()){
  const data=frame.planes[index],stride=frame.linesizes[index];
  if(!(data instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||data.length<stride!*(plane.height-1)+plane.rowBytes)throw new PixelConversionError('Invalid pixel conversion plane stride or storage');
  resident+=BigInt(data.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new PixelConversionError('Pixel conversion input planes exceed aggregate frame limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new PixelConversionError('Invalid pixel conversion timestamp time base');
 const stateBytes=pixelConversionStateBytes(input.pixelFormat,output.pixelFormat,frame.width,frame.height,arithmetic),maxStateBytes=options.maxStateBytes??maxFrameBytes;
 if(!Number.isSafeInteger(maxStateBytes)||maxStateBytes<0||stateBytes>maxStateBytes)throw new PixelConversionError('Chroma conversion state exceeds allocation limit');
 const metadata=sourceRangeMetadata(frame.metadata,frame.pixelFormat),source=descriptor(input.pixelFormat)!,destination=descriptor(output.pixelFormat)!,coefficients=source.family.startsWith('yuv')&&destination.family==='rgb'?frameInverseCoefficients(metadata):defaultInverseCoefficients;
 const rgbChroma=descriptor(input.pixelFormat)!.family==='rgb'&&['yuv420','yuv422'].includes(descriptor(output.pixelFormat)!.family),fastBgr=input.pixelFormat==='bgr24'&&frame.width%2===0&&['yuv420p','yuva420p'].includes(output.pixelFormat);
 const inverse=descriptor(input.pixelFormat)!.family.startsWith('yuv')&&input.pixelFormat!=='yuv444p'&&descriptor(output.pixelFormat)!.family==='rgb';
 const resampling=stateBytes>0&&!inverse,sw=rgbChroma?(frame.width%2===0?frame.width/2:frame.width):input.planes[1]?.width??0,sh=rgbChroma?frame.height:input.planes[1]?.height??0,dw=output.planes[1]?.width??0,dh=output.planes[1]?.height??0;
 const horizontal=resampling?chromaAxis(sw,dw,16384,signal):null,vertical=resampling?chromaAxis(sh,dh,4096,signal):null,scratch=new Int16Array(vertical?vertical.taps*dw:0);
 const data=new Uint8Array(output.bytes);
 const sourceComponents:Partial<Record<ComponentName,Component>>={};for(const component of source.components)sourceComponents[component.name]=component;
 const read=(name:ComponentName,row:number,column:number)=>{const component=sourceComponents[name]!;return frame.planes[component.plane]![row*frame.linesizes[component.plane]!+column*component.step+component.offset]!;};
 if(inverse){
  renderInverse(inversePlan(input.pixelFormat,output.pixelFormat,frame.width,frame.height,arithmetic),read,sourceComponents.A!==undefined,(row,column,r,g,b,a)=>{
   for(const component of destination.components){const plane=output.planes[component.plane]!;data[plane.offset+row*plane.rowBytes+column*component.step+component.offset]=component.name==='R'?r:component.name==='G'?g:component.name==='B'?b:a;}
  },signal,coefficients);
 }else{
 const yuv=source.family.startsWith('yuv')&&destination.family.startsWith('yuv'),color=source.family!==destination.family&&!yuv;
 for(const component of destination.components){
  const previous=sourceComponents[component.name],plane=output.planes[component.plane]!;
  if((resampling||rgbChroma)&&(component.name==='U'||component.name==='V')){
   const name=component.name,average=(channel:ComponentName,y:number,next:number,x:number)=>Math.floor((read(channel,y,x)+read(channel,y,x+1)+read(channel,next,x)+read(channel,next,x+1))/4);
   const sample=(row:number,column:number)=>{if(!rgbChroma)return read(name,row,column);const count=frame.width%2===0?2:1,left=column*count,right=Math.min(frame.width-1,left+1);return rgbChromaQ6(name,read('R',row,left)+(count===2?read('R',row,right):0),read('G',row,left)+(count===2?read('G',row,right):0),read('B',row,left)+(count===2?read('B',row,right):0),count);};
   for(let row=0;row<plane.height;row++){signal?.throwIfAborted();
    if(fastBgr){for(let column=0;column<plane.width;column++){if((column&4095)===0)signal?.throwIfAborted();const x=2*column,y=2*row,next=Math.min(frame.height-1,y+1);data[plane.offset+row*plane.rowBytes+column*component.step+component.offset]=rgbToYuvTruncated(name,average('R',y,next,x),average('G',y,next,x),average('B',y,next,x));}}
    else chromaRow(row,plane.width,sample,horizontal,vertical,scratch,(column,value)=>{data[plane.offset+row*plane.rowBytes+column*component.step+component.offset]=value;},signal,rgbChroma);
   }
   continue;
  }
  for(let row=0;row<plane.height;row++){
   signal?.throwIfAborted();const outputOffset=plane.offset+row*plane.rowBytes+component.offset;
   const inputOffset=previous?row*frame.linesizes[previous.plane]!+previous.offset:0;
   for(let column=0;column<plane.width;column++){
    if((column&4095)===0)signal?.throwIfAborted();
    let value:number;
    if(!color||component.name==='A'){value=previous?frame.planes[previous.plane]![inputOffset+column*previous.step]!:255;if(rgbChroma&&component.name==='A')value=Math.min(255,value+(value>=128?1:0));}
    else if(source.family==='gray'){const gray=read('Y',row,column);value=destination.family==='rgb'?gray:component.name==='Y'?grayToLimited(gray):128;}
    else if(destination.family==='gray')value=source.family==='rgb'?rgbToGray(read('R',row,column),read('G',row,column),read('B',row,column)):metadata.colorRange===2?read('Y',row,column):limitedToGray(read('Y',row,column)*128);
    else if(fastBgr)value=rgbToYuvTruncated(component.name as 'Y',read('R',row,column),read('G',row,column),read('B',row,column));
    else if(source.family==='rgb')value=rgbToYuv(component.name as 'Y'|'U'|'V',read('R',row,column),read('G',row,column),read('B',row,column));
    else value=yuvToRgb(component.name as 'R'|'G'|'B',read('Y',row,column),read('U',row,column),read('V',row,column),coefficients);
    data[outputOffset+column*component.step]=value;
   }
  }
 }
 }
 return {width:output.width,height:output.height,pixelFormat:output.pixelFormat,planes:output.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:output.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:convertedColorMetadata(metadata,source.family==='rgb',destination.family==='rgb',destination.family==='gray')};
}
