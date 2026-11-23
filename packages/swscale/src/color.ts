/** Independent fixed-point model for the pinned native default BT.601 path.
 * Coefficients express full-range RGB -> limited-range YUV at Q15 precision.
 * Native Q6 intermediate quantization followed by Q7 output rounding gives
 * the combined 16640 bias. Keep integer arithmetic exact in JS numbers.
 */
import {defaultInverseCoefficients} from './inverse-coefficients.js';
import type {InverseCoefficients} from './inverse-coefficients.js';
export type YuvComponent='Y'|'U'|'V';
export type RgbComponent='R'|'G'|'B';
const clip=(value:number)=>Math.max(0,Math.min(255,value));
export function rgbLuma(r:number,g:number,b:number):number{return 8414*r+16519*g+3208*b;}
export function rgbToYuv(component:YuvComponent,r:number,g:number,b:number):number{
 const sum=component==='Y'?rgbLuma(r,g,b):component==='U'?-4865*r-9528*g+14392*b:14392*r-12061*g-2332*b;
 return clip(Math.floor((sum+16640)/32768)+(component==='Y'?16:128));
}
/** Full/limited range transforms preserve the native Q7 intermediate precision. */
export function limitedToGray(q7:number):number{return clip(Math.floor((Math.floor((q7*19078-39084288)/16384)+64)/128));}
export function grayToLimited(gray:number):number{return clip(Math.floor((Math.floor((gray*128*14071+33561472)/16384)+64)/128));}
export function rgbToGray(r:number,g:number,b:number):number{return limitedToGray(2*Math.floor((rgbLuma(r,g,b)+524544)/512));}
export function yuvToRgb(component:RgbComponent,y:number,u:number,v:number,c:InverseCoefficients=defaultInverseCoefficients):number{
 const luma=(y-c.yOffset)*c.luma,cb=u-128,cr=v-128;
 const sum=component==='R'?luma+c.vr*cr:component==='G'?luma+c.ug*cb+c.vg*cr:luma+c.ub*cb;
 // The generic native path accumulates Q22 in signed 32-bit storage. In
 // particular, super-white saturated blue may wrap before clipping.
 return clip((((sum+4096)*512)|0)>>22);
}

/** Raw Q6 chroma before horizontal/vertical filtering; r/g/b may be a two-pixel sum. */
export function rgbChromaQ6(component:'U'|'V',r:number,g:number,b:number,count:number):number{
 const sum=component==='U'?-4865*r-9528*g+14392*b:14392*r-12061*g-2332*b;
 return Math.floor((sum+4194304*count+256*count)/(512*count));
}
export function rgbToYuvTruncated(component:YuvComponent,r:number,g:number,b:number):number{
 const sum=component==='Y'?rgbLuma(r,g,b):component==='U'?-4865*r-9528*g+14392*b:14392*r-12061*g-2332*b;
 return Math.floor(sum/32768)+(component==='Y'?16:128);
}
