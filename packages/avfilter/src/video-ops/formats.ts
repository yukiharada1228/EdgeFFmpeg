// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted format negotiation and loss scoring; see ../../NOTICE and ../../NOTICE-VIDEO-OPS for provenance.
/** The one negotiation table shared by the linear, frame-graph and timed negotiators. */
interface Descriptor {kind:'gray'|'rgb'|'yuv';components:number;w:number;h:number;bits:number;alpha:boolean}
export const negotiationOrder=['yuv420p','rgb24','bgr24','yuv422p','yuv444p','gray','nv12','nv21','argb','rgba','abgr','bgra','yuva420p','gbrp'] as const;
const order=negotiationOrder;
const descriptors:Readonly<Record<string,Descriptor>>={
 gray:{kind:'gray',components:1,w:0,h:0,bits:8,alpha:false},
 yuv420p:{kind:'yuv',components:3,w:1,h:1,bits:12,alpha:false},
 yuv422p:{kind:'yuv',components:3,w:1,h:0,bits:16,alpha:false},
 yuv444p:{kind:'yuv',components:3,w:0,h:0,bits:24,alpha:false},
 yuva420p:{kind:'yuv',components:4,w:1,h:1,bits:20,alpha:true},
 nv12:{kind:'yuv',components:3,w:1,h:1,bits:12,alpha:false},
 nv21:{kind:'yuv',components:3,w:1,h:1,bits:12,alpha:false},
 ...Object.fromEntries(['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'].map(name=>{
  const alpha=!['rgb24','bgr24','gbrp'].includes(name);
  return [name,{kind:'rgb' as const,components:alpha?4:3,w:0,h:0,bits:alpha?32:24,alpha}];
 }))
};
export const negotiableFormat=(format:string)=>Object.hasOwn(descriptors,format);
function score(source:string,target:string):number {
 if(source===target)return 2147483647;
 const a=descriptors[source]!,b=descriptors[target]!;let value=2147483646;
 if(b.w>a.w)value-=256<<b.w;if(b.h>a.h)value-=256<<b.h;
 if(b.w===1&&a.w===0&&b.h===1&&a.h===0)value+=512;
 if(b.w<a.w)value-=1<<(a.w-b.w);if(b.h<a.h)value-=1<<(a.h-b.h);
 if(b.kind==='rgb'?a.kind!=='rgb'&&a.kind!=='gray':b.kind==='gray'?a.kind!=='gray':a.kind!=='yuv')value-=Math.min(a.components,b.components)*512;
 if(b.kind==='gray'&&a.kind!=='gray')value-=131072;
 if(a.alpha&&!b.alpha)value-=65536;
 return value;
}
export function chooseFormat(source:string,values:readonly string[]):string {
 let selected=values[0]!;
 for(const candidate of values.slice(1)){
  const difference=score(source,candidate)-score(source,selected),a=descriptors[selected]!,b=descriptors[candidate]!;
  if(difference>0||difference===0&&(b.bits<a.bits||b.bits===a.bits&&(b.components<a.components||b.components===a.components&&order.indexOf(candidate as typeof order[number])<order.indexOf(selected as typeof order[number]))))selected=candidate;
 }
 return selected;
}
export interface FormatGroup {values:string[];parent:FormatGroup}
export function formatGroup(values:readonly string[]):FormatGroup {const result={values:[...values]} as FormatGroup;result.parent=result;return result;}
export function formatRoot(value:FormatGroup):FormatGroup {let result=value;while(result.parent!==result)result=result.parent;while(value.parent!==value){const next=value.parent;value.parent=result;value=next;}return result;}
export function mergeFormats(left:FormatGroup,right:FormatGroup):boolean {
 left=formatRoot(left);right=formatRoot(right);if(left===right)return true;
 const common=left.values.filter(format=>right.values.includes(format)),alpha=(values:readonly string[])=>values.some(format=>descriptors[format]!.alpha),color=(values:readonly string[])=>values.some(format=>descriptors[format]!.components>1);
 // Keep conversion boundaries when intersection would discard chroma or alpha.
 if(!common.length||alpha(left.values)&&alpha(right.values)&&!alpha(common)||color(left.values)&&color(right.values)&&!color(common))return false;
 left.values=common;right.parent=left;return true;
}
