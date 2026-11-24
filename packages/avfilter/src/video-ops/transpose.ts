// SPDX-License-Identifier: LGPL-2.1-or-later
// Option semantics adapted from pinned FFmpeg vf_transpose.c. See ../../NOTICE and ../../NOTICE-VIDEO-OPS.
import {filterOptions} from '../video-syntax.js';
import {transposeVideoFrame} from '../video-transpose.js';
import {VideoFilterParseError,singlePad,defineVideoOperator} from './descriptor.js';
import {negotiationOrder} from './formats.js';
export type TransposeStep={readonly name:'transpose';readonly direction:number;readonly passthrough:number};
/** Equal chroma subsampling only; yuv422p needs an automatic conversion. */
const formats=Object.freeze(negotiationOrder.filter(format=>format!=='yuv422p'));
const passthrough=(step:TransposeStep,width:number,height:number)=>step.passthrough===1&&width>=height||step.passthrough===2&&width<=height;
export const transposeOperator=defineVideoOperator<TransposeStep>({name:'transpose',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['transpose','scale=4:6,transpose=dir=clock','transpose=passthrough=portrait'],
 parse(token){
  let direction=0,passthrough=0;
  const directions:Record<string,number>={cclock_flip:0,clock:1,cclock:2,clock_flip:3},modes:Record<string,number>={none:0,landscape:1,portrait:2};
  for(const option of filterOptions(token.options,['dir','passthrough'])){
   const names=option.key==='dir'?directions:option.key==='passthrough'?modes:null;
   if(!names)throw new VideoFilterParseError('Unsupported transpose option');
   const value=Object.hasOwn(names,option.value)?names[option.value]!: /^\d+$/.test(option.value)?Number(option.value):NaN;
   if(!Number.isSafeInteger(value)||value<0||value>(option.key==='dir'?7:2147483647))throw new VideoFilterParseError('Only declared transpose constants and nonnegative decimal integers are implemented');
   if(option.key==='dir')direction=value;else passthrough=value;
  }
  if(direction&4){direction&=3;passthrough=1;}
  return singlePad(Object.freeze({name:'transpose',direction,passthrough}));
 },
 formats:()=>formats,jpegSiblings:true,bypass:passthrough,
 geometry:(step,[input])=>passthrough(step,input!.width,input!.height)?{width:input!.width,height:input!.height}:{width:input!.height,height:input!.width},
 timedGeometry(step,{input}){let width=input.width,height=input.height,aspect=input.sampleAspectRatio;if(!passthrough(step,width,height)){[width,height]=[height,width];if(aspect?.num)aspect=Object.freeze({num:aspect.den,den:aspect.num});}return {width,height,sampleAspectRatio:aspect};},
 frame:(frame,step,options)=>transposeVideoFrame(frame,step.direction as 0|1|2|3,options),
 stageFields:step=>({direction:step.direction as 0|1|2|3})});
