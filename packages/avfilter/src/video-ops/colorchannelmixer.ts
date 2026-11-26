// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_colorchannelmixer.c and colorchannelmixer_template.c. See ../../NOTICE-COLORCHANNELMIXER.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import type {FilterToken} from '../filter-topology.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import type {VideoFrameOptions} from './descriptor.js';
import {executableFormat} from './formats.js';
export class VideoColorchannelmixerError extends Error {}
/** The sixteen gains in AVOption order: output channel (r, g, b, a) times input channel (r, g, b, a). */
export const colorchannelmixerCoefficients=Object.freeze(['rr','rg','rb','ra','gr','gg','gb','ga','br','bg','bb','ba','ar','ag','ab','aa'] as const);
export type ColorchannelmixerCoefficient=typeof colorchannelmixerCoefficients[number];
export type ColorchannelmixerStep={readonly name:'colorchannelmixer';readonly gains:readonly number[];readonly preserveAmount:number};
/** The pinned pix_fmts in declared order (native-endian names). A negotiated format outside the executable table is refused at plan time. */
export const colorchannelmixerPixelFormats:readonly string[]=Object.freeze('rgb24 bgr24 rgba bgra argb abgr 0rgb 0bgr rgb0 bgr0 rgb48le bgr48le rgba64le bgra64le gbrp gbrap gbrp9le gbrp10le gbrap10le gbrp12le gbrap12le gbrp14le gbrp16le gbrap16le gbrpf32le gbrapf32le'.split(' '));
/** The eight-bit members with frame storage here: rgb24, bgr24, rgba, bgra, argb, abgr and gbrp. */
const executable:readonly string[]=Object.freeze(colorchannelmixerPixelFormats.filter(executableFormat));
/** ff_fill_rgba_map byte offsets of R, G, B, A and the pixel step; gbrp is planar (G, B, R planes). */
const packed:Readonly<Record<string,readonly [number,number,number,number,number]>>={rgb24:[0,1,2,3,3],bgr24:[2,1,0,3,3],rgba:[0,1,2,3,4],bgra:[2,1,0,3,4],argb:[1,2,3,0,4],abgr:[3,2,1,0,4]};
const shorthand=[...colorchannelmixerCoefficients,'pc','pa'];
const identity=Object.freeze([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
/** preserve unit constants, then set_string_number's default, max, min, none and all; the first match wins as in av_expr. */
const preserveNames:readonly [string,number][]=[['none',0],['lum',1],['max',2],['avg',3],['sum',4],['nrm',5],['pwr',6],['default',0],['min',0],['all',-1]];
const decimal=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
/** AV_OPT_TYPE_DOUBLE from a constant decimal or a default/max/min/none/all constant, with the option range check. */
function doubleOption(key:string,text:string,low:number,high:number,fallback:number):number{
 const named:Readonly<Record<string,number>>={default:fallback,max:high,min:low,none:0};
 const value=decimal.test(text)?Number(text):Object.hasOwn(named,text)?named[text]!:Number.NaN;
 if(Number.isNaN(value))throw new VideoFilterParseError(`Only constant decimal colorchannelmixer ${key} values are implemented`);
 if(!(value>=low&&value<=high))throw new VideoFilterParseError(`Invalid colorchannelmixer ${key}: value outside ${low}..${high}`);
 return value;
}
/** AV_OPT_TYPE_INT pc: llrint of the constant; only P_NONE is implemented. */
function preserveOption(text:string):number{
 const constant=preserveNames.find(([name])=>name===text);let value:number;
 if(constant)value=constant[1];else if(decimal.test(text)){const number=Number(text),lower=Math.floor(number),fraction=number-lower;value=fraction<0.5?lower:fraction>0.5?lower+1:lower%2===0?lower:lower+1;}
 else throw new VideoFilterParseError('Only constant colorchannelmixer pc values are implemented');
 if(!Number.isFinite(value)||value<0||value>6)throw new VideoFilterParseError('Invalid colorchannelmixer pc: value outside 0..6');
 if(value!==0)throw new VideoFilterParseError('Colorchannelmixer color preservation (pc other than none) is not implemented');
 return 0;
}
/** colorchannelmixer_options applied in order; pc other than none (the float preserve path) is refused, pa is parsed and range checked. */
export function parseColorchannelmixerOptions(options:string|null):ColorchannelmixerStep{
 const gains=[...identity];let preserveAmount=0;
 for(const option of filterOptions(options,shorthand)){
  const index=(colorchannelmixerCoefficients as readonly string[]).indexOf(option.key);
  if(index>=0)gains[index]=doubleOption(option.key,option.value,-2,2,identity[index]!);
  else if(option.key==='pc')preserveOption(option.value);
  else if(option.key==='pa')preserveAmount=doubleOption('pa',option.value,0,1,0);
  else if(option.key==='enable')throw new VideoFilterParseError('Colorchannelmixer timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported colorchannelmixer option');
 }
 return Object.freeze({name:'colorchannelmixer',gains:Object.freeze(gains),preserveAmount});
}
/** lrint under the default round-to-nearest-even mode, for |value| <= 510. */
const lrint=(value:number)=>{const rounded=Math.round(value);return rounded-value===0.5&&(rounded&1)!==0?rounded-1:rounded;};
/** config_output's sixteen 8-bit tables: lut[i][j][v] = lrint(v * gain), flattened as (i * 4 + j) * 256 + v. */
export function colorchannelmixerTables(gains:readonly number[]):Int32Array{
 const lut=new Int32Array(4096);
 for(let k=0;k<16;k++){const gain=gains[k]!;for(let v=0;v<256;v++)lut[k*256+v]=lrint(v*gain);}
 return lut;
}
const clip=(value:number)=>value<0?0:value>255?255:value;
/** filter_slice_rgba_packed_8 and filter_slice_rgba_planar_8 with pc=none: four table entries summed and clipped with
 * av_clip_uintp2(…, 8). Packed formats without alpha and gbrp skip the alpha terms. Owned tight planes. */
export function mixVideoChannels(frame:VideoFrameData,step:ColorchannelmixerStep,options:VideoFrameOptions):VideoFrameData{
 const {maxFrameBytes,signal}=options;signal?.throwIfAborted();
 const {gains}=step;
 if(!Array.isArray(gains)||gains.length!==16||gains.some(gain=>typeof gain!=='number'||!(gain>=-2&&gain<=2)))throw new VideoColorchannelmixerError('Invalid colorchannelmixer settings');
 if(!executable.includes(frame.pixelFormat))throw new VideoColorchannelmixerError('Colorchannelmixer pixel format is not supported');
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);
 if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||layout.bytes>maxFrameBytes)throw new VideoColorchannelmixerError('Colorchannelmixer frame exceeds allocation limit');
 if(frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new VideoColorchannelmixerError('Invalid colorchannelmixer plane count');
 let resident=0n;
 for(const [index,plane]of layout.planes.entries()){
  const input=frame.planes[index],stride=frame.linesizes[index];
  if(!(input instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(input.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new VideoColorchannelmixerError('Invalid colorchannelmixer plane stride or storage');
  resident+=BigInt(input.length);
 }
 if(resident>BigInt(maxFrameBytes))throw new VideoColorchannelmixerError('Colorchannelmixer input plane storage exceeds allocation limit');
 if(frame.pts&&(frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new VideoColorchannelmixerError('Invalid colorchannelmixer timestamp time base');
 const lut=colorchannelmixerTables(gains),data=new Uint8Array(layout.bytes),{width,height}=frame,map=packed[frame.pixelFormat];
 if(map){
  const [ro,go,bo,ao,pixel]=map,alpha=pixel===4,plane=layout.planes[0]!,input=frame.planes[0]!,stride=frame.linesizes[0]!;
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();const source=y*stride,target=plane.offset+y*plane.rowBytes;
   for(let x=0;x<width;x++){
    if((x&4095)===0)signal?.throwIfAborted();
    const s=source+x*pixel,t=target+x*pixel,r=input[s+ro]!,g=input[s+go]!,b=input[s+bo]!,a=alpha?input[s+ao]!:0;
    data[t+ro]=clip(lut[r]!+lut[256+g]!+lut[512+b]!+(alpha?lut[768+a]!:0));
    data[t+go]=clip(lut[1024+r]!+lut[1280+g]!+lut[1536+b]!+(alpha?lut[1792+a]!:0));
    data[t+bo]=clip(lut[2048+r]!+lut[2304+g]!+lut[2560+b]!+(alpha?lut[2816+a]!:0));
    if(alpha)data[t+ao]=clip(lut[3072+r]!+lut[3328+g]!+lut[3584+b]!+lut[3840+a]!);
   }
  }
 }else{
  // gbrp: data[0] = G, data[1] = B, data[2] = R; have_alpha is 0.
  const [gp,bp,rp]=layout.planes as unknown as readonly [typeof layout.planes[0],typeof layout.planes[0],typeof layout.planes[0]];
  const [gi,bi,ri]=frame.planes as unknown as readonly [Uint8Array,Uint8Array,Uint8Array],[gs,bs,rs]=frame.linesizes as unknown as readonly [number,number,number];
  for(let y=0;y<height;y++){
   signal?.throwIfAborted();const gr=y*gs,br=y*bs,rr=y*rs,go=gp.offset+y*gp.rowBytes,bo=bp.offset+y*bp.rowBytes,ro=rp.offset+y*rp.rowBytes;
   for(let x=0;x<width;x++){
    if((x&4095)===0)signal?.throwIfAborted();
    const r=ri[rr+x]!,g=gi[gr+x]!,b=bi[br+x]!;
    data[ro+x]=clip(lut[r]!+lut[256+g]!+lut[512+b]!);
    data[go+x]=clip(lut[1024+r]!+lut[1280+g]!+lut[1536+b]!);
    data[bo+x]=clip(lut[2048+r]!+lut[2304+g]!+lut[2560+b]!);
   }
  }
 }
 return {width,height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
/** enable= and runtime commands are refused: the descriptor sets neither timeline nor geometryCommands. */
export const colorchannelmixerOperator=defineVideoOperator<ColorchannelmixerStep>({name:'colorchannelmixer',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['colorchannelmixer','format=gbrp,colorchannelmixer','format=rgba,colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131','format=gbrp,colorchannelmixer=rr=-1:gg=0.5:bb=2,hflip','format=rgb24,colorchannelmixer=pc=none:pa=0.5:rb=1.5'],
 parse:(token:FilterToken)=>singlePad(parseColorchannelmixerOptions(token.options)),
 formats:()=>colorchannelmixerPixelFormats,
 frame:(frame,step,options)=>mixVideoChannels(frame,step,options)});
