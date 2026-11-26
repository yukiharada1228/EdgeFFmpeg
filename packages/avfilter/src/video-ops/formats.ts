// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted format negotiation and loss scoring; see ../../NOTICE, ../../NOTICE-VIDEO-OPS and ../../NOTICE-VIDEO-NEGOTIATION for provenance.
// Fast-lane probe (wave2/ci-fast-probe2): a comment-only change in a module tests reach through the video-ops registry.
import {videoStoragePixelFormat} from '@edge-ffmpeg/avutil';
/** The one negotiation table shared by the linear, frame-graph and timed negotiators: every non-hwaccel
 * pixel format of the pinned build in AVPixelFormat order, as name, nb_components,
 * log2_chroma_w, log2_chroma_h, flags, av_get_padded_bits_per_pixel, vf_scale list membership
 * (bit 0 input: sws_test_format(f,0); bit 1 output: sws_test_format(f,1) or pal8) and component depths. */
const rows=`
yuv420p 3 1 1 16 12 3 8.8.8,yuyv422 3 1 0 0 16 3 8.8.8,rgb24 3 0 0 32 24 3 8.8.8,bgr24 3 0 0 32 24 3 8.8.8,yuv422p 3 1 0 16 16 3 8.8.8,yuv444p 3 0 0 16 24 3 8.8.8,
yuv410p 3 2 2 16 9 3 8.8.8,yuv411p 3 2 0 16 12 3 8.8.8,gray 1 0 0 0 8 3 8,monow 1 0 0 4 1 3 1,monob 1 0 0 4 1 3 1,pal8 1 0 0 130 8 3 8,
yuvj420p 3 1 1 16 12 3 8.8.8,yuvj422p 3 1 0 16 16 3 8.8.8,yuvj444p 3 0 0 16 24 3 8.8.8,uyvy422 3 1 0 0 16 3 8.8.8,uyyvyy411 3 2 0 0 12 1 8.8.8,bgr8 3 0 0 32 8 3 3.3.2,
bgr4 3 0 0 36 4 2 1.2.1,bgr4_byte 3 0 0 32 8 3 1.2.1,rgb8 3 0 0 32 8 3 3.3.2,rgb4 3 0 0 36 4 2 1.2.1,rgb4_byte 3 0 0 32 8 3 1.2.1,nv12 3 1 1 16 12 3 8.8.8,
nv21 3 1 1 16 12 3 8.8.8,argb 4 0 0 160 32 3 8.8.8.8,rgba 4 0 0 160 32 3 8.8.8.8,abgr 4 0 0 160 32 3 8.8.8.8,bgra 4 0 0 160 32 3 8.8.8.8,gray16be 1 0 0 1 16 3 16,
gray16le 1 0 0 0 16 3 16,yuv440p 3 0 1 16 16 3 8.8.8,yuvj440p 3 0 1 16 16 3 8.8.8,yuva420p 4 1 1 144 20 3 8.8.8.8,rgb48be 3 0 0 33 48 3 16.16.16,rgb48le 3 0 0 32 48 3 16.16.16,
rgb565be 3 0 0 33 16 3 5.6.5,rgb565le 3 0 0 32 16 3 5.6.5,rgb555be 3 0 0 33 16 3 5.5.5,rgb555le 3 0 0 32 16 3 5.5.5,bgr565be 3 0 0 33 16 3 5.6.5,bgr565le 3 0 0 32 16 3 5.6.5,
bgr555be 3 0 0 33 16 3 5.5.5,bgr555le 3 0 0 32 16 3 5.5.5,yuv420p16le 3 1 1 16 24 3 16.16.16,yuv420p16be 3 1 1 17 24 3 16.16.16,yuv422p16le 3 1 0 16 32 3 16.16.16,yuv422p16be 3 1 0 17 32 3 16.16.16,
yuv444p16le 3 0 0 16 48 3 16.16.16,yuv444p16be 3 0 0 17 48 3 16.16.16,rgb444le 3 0 0 32 16 3 4.4.4,rgb444be 3 0 0 33 16 3 4.4.4,bgr444le 3 0 0 32 16 3 4.4.4,bgr444be 3 0 0 33 16 3 4.4.4,
ya8 2 0 0 128 16 3 8.8,bgr48be 3 0 0 33 48 3 16.16.16,bgr48le 3 0 0 32 48 3 16.16.16,yuv420p9be 3 1 1 17 24 3 9.9.9,yuv420p9le 3 1 1 16 24 3 9.9.9,yuv420p10be 3 1 1 17 24 3 10.10.10,
yuv420p10le 3 1 1 16 24 3 10.10.10,yuv422p10be 3 1 0 17 32 3 10.10.10,yuv422p10le 3 1 0 16 32 3 10.10.10,yuv444p9be 3 0 0 17 48 3 9.9.9,yuv444p9le 3 0 0 16 48 3 9.9.9,yuv444p10be 3 0 0 17 48 3 10.10.10,
yuv444p10le 3 0 0 16 48 3 10.10.10,yuv422p9be 3 1 0 17 32 3 9.9.9,yuv422p9le 3 1 0 16 32 3 9.9.9,gbrp 3 0 0 48 24 3 8.8.8,gbrp9be 3 0 0 49 48 3 9.9.9,gbrp9le 3 0 0 48 48 3 9.9.9,
gbrp10be 3 0 0 49 48 3 10.10.10,gbrp10le 3 0 0 48 48 3 10.10.10,gbrp16be 3 0 0 49 48 3 16.16.16,gbrp16le 3 0 0 48 48 3 16.16.16,yuva422p 4 1 0 144 24 3 8.8.8.8,yuva444p 4 0 0 144 32 3 8.8.8.8,
yuva420p9be 4 1 1 145 40 3 9.9.9.9,yuva420p9le 4 1 1 144 40 3 9.9.9.9,yuva422p9be 4 1 0 145 48 3 9.9.9.9,yuva422p9le 4 1 0 144 48 3 9.9.9.9,yuva444p9be 4 0 0 145 64 3 9.9.9.9,yuva444p9le 4 0 0 144 64 3 9.9.9.9,
yuva420p10be 4 1 1 145 40 3 10.10.10.10,yuva420p10le 4 1 1 144 40 3 10.10.10.10,yuva422p10be 4 1 0 145 48 3 10.10.10.10,yuva422p10le 4 1 0 144 48 3 10.10.10.10,yuva444p10be 4 0 0 145 64 3 10.10.10.10,yuva444p10le 4 0 0 144 64 3 10.10.10.10,
yuva420p16be 4 1 1 145 40 3 16.16.16.16,yuva420p16le 4 1 1 144 40 3 16.16.16.16,yuva422p16be 4 1 0 145 48 3 16.16.16.16,yuva422p16le 4 1 0 144 48 3 16.16.16.16,yuva444p16be 4 0 0 145 64 3 16.16.16.16,yuva444p16le 4 0 0 144 64 3 16.16.16.16,
xyz12le 3 0 0 1024 48 3 12.12.12,xyz12be 3 0 0 1025 48 3 12.12.12,nv16 3 1 0 16 16 3 8.8.8,nv20le 3 1 0 16 32 3 10.10.10,nv20be 3 1 0 17 32 3 10.10.10,rgba64be 4 0 0 161 64 3 16.16.16.16,
rgba64le 4 0 0 160 64 3 16.16.16.16,bgra64be 4 0 0 161 64 3 16.16.16.16,bgra64le 4 0 0 160 64 3 16.16.16.16,yvyu422 3 1 0 0 16 3 8.8.8,ya16be 2 0 0 129 32 3 16.16,ya16le 2 0 0 128 32 3 16.16,
gbrap 4 0 0 176 32 3 8.8.8.8,gbrap16be 4 0 0 177 64 3 16.16.16.16,gbrap16le 4 0 0 176 64 3 16.16.16.16,0rgb 3 0 0 32 32 3 8.8.8,rgb0 3 0 0 32 32 3 8.8.8,0bgr 3 0 0 32 32 3 8.8.8,
bgr0 3 0 0 32 32 3 8.8.8,yuv420p12be 3 1 1 17 24 3 12.12.12,yuv420p12le 3 1 1 16 24 3 12.12.12,yuv420p14be 3 1 1 17 24 3 14.14.14,yuv420p14le 3 1 1 16 24 3 14.14.14,yuv422p12be 3 1 0 17 32 3 12.12.12,
yuv422p12le 3 1 0 16 32 3 12.12.12,yuv422p14be 3 1 0 17 32 3 14.14.14,yuv422p14le 3 1 0 16 32 3 14.14.14,yuv444p12be 3 0 0 17 48 3 12.12.12,yuv444p12le 3 0 0 16 48 3 12.12.12,yuv444p14be 3 0 0 17 48 3 14.14.14,
yuv444p14le 3 0 0 16 48 3 14.14.14,gbrp12be 3 0 0 49 48 3 12.12.12,gbrp12le 3 0 0 48 48 3 12.12.12,gbrp14be 3 0 0 49 48 3 14.14.14,gbrp14le 3 0 0 48 48 3 14.14.14,yuvj411p 3 2 0 16 12 3 8.8.8,
bayer_bggr8 3 0 0 288 8 1 2.4.2,bayer_rggb8 3 0 0 288 8 1 2.4.2,bayer_gbrg8 3 0 0 288 8 1 2.4.2,bayer_grbg8 3 0 0 288 8 1 2.4.2,bayer_bggr16le 3 0 0 288 16 1 4.8.4,bayer_bggr16be 3 0 0 289 16 1 4.8.4,
bayer_rggb16le 3 0 0 288 16 1 4.8.4,bayer_rggb16be 3 0 0 289 16 1 4.8.4,bayer_gbrg16le 3 0 0 288 16 1 4.8.4,bayer_gbrg16be 3 0 0 289 16 1 4.8.4,bayer_grbg16le 3 0 0 288 16 1 4.8.4,bayer_grbg16be 3 0 0 289 16 1 4.8.4,
yuv440p10le 3 0 1 16 32 3 10.10.10,yuv440p10be 3 0 1 17 32 3 10.10.10,yuv440p12le 3 0 1 16 32 3 12.12.12,yuv440p12be 3 0 1 17 32 3 12.12.12,ayuv64le 4 0 0 128 64 3 16.16.16.16,ayuv64be 4 0 0 129 64 3 16.16.16.16,
p010le 3 1 1 16 24 3 10.10.10,p010be 3 1 1 17 24 3 10.10.10,gbrap12be 4 0 0 177 64 3 12.12.12.12,gbrap12le 4 0 0 176 64 3 12.12.12.12,gbrap10be 4 0 0 177 64 3 10.10.10.10,gbrap10le 4 0 0 176 64 3 10.10.10.10,
gray12be 1 0 0 1 16 3 12,gray12le 1 0 0 0 16 3 12,gray10be 1 0 0 1 16 3 10,gray10le 1 0 0 0 16 3 10,p016le 3 1 1 16 24 3 16.16.16,p016be 3 1 1 17 24 3 16.16.16,
gray9be 1 0 0 1 16 3 9,gray9le 1 0 0 0 16 3 9,gbrpf32be 3 0 0 561 96 3 32.32.32,gbrpf32le 3 0 0 560 96 3 32.32.32,gbrapf32be 4 0 0 689 128 3 32.32.32.32,gbrapf32le 4 0 0 688 128 3 32.32.32.32,
gray14be 1 0 0 1 16 3 14,gray14le 1 0 0 0 16 3 14,grayf32be 1 0 0 513 32 3 32,grayf32le 1 0 0 512 32 3 32,yuva422p12be 4 1 0 145 48 3 12.12.12.12,yuva422p12le 4 1 0 144 48 3 12.12.12.12,
yuva444p12be 4 0 0 145 64 3 12.12.12.12,yuva444p12le 4 0 0 144 64 3 12.12.12.12,nv24 3 0 0 16 24 3 8.8.8,nv42 3 0 0 16 24 3 8.8.8,y210be 3 1 0 1 32 0 10.10.10,y210le 3 1 0 0 32 3 10.10.10,
x2rgb10le 3 0 0 32 32 3 10.10.10,x2rgb10be 3 0 0 33 32 0 10.10.10,x2bgr10le 3 0 0 32 32 3 10.10.10,x2bgr10be 3 0 0 33 32 0 10.10.10,p210be 3 1 0 17 32 3 10.10.10,p210le 3 1 0 16 32 3 10.10.10,
p410be 3 0 0 17 48 3 10.10.10,p410le 3 0 0 16 48 3 10.10.10,p216be 3 1 0 17 32 3 16.16.16,p216le 3 1 0 16 32 3 16.16.16,p416be 3 0 0 17 48 3 16.16.16,p416le 3 0 0 16 48 3 16.16.16,
vuya 4 0 0 128 32 3 8.8.8.8,rgbaf16be 4 0 0 673 64 1 16.16.16.16,rgbaf16le 4 0 0 672 64 1 16.16.16.16,vuyx 3 0 0 0 32 3 8.8.8,p012le 3 1 1 16 24 3 12.12.12,p012be 3 1 1 17 24 3 12.12.12,
y212be 3 1 0 1 32 0 12.12.12,y212le 3 1 0 0 32 3 12.12.12,xv30be 3 0 0 5 32 0 10.10.10,xv30le 3 0 0 0 32 3 10.10.10,xv36be 3 0 0 1 64 3 12.12.12,xv36le 3 0 0 0 64 3 12.12.12,
rgbf32be 3 0 0 545 96 1 32.32.32,rgbf32le 3 0 0 544 96 1 32.32.32,rgbaf32be 4 0 0 673 128 0 32.32.32.32,rgbaf32le 4 0 0 672 128 0 32.32.32.32,p212be 3 1 0 17 32 3 12.12.12,p212le 3 1 0 16 32 3 12.12.12,
p412be 3 0 0 17 48 3 12.12.12,p412le 3 0 0 16 48 3 12.12.12,gbrap14be 4 0 0 177 64 3 14.14.14.14,gbrap14le 4 0 0 176 64 3 14.14.14.14,ayuv 4 0 0 128 32 3 8.8.8.8,uyva 4 0 0 128 32 3 8.8.8.8,
vyu444 3 0 0 0 24 3 8.8.8,v30xbe 3 0 0 5 32 0 10.10.10,v30xle 3 0 0 0 32 3 10.10.10,rgbf16be 3 0 0 545 48 1 16.16.16,rgbf16le 3 0 0 544 48 1 16.16.16,rgba128be 4 0 0 161 128 0 32.32.32.32,
rgba128le 4 0 0 160 128 0 32.32.32.32,rgb96be 3 0 0 33 96 0 32.32.32,rgb96le 3 0 0 32 96 0 32.32.32,y216be 3 1 0 1 32 0 16.16.16,y216le 3 1 0 0 32 3 16.16.16,xv48be 3 0 0 1 64 3 16.16.16,
xv48le 3 0 0 0 64 3 16.16.16,gbrpf16be 3 0 0 561 48 1 16.16.16,gbrpf16le 3 0 0 560 48 1 16.16.16,gbrapf16be 4 0 0 689 64 1 16.16.16.16,gbrapf16le 4 0 0 688 64 1 16.16.16.16,grayf16be 1 0 0 513 16 1 16,
grayf16le 1 0 0 512 16 1 16,gray32be 1 0 0 1 32 0 32,gray32le 1 0 0 0 32 0 32,yaf32be 2 0 0 641 64 1 32.32,yaf32le 2 0 0 640 64 1 32.32,yaf16be 2 0 0 641 32 1 16.16,
yaf16le 2 0 0 640 32 1 16.16,gbrap32be 4 0 0 177 128 0 32.32.32.32,gbrap32le 4 0 0 176 128 0 32.32.32.32,yuv444p10msbbe 3 0 0 17 48 3 10.10.10,yuv444p10msble 3 0 0 16 48 3 10.10.10,yuv444p12msbbe 3 0 0 17 48 3 12.12.12,
yuv444p12msble 3 0 0 16 48 3 12.12.12,gbrp10msbbe 3 0 0 49 48 3 10.10.10,gbrp10msble 3 0 0 48 48 3 10.10.10,gbrp12msbbe 3 0 0 49 48 3 12.12.12,gbrp12msble 3 0 0 48 48 3 12.12.12
`;
/** pixdesc.h flags and the FF_COLOR_* classes of get_color_type. */
const PAL=2,RGB=32,ALPHA=128,XYZ=1024,GRAY=0,RGBCOLOR=1,YUV=2,JPEG=3,XYZCOLOR=4,NONE=5;
interface Descriptor {readonly name:string;readonly index:number;readonly components:number;readonly w:number;readonly h:number;readonly bits:number;readonly depths:readonly number[];readonly color:number;readonly alpha:boolean;readonly scale:number}
const table=new Map<string,Descriptor>();
for(const row of rows.split(',')){
 const [name,components,w,h,flags,bits,scale,depths]=row.trim().split(' ') as [string,string,string,string,string,string,string,string],count=Number(components),mask=Number(flags);
 // get_color_type in libavutil/pixdesc.c.
 const color=mask&PAL?RGBCOLOR:count===1||count===2?GRAY:name.startsWith('yuvj')?JPEG:mask&RGB?RGBCOLOR:mask&XYZ?XYZCOLOR:count===0?NONE:YUV;
 table.set(name,Object.freeze({name,index:table.size,components:count,w:Number(w),h:Number(h),bits:Number(bits),depths:Object.freeze(depths.split('.').map(Number)),color,alpha:(mask&ALPHA)!==0,scale:Number(scale)}));
}
/** Every format native lists can name, in AVPixelFormat order; the default list of operators without formats(), sinks and pseudo nodes. */
export const negotiableFormats:readonly string[]=Object.freeze([...table.keys()]);
/** Formats with frame storage and swscale conversion here, in AVPixelFormat order. Any other negotiated format is refused before output. */
export const negotiationOrder=['yuv420p','rgb24','bgr24','yuv422p','yuv444p','gray','nv12','nv21','argb','rgba','abgr','bgra','yuva420p','gbrp'] as const;
/** vf_scale query_formats lists for automatic and explicit scale pads. */
export const scaleInputFormats:readonly string[]=Object.freeze(negotiableFormats.filter(format=>table.get(format)!.scale&1));
export const scaleOutputFormats:readonly string[]=Object.freeze(negotiableFormats.filter(format=>table.get(format)!.scale&2));
const executable:ReadonlySet<string>=new Set(negotiationOrder);
export const negotiableFormat=(format:string)=>table.has(format);
export const executableFormat=(format:string)=>executable.has(format);
const descriptor=(format:string)=>{const value=table.get(format);if(!value)throw new Error('Unsupported video negotiation format');return value;};
/** get_pix_fmt_score; alpha is pick_format's has_alpha, which masks FF_LOSS_ALPHA. */
function score(a:Descriptor,b:Descriptor,alpha:boolean):number {
 if(a===b)return 2147483647;
 const palette=b.name==='pal8',count=palette?Math.min(a.components,4):Math.min(a.components,b.components);let value=2147483646;
 for(let i=0;i<count;i++){const minus=palette?Math.trunc(7/count):b.depths[i]!-1,delta=a.depths[i]!-1-minus;if(delta>0)value-=65536>>minus;else if(delta<0)value+=delta;}
 if(b.w>a.w)value-=256<<b.w;if(b.h>a.h)value-=256<<b.h;
 if(b.w===1&&a.w===0&&b.h===1&&a.h===0)value+=512;
 if(b.w<a.w)value-=1<<(a.w-b.w);if(b.h<a.h)value-=1<<(a.h-b.h);
 if(b.w===1&&a.w===2&&b.h===1&&a.h===2)value+=4;
 const lost=b.color===RGBCOLOR?a.color!==RGBCOLOR&&a.color!==GRAY:b.color===GRAY?a.color!==GRAY:b.color===YUV?a.color!==YUV:b.color===JPEG?a.color!==JPEG&&a.color!==YUV&&a.color!==GRAY:a.color!==b.color;
 if(lost)value-=(count*65536)>>Math.min(b.depths[0]!-1,a.depths[0]!-1);
 if(b.color===GRAY&&a.color!==GRAY)value-=131072;
 if(alpha&&a.alpha&&!b.alpha)value-=65536;
 if(palette&&a.name!=='pal8'&&(a.color!==GRAY||alpha&&a.alpha))value-=65536;
 return value;
}
/** pick_format with a reference link: av_find_best_pix_fmt_of_2 over the list, ties to the earlier AVPixelFormat. */
export function chooseFormat(source:string,values:readonly string[]):string {
 const reference=descriptor(source),alpha=reference.components%2===0;
 let selected=descriptor(values[0]!),best=score(reference,selected,alpha);
 for(const name of values.slice(1)){
  const candidate=descriptor(name),value=score(reference,candidate,alpha);
  if(value>best||value===best&&(candidate.bits<selected.bits||candidate.bits===selected.bits&&(candidate.components<selected.components||candidate.components===selected.components&&candidate.index<selected.index))){selected=candidate;best=value;}
 }
 return selected.name;
}
const siblings:Readonly<Record<string,string>>={yuv420p:'yuvj420p',yuv422p:'yuvj422p',yuv444p:'yuvj444p'};
/** An operator's candidates as native query_formats declares them: with jpegSiblings, the yuvj sibling of each
 * listed yuv420p, yuv422p and yuv444p follows the list. Without formats(), every negotiable format. */
export function declaredFormats(formats:readonly string[]|undefined,jpegSiblings:boolean|undefined,fallback:readonly string[]=negotiableFormats):readonly string[] {
 if(!formats)return fallback;if(!jpegSiblings)return formats;
 const result=[...formats];for(const format of formats){const sibling=siblings[format];if(sibling&&!result.includes(sibling))result.push(sibling);}return result;
}
/** Legacy yuvj420p, yuvj422p and yuvj444p links hold ordinary planar storage with forced full range. */
export const storageFormat=(format:string)=>videoStoragePixelFormat(format);
/** Plan-time refusal of a negotiated format without storage or conversion here; consumer names the pad.
 * A legacy JPEG-range format is executable only when its producer's input is one too: pass-through and
 * yuvj-to-yuvj conversion keep the forced full range, any other conversion into it is not implemented. */
export function requireExecutableFormat(format:string,consumer:string,input?:string):void {
 if(executable.has(format)||input!==undefined&&storageFormat(format)!==format&&storageFormat(input)!==input)return;
 throw new Error(`${consumer} negotiates ${format}, which is not implemented`);
}
export interface FormatGroup {values:string[];parent:FormatGroup}
export function formatGroup(values:readonly string[]):FormatGroup {const result={values:[...values]} as FormatGroup;result.parent=result;return result;}
export function formatRoot(value:FormatGroup):FormatGroup {let result=value;while(result.parent!==result)result=result.parent;while(value.parent!==value){const next=value.parent;value.parent=result;value=next;}return result;}
export function mergeFormats(left:FormatGroup,right:FormatGroup):boolean {
 left=formatRoot(left);right=formatRoot(right);if(left===right)return true;
 const members=new Set(right.values),common=left.values.filter(format=>members.has(format)),alpha=(values:readonly string[])=>values.some(format=>descriptor(format).alpha),color=(values:readonly string[])=>values.some(format=>descriptor(format).components>1);
 // Keep conversion boundaries when intersection would discard chroma or alpha.
 if(!common.length||alpha(left.values)&&alpha(right.values)&&!alpha(common)||color(left.values)&&color(right.values)&&!color(common))return false;
 left.values=common;right.parent=left;return true;
}
