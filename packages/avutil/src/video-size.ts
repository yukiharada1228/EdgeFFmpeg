// SPDX-License-Identifier: LGPL-2.1-or-later
// Size aliases and parsing adapted from FFmpeg libavutil/parseutils.c at
// 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../NOTICE.
export class VideoSizeError extends Error {}
const aliases:Readonly<Record<string,readonly [number,number]>>=Object.freeze({
 'ntsc':[720,480],
 'pal':[720,576],
 'qntsc':[352,240],
 'qpal':[352,288],
 'sntsc':[640,480],
 'spal':[768,576],
 'film':[352,240],
 'ntsc-film':[352,240],
 'sqcif':[128,96],
 'qcif':[176,144],
 'cif':[352,288],
 '4cif':[704,576],
 '16cif':[1408,1152],
 'qqvga':[160,120],
 'qvga':[320,240],
 'vga':[640,480],
 'svga':[800,600],
 'xga':[1024,768],
 'uxga':[1600,1200],
 'qxga':[2048,1536],
 'sxga':[1280,1024],
 'qsxga':[2560,2048],
 'hsxga':[5120,4096],
 'wvga':[852,480],
 'wxga':[1366,768],
 'wsxga':[1600,1024],
 'wuxga':[1920,1200],
 'woxga':[2560,1600],
 'wqhd':[2560,1440],
 'wqsxga':[3200,2048],
 'wquxga':[3840,2400],
 'whsxga':[6400,4096],
 'whuxga':[7680,4800],
 'cga':[320,200],
 'ega':[640,350],
 'hd480':[852,480],
 'hd720':[1280,720],
 'hd1080':[1920,1080],
 'quadhd':[2560,1440],
 '2k':[2048,1080],
 '2kdci':[2048,1080],
 '2kflat':[1998,1080],
 '2kscope':[2048,858],
 '4k':[4096,2160],
 '4kdci':[4096,2160],
 '4kflat':[3996,2160],
 '4kscope':[4096,1716],
 'nhd':[640,360],
 'hqvga':[240,160],
 'wqvga':[400,240],
 'fwqvga':[432,240],
 'hvga':[480,320],
 'qhd':[960,540],
 'uhd2160':[3840,2160],
 'uhd4320':[7680,4320],
 });
// The fixed macOS/Linux reference builds use 64-bit long and 32-bit int.
function decimal(text:string):number{
 const negative=text.startsWith('-'),digits=text.replace(/^[+-]/,'').replace(/^0+/, '')||'0',limit=negative?9223372036854775808n:9223372036854775807n;
 let value=digits.length>19?limit:BigInt(digits);if(value>limit)value=limit;
 return Number(BigInt.asIntN(32,negative?-value:value));
}
/** Fixed LP64 reference size syntax; dimensions still require layout/resource preflight. */
export function parseVideoSize(text:string):{width:number;height:number}{
 const named=Object.hasOwn(aliases,text)?aliases[text]:undefined;if(named)return {width:named[0],height:named[1]};
 // strtol skips ASCII whitespace. Native skips exactly one separator byte.
 const first=/^[ \t\r\n\v\f]*([+-]?\d+)/.exec(text);if(!first)throw new VideoSizeError('Invalid video size');
 const rest=text.slice(first[0].length),separator=rest[0];
 if(!separator||separator.charCodeAt(0)>127)throw new VideoSizeError('Invalid video size');
 const second=/^[ \t\r\n\v\f]*([+-]?\d+)(?![\s\S])/.exec(rest.slice(1));if(!second)throw new VideoSizeError('Invalid video size');
 const width=decimal(first[1]!),height=decimal(second[1]!);if(width<=0||height<=0)throw new VideoSizeError('Invalid video size');
 return {width,height};
}
