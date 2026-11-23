import {videoStoragePixelFormat} from '@edge-ffmpeg/avutil';
// SPDX-License-Identifier: LGPL-2.1-or-later
// Coefficient tables and fixed-point setup adapted from FFmpeg
// libswscale/yuv2rgb.c at 946fcce07b6dcd0331c8cc609192aeff5e1924f8.
// Copyright (C) 2009 Konstantin Shishkov
// Context/table implementation by Michael Niedermayer (michaelni@gmx.at).
// See ../NOTICE and ../LICENSES/LGPL-2.1-or-later.txt.
export interface InverseCoefficients {readonly luma:number;readonly yOffset:number;readonly tableLuma:number;readonly tableBase:number;readonly tableBias:number;readonly vr:number;readonly ub:number;readonly ug:number;readonly vg:number;readonly tableVr:number;readonly tableUb:number;readonly tableUg:number;readonly tableVg:number}
const tables:Readonly<Record<number,readonly number[]>>={0:[104597,132201,25675,53279],1:[117489,138438,13975,34925],2:[104597,132201,25675,53279],4:[104448,132798,24759,53109],5:[104597,132201,25675,53279],6:[104597,132201,25675,53279],7:[117579,136230,16907,35559],9:[110013,140363,12277,42626]};
function coefficientProfiles(fullRange:boolean):Readonly<Record<number,InverseCoefficients>>{return Object.fromEntries(Object.entries(tables).map(([key,values])=>{
 const [r,b,gU,gV]=values as readonly [number,number,number,number],scale=(n:number)=>fullRange?Math.trunc(n*224/255):n,vr=scale(r),ub=scale(b),ug=scale(-gU),vg=scale(-gV),cy=fullRange?65536:76309,q13=(n:number)=>Math.floor((n+4)/8),table=(n:number)=>Math.trunc((n*65536+32768)/cy);
 return [key,Object.freeze({luma:q13(cy),yOffset:fullRange?0:16,tableLuma:cy,tableBase:fullRange?384:326,tableBias:fullRange?-25165824:-26214400,vr:q13(vr),ub:q13(ub),ug:q13(ug),vg:q13(vg),tableVr:table(vr),tableUb:table(ub),tableUg:table(ug),tableVg:table(vg)})];
}));}
const coefficients=coefficientProfiles(false),fullCoefficients=coefficientProfiles(true);
export const defaultInverseCoefficients=coefficients[2]!;
/** Supported eight-bit YUV matrix profiles with Native limited/full range setup. */
export function inverseCoefficients(colorSpace:unknown=2,fullRange=false):InverseCoefficients {
 if(typeof colorSpace!=='number'||!Number.isInteger(colorSpace)||!Object.hasOwn(coefficients,colorSpace))throw new RangeError('Unsupported YUV color matrix');return(fullRange?fullCoefficients:coefficients)[colorSpace]!;
}

/** Preserve unrelated metadata while recording a changed numeric color family. */
export function convertedColorMetadata(metadata:Record<string,unknown>,sourceRgb:boolean,destinationRgb:boolean,destinationGray=false):Record<string,unknown>{
 const result={...metadata};if(sourceRgb!==destinationRgb){if(Object.hasOwn(metadata,'colorSpace'))result.colorSpace=destinationRgb?0:2;if(Object.hasOwn(metadata,'colorRange'))result.colorRange=destinationRgb||destinationGray?2:1;}if(destinationGray&&Object.hasOwn(metadata,'colorRange'))result.colorRange=2;return result;
}

export function frameInverseCoefficients(metadata:Record<string,unknown>):InverseCoefficients {
 if(metadata.colorRange!==undefined&&metadata.colorRange!==0&&metadata.colorRange!==1&&metadata.colorRange!==2)throw new RangeError('Unsupported YUV color range');return inverseCoefficients(metadata.colorSpace,metadata.colorRange===2);
}

export function sourceRangeMetadata(metadata:Record<string,unknown>,format:string):Record<string,unknown>{
 return videoStoragePixelFormat(format)!==format?{...metadata,colorRange:2}:metadata;
}
