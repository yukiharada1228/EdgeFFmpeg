// SPDX-License-Identifier: LGPL-2.1-or-later
// Box and grid drawing adapted from pinned FFmpeg libavfilter/vf_drawbox.c (init, config_input, draw_region,
// draw_region_rgb_packed, pixel_belongs_to_box, pixel_belongs_to_grid) and libavutil/colorspace.h RGB_TO_*_CCIR
// at 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../NOTICE-DRAWBOX.
import {ColorParseError,compileExpression,evaluateExpression,parseColor,pixelLayout,videoStoragePixelFormat} from '@edge-ffmpeg/avutil';
import type {ExpressionNumericProfile,VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from './video-syntax.js';
import {filterBoolean} from './video-ops/options.js';
export class VideoDrawboxError extends Error {}
export type DrawboxKind='drawbox'|'drawgrid';
export interface VideoDrawboxSettings {readonly x:string;readonly y:string;readonly width:string;readonly height:string;readonly thickness:string;readonly color:string;readonly rgba:readonly [number,number,number,number];readonly invert:boolean;readonly replace:boolean}
export interface VideoDrawboxOptions {readonly maxFrameBytes:number;readonly signal?:AbortSignal}
/** The resolved config_input state: integer box or grid geometry and the chroma shifts of the negotiated format. */
export interface DrawboxGeometry {readonly x:number;readonly y:number;readonly w:number;readonly h:number;readonly t:number;readonly hsub:number;readonly vsub:number}
/** The pinned pix_fmts in declared order. */
export const drawboxNativeFormats:readonly string[]=Object.freeze('yuv444p yuv422p yuv420p yuv411p yuv410p yuvj444p yuvj422p yuvj420p yuv440p yuvj440p yuva420p yuva422p yuva444p rgb24 bgr24 rgba bgra argb abgr 0rgb 0bgr rgb0 bgr0'.split(' '));
/** [log2_chroma_w, log2_chroma_h] of the members with frame storage here (yuvj names share planar storage). */
const planar:Readonly<Record<string,readonly [number,number]>>={yuv444p:[0,0],yuv422p:[1,0],yuv420p:[1,1],yuvj444p:[0,0],yuvj422p:[1,0],yuvj420p:[1,1],yuva420p:[1,1]};
/** ff_fill_rgba_map offsets [R, G, B, A] and the padded pixel step. */
const packed:Readonly<Record<string,{readonly map:readonly number[];readonly step:number;readonly alpha:boolean}>>={rgb24:{map:[0,1,2,3],step:3,alpha:false},bgr24:{map:[2,1,0,3],step:3,alpha:false},rgba:{map:[0,1,2,3],step:4,alpha:true},bgra:{map:[2,1,0,3],step:4,alpha:true},argb:{map:[1,2,3,0],step:4,alpha:true},abgr:{map:[3,2,1,0],step:4,alpha:true}};
export const drawboxPixelFormats:readonly string[]=Object.freeze(drawboxNativeFormats.filter(format=>format in planar||format in packed));
/** var_names in declared order; "fill" names VAR_MAX. */
const names=Object.freeze(['dar','hsub','vsub','in_h','ih','in_w','iw','sar','x','y','h','w','t','fill']);
const INT_MAX=2147483647,INT_MIN=-2147483648;
/** eval.c functions that are arithmetic, comparisons, integer conversions or ported glibc kernels; everything else
 * (JavaScript libm, random, time, print, contracted lerp, iterative while/taylor/root) is refused. */
const refusedFunctions=['sinh','cosh','tanh','sin','cos','tan','atan','asin','acos','exp','time','squish','gauss','while','taylor','root','pow','print','random','randomi','atan2','lerp'];
/** Maximal identifier runs (IS_IDENTIFIER_CHAR); a primary that strmatch resolves always ends a run. */
const runs=(text:string)=>text.match(/[0-9A-Za-z_]+/g)??[];
function expression(value:string,key:string):string{
 for(const run of runs(value)){
  const call=refusedFunctions.find(name=>run.endsWith(name));if(call)throw new VideoDrawboxError(`Drawbox ${key} expressions calling ${call}() are not implemented`);
  if(run.endsWith('sar')||run.endsWith('dar'))throw new VideoDrawboxError(`Drawbox ${key} expressions reading sar or dar are not implemented`);
 }
 try{compileExpression(value,{numericProfile:'linux-x64',constants:names});}catch{throw new VideoDrawboxError(`Error when evaluating the expression '${value}'.`);}
 return value;
}
const FIX=(x:number)=>Math.trunc(x*1024+0.5);
/** RGB_TO_Y_CCIR, RGB_TO_U_CCIR and RGB_TO_V_CCIR with shift 0, and the colour alpha. */
export function drawboxYuvColor([r,g,b,a]:readonly number[]):readonly [number,number,number,number]{
 const y=FIX(0.299*219/255)*r!+FIX(0.587*219/255)*g!+FIX(0.114*219/255)*b!+(512+(16<<10))>>10;
 const u=(-FIX(0.16874*224/255)*r!-FIX(0.33126*224/255)*g!+FIX(0.5*224/255)*b!+512-1>>10)+128,v=(FIX(0.5*224/255)*r!-FIX(0.41869*224/255)*g!-FIX(0.08131*224/255)*b!+512-1>>10)+128;
 return [y&255,u&255,v&255,a!];
}
/** AVOptions of drawbox and drawgrid (shorthand in declaration order, aliases share it); init's colour preparation. */
export function parseDrawboxOptions(kind:DrawboxKind,options:string|null):VideoDrawboxSettings{
 const label=kind==='drawbox'?'Drawbox':'Drawgrid';
 let x='0',y='0',width='0',height='0',thickness=kind==='drawbox'?'3':'1',color='black',replace=false;
 for(const option of filterOptions(options,kind==='drawbox'?['x','y','width','height','color','thickness','replace','box_source']:['x','y','width','height','color','thickness','replace'])){
  switch(option.key){
   case 'x':x=option.value;break;case 'y':y=option.value;break;
   case 'width':case 'w':width=option.value;break;case 'height':case 'h':height=option.value;break;
   case 'thickness':case 't':thickness=option.value;break;case 'color':case 'c':color=option.value;break;
   case 'replace':try{replace=filterBoolean(option.value);}catch{throw new VideoDrawboxError(`Invalid ${kind} replace value`);}break;
   case 'box_source':if(kind==='drawbox')throw new VideoDrawboxError('Drawbox box_source is not implemented');throw new VideoDrawboxError('Unsupported drawgrid option');
   case 'enable':throw new VideoDrawboxError(`${label} timeline expressions are not implemented`);
   default:throw new VideoDrawboxError(`Unsupported ${kind} option`);
  }
 }
 const invert=color==='invert';let rgba:readonly [number,number,number,number]=[0,0,0,255];
 if(!invert)try{rgba=parseColor(color);}catch(error){if(error instanceof ColorParseError)throw new VideoDrawboxError(error.code==='invalid'?error.message:`${label} color '${color}' is not supported: ${error.message}`);throw error;}
 return Object.freeze({x:expression(x,'x'),y:expression(y,'y'),width:expression(width,'width'),height:expression(height,'height'),thickness:expression(thickness,'thickness'),color,rgba:Object.freeze([...rgba]) as unknown as readonly [number,number,number,number],invert,replace});
}
/** (int) of a double on the reference: null where C leaves the conversion undefined. */
const integer=(value:number)=>Number.isNaN(value)||value>=2147483648||value<=-2147483649?null:Math.trunc(value)||0;
const inRange=(value:number)=>value>=INT_MIN&&value<=INT_MAX;
const reads=(text:string,name:string)=>runs(text).some(run=>run.endsWith(name));
/** config_input's NUM_EXPR_EVALS + 1 passes over x, y, w, h and t under one expression profile. */
function evaluate(kind:DrawboxKind,s:VideoDrawboxSettings,W:number,H:number,hsub:number,vsub:number,profile:ExpressionNumericProfile):readonly number[]{
 const values=[W/H,hsub,vsub,H,H,W,W,1,NaN,NaN,NaN,NaN,NaN,NaN],order=[[s.x,8],[s.y,9],[s.width,11],[s.height,10],[s.thickness,12]] as const,ints=[0,0,0,0,0];
 let sx:number|null=0,sy:number|null=0;
 for(let pass=0;pass<=5;pass++){
  for(const [index,[text,slot]]of order.entries()){
   const fill=index===0?W:index===1?H:index===2?(sx===null?null:W-sx):index===3?(sy===null?null:H-sy):INT_MAX;
   if(fill===null||!inRange(fill)){if(reads(text,'fill'))throw new VideoDrawboxError(`${kind} fill in '${text}' depends on an undefined integer conversion and is not implemented`);values[13]=NaN;}else values[13]=fill;
   let result:number;try{result=evaluateExpression(text,{numericProfile:profile,constants:names},values);}catch{throw new VideoDrawboxError(`${kind} expression '${text}' exceeds the evaluation bounds`);}
   values[slot]=result;const converted=integer(result);
   if(pass===5){if(Number.isNaN(result))throw new VideoDrawboxError(`Error when evaluating the expression '${text}'.`);if(converted===null)throw new VideoDrawboxError(`${kind} expression '${text}' gives ${result}, outside the int range`);}
   ints[index]=converted??0;if(index===0)sx=converted;if(index===1)sy=converted;
  }
 }
 return ints;
}
const cache=new WeakMap<VideoDrawboxSettings,Map<string,DrawboxGeometry>>();
/** config_input for one negotiated format and size; refuses formats without storage, platform-dependent results and int overflow. */
export function drawboxGeometry(kind:DrawboxKind,settings:VideoDrawboxSettings,pixelFormat:string,width:number,height:number):DrawboxGeometry{
 const key=`${pixelFormat}/${width}/${height}`,known=cache.get(settings)?.get(key);if(known)return known;
 const shift=planar[pixelFormat]??(pixelFormat in packed?[0,0] as const:null);if(!shift)throw new VideoDrawboxError(`${kind} pixel format is not supported`);
 if(!Number.isSafeInteger(width)||width<1||width>INT_MAX||!Number.isSafeInteger(height)||height<1||height>INT_MAX)throw new VideoDrawboxError(`Invalid ${kind} frame size`);
 const [hsub,vsub]=shift,linux=evaluate(kind,settings,width,height,hsub,vsub,'linux-x64'),darwin=evaluate(kind,settings,width,height,hsub,vsub,'darwin-arm64');
 if(linux.some((value,index)=>value!==darwin[index]))throw new VideoDrawboxError(`${kind} expressions give platform-dependent geometry and are not implemented`);
 const [x,y,w0,h0,t]=linux as [number,number,number,number,number],w=w0>0?w0:width,h=h0>0?h0:height;
 if(kind==='drawbox'?!inRange(x+w)||!inRange(y+h):!inRange(-x)||!inRange(width-1-x)||!inRange(-y)||!inRange(height-1-y))throw new VideoDrawboxError(`${kind} geometry overflows int and is not implemented`);
 const geometry=Object.freeze({x,y,w,h,t,hsub,vsub});
 let entries=cache.get(settings);if(!entries){entries=new Map();cache.set(settings,entries);}if(entries.size<64)entries.set(key,geometry);
 return geometry;
}
/** filter_frame / drawgrid_filter_frame into owned tight planes; the input frame is never written. */
export function drawboxVideoFrame(kind:DrawboxKind,frame:VideoFrameData,settings:VideoDrawboxSettings,options:VideoDrawboxOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const storage=videoStoragePixelFormat(frame.pixelFormat);if(!(frame.pixelFormat in planar||frame.pixelFormat in packed))throw new VideoDrawboxError(`${kind} pixel format is not supported`);
 const layout=pixelLayout(storage,frame.width,frame.height),g=drawboxGeometry(kind,settings,frame.pixelFormat,frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoDrawboxError(`${kind} frame exceeds allocation limit`);
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoDrawboxError(`Invalid ${kind} plane count`);
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>INT_MAX||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoDrawboxError(`Invalid ${kind} plane stride or storage`);
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoDrawboxError(`${kind} input plane storage exceeds allocation limit`);
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoDrawboxError(`Invalid ${kind} timestamp time base`);
 const data=new Uint8Array(layout.bytes),planes=layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes));
 for(const [index,plane]of layout.planes.entries()){const input=frame.planes[index]!,stride=frame.linesizes[index]!;for(let y=0;y<plane.height;y++){if((y&255)===0)signal?.throwIfAborted();planes[index]!.set(input.subarray(y*stride,y*stride+plane.rowBytes),y*plane.rowBytes);}}
 const W=frame.width,H=frame.height,{x:sx,y:sy,w:sw,h:sh,t,hsub,vsub}=g;
 const belongs=kind==='drawbox'?(x:number,y:number)=>y-sy<t||sy+sh-1-y<t||x-sx<t||sx+sw-1-x<t:(x:number,y:number)=>{let xm=(x-sx)%sw,ym=(y-sy)%sh;if(xm<0)xm+=sw;if(ym<0)ym+=sh;return xm<t||ym<t;};
 const [left,top,right,down]=kind==='drawbox'?[Math.max(sx,0),Math.max(sy,0),Math.min(sx+sw,W),Math.min(sy+sh,H)]:[0,0,W,H];
 const {invert,replace,rgba}=settings,layoutInfo=packed[frame.pixelFormat];
 if(!layoutInfo){
  const [cy,cu,cv,ca]=drawboxYuvColor(rgba),[Y,U,V,A]=planes as [Uint8Array,Uint8Array,Uint8Array,Uint8Array|undefined],cw=layout.planes[1]!.width,alpha=ca/255;
  for(let y=top;y<down;y++){
   if((y&63)===0)signal?.throwIfAborted();const ly=y*W,c=(y>>vsub)*cw;
   if(invert){for(let x=left;x<right;x++)if(belongs(x,y))Y[ly+x]=255-Y[ly+x]!;}
   else if(A&&replace){for(let x=left;x<right;x++)if(belongs(x,y)){Y[ly+x]=cy;U[c+(x>>hsub)]=cu;V[c+(x>>hsub)]=cv;A[ly+x]=ca;}}
   else for(let x=left;x<right;x++)if(belongs(x,y)){const ci=c+(x>>hsub);Y[ly+x]=(1-alpha)*Y[ly+x]!+alpha*cy;U[ci]=(1-alpha)*U[ci]!+alpha*cu;V[ci]=(1-alpha)*V[ci]!+alpha*cv;}
  }
 }else{
  // Uint8Array stores truncate the non-negative double, as the C conversion of an in-range value does.
  const {map,step,alpha:hasAlpha}=layoutInfo,d=planes[0]!,[r0,g0,b0,a0]=map as [number,number,number,number],f=Math.fround,alpha=f(rgba[3]/255),rest=f(1-alpha);
  const blend=(p:number,c:number)=>f(f(rest*p)+f(alpha*c));
  for(let y=top;y<down;y++){
   if((y&63)===0)signal?.throwIfAborted();const row=y*W*step;
   for(let x=left;x<right;x++){
    if(!belongs(x,y))continue;const o=row+x*step;
    if(invert){d[o+r0]=255-d[o+r0]!;d[o+g0]=255-d[o+g0]!;d[o+b0]=255-d[o+b0]!;}
    else if(hasAlpha&&replace){d[o+r0]=rgba[0];d[o+g0]=rgba[1];d[o+b0]=rgba[2];d[o+a0]=rgba[3];}
    else{d[o+r0]=blend(d[o+r0]!,rgba[0]);d[o+g0]=blend(d[o+g0]!,rgba[1]);d[o+b0]=blend(d[o+b0]!,rgba[2]);}
   }
  }
 }
 signal?.throwIfAborted();
 return {width:W,height:H,pixelFormat:layout.pixelFormat,planes,linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
