// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped option semantics adapted from pinned FFmpeg avfilter.c and vf_scale.c. See ../../NOTICE and ../../NOTICE-VIDEO-OPS.
import {compileExpression,parseVideoSize} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import {createScaleCommandState,scaleExpressionVariables} from '../activation/scale-command-state.js';
import {scaledSampleAspectRatio} from '../activation/scale-aspect.js';
import type {FilterToken,FilterPads} from '../filter-topology.js';
import {VideoFilterParseError,singlePad,defineVideoOperator} from './descriptor.js';
import {filterBoolean} from './options.js';
export type ScaleStep={readonly name:'scale';readonly width:number|null;readonly height:number|null};
export type TimedScaleStep=ScaleStep&{readonly scaleWidthExpression?:string;readonly scaleHeightExpression?:string;readonly scaleForceOriginalAspectRatio?:0|1|2;readonly scaleForceDivisibleBy?:number;readonly scaleInterpolation?:'bicubic'|'neighbor'|'bilinear'|'area';readonly scaleResetSar?:boolean;readonly scaleEvalMode?:'init'|'frame'};
const dimension=(value:string):number=>{
 const text=value.replace(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/g,'');
 if(!/^\d+$/.test(text)||!Number.isSafeInteger(Number(text))||Number(text)<1||Number(text)>2147483647)throw new VideoFilterParseError('Only positive constant scale dimensions are implemented');return Number(text);
};
function parseScale(token:FilterToken):FilterPads<ScaleStep>{
 let width:string|undefined,height:string|undefined,size:string|undefined,flags:string|undefined;
 for(const option of filterOptions(token.options,['w','h','flags','interl','size'])){
  if(option.key==='w'||option.key==='width')width=option.value;
  else if(option.key==='h'||option.key==='height')height=option.value;
  else if(option.key==='size'||option.key==='s')size=option.value;
  else if(option.key==='flags')flags=option.value;
  else throw new VideoFilterParseError('Unsupported scale option');
 }
 if(flags!==undefined&&flags!==''&&flags!=='bicubic')throw new VideoFilterParseError('Only default bicubic flags are implemented');
 if(size!==undefined&&(width!==undefined||height!==undefined))throw new VideoFilterParseError('Size and scale expressions cannot be combined');
 if(width!==undefined&&height===undefined){size=width;width=undefined;}
 if(size!==undefined){const parsed=parseVideoSize(size);return singlePad(Object.freeze({name:'scale',...parsed}));}
 return singlePad(Object.freeze({name:'scale',width:width===undefined?null:dimension(width),height:height===undefined?null:dimension(height)}));
}
/** Constant sizes keep the scoped parser; eval= and general expressions use the stateful scale planner. */
function parseTimedScale(token:FilterToken):FilterPads<TimedScaleStep>{
 const opts=filterOptions(token.options,['w','h','flags','interl','size']);if(!opts.some(option=>option.key==='eval')){try{return parseScale(token);}catch{/* General expressions use the stateful scale planner below. */}}
 let width:string|undefined,height:string|undefined,size:string|undefined,mode:'init'|'frame'='init',resetSar=false,forceOriginalAspectRatio:0|1|2=0,forceDivisibleBy=1,interpolation:'bicubic'|'neighbor'|'bilinear'|'area'='bicubic';
 for(const option of opts){if(option.key==='w'||option.key==='width')width=option.value;else if(option.key==='h'||option.key==='height')height=option.value;else if(option.key==='size'||option.key==='s')size=option.value;else if(option.key==='flags'){if(option.value==='neighbor'||option.value==='bilinear'||option.value==='area')interpolation=option.value;else if(option.value!==''&&option.value!=='bicubic')throw new Error('Scale flags remain unimplemented');}else if(option.key==='force_original_aspect_ratio'){forceOriginalAspectRatio=filterIntegerOption(option.value,{min:0,max:2,defaultValue:0,constants:{disable:0,decrease:1,increase:2}}) as 0|1|2;}else if(option.key==='force_divisible_by'){forceDivisibleBy=filterIntegerOption(option.value,{min:1,max:256,defaultValue:1});}else if(option.key==='reset_sar')resetSar=filterBoolean(option.value);else if(option.key==='eval'){if(['frame','1'].includes(option.value))mode='frame';else if(['init','0'].includes(option.value))mode='init';else throw new Error('Invalid scale evaluation mode');}else throw new Error('Unsupported frame scale option');}
 if(size!==undefined&&(width!==undefined||height!==undefined))throw new Error('Scale size and expressions conflict');if(width!==undefined&&height===undefined){size=width;width=undefined;}if(size!==undefined){const parsed=parseVideoSize(size);width=String(parsed.width);height=String(parsed.height);}width??='iw';height??='ih';
 for(const expression of [width,height])compileExpression(expression,{numericProfile:'linux-x64',constants:scaleExpressionVariables});
 return {inputs:1,outputs:1,configuration:Object.freeze({name:'scale',width:null,height:null,scaleWidthExpression:width,scaleHeightExpression:height,scaleEvalMode:mode,scaleInterpolation:interpolation,scaleResetSar:resetSar,scaleForceOriginalAspectRatio:forceOriginalAspectRatio,scaleForceDivisibleBy:forceDivisibleBy})};
}
const subsampling=(format:string)=>({hsub:['yuv420p','yuv422p','yuva420p','nv12','nv21'].includes(format)?2:1,vsub:['yuv420p','yuva420p','nv12','nv21'].includes(format)?2:1});
/** Explicit sizes and every automatic converter; output pads negotiate independently of the input. */
export const scaleOperator=defineVideoOperator<ScaleStep,TimedScaleStep>({name:'scale',role:'resize',paths:['linear','graph','stream','actor','timed'],examples:['scale=4:6','scale=size=4x4'],geometryCommands:true,
 parse:parseScale,parseTimed:parseTimedScale,
 geometry:(step,[input])=>({width:step.width??input!.width,height:step.height??input!.height}),
 timedGeometry(step,{input,outputFormat,numericProfile}){
  let width=input.width,height=input.height,aspect=input.sampleAspectRatio;
  if(step.scaleWidthExpression!==undefined){const output=outputFormat!,a=subsampling(input.format),b=subsampling(output),state=createScaleCommandState({inputWidth:width,inputHeight:height,width:step.scaleWidthExpression,height:step.scaleHeightExpression!,...(aspect?{sar:Number(aspect.num)/Number(aspect.den)}:{}),numericProfile,evalMode:step.scaleEvalMode??'init',...(step.scaleForceOriginalAspectRatio===undefined?{}:{forceOriginalAspectRatio:step.scaleForceOriginalAspectRatio}),...(step.scaleForceDivisibleBy===undefined?{}:{forceDivisibleBy:step.scaleForceDivisibleBy}),...(step.scaleResetSar===undefined?{}:{resetSar:step.scaleResetSar}),...a,ohsub:b.hsub,ovsub:b.vsub});try{width=state.snapshot.width;height=state.snapshot.height;}finally{state.dispose();}}
  else{width=step.width??width;height=step.height??height;}
  if(step.scaleResetSar)aspect=Object.freeze({num:1n,den:1n});else if(aspect)aspect=scaledSampleAspectRatio(aspect,input.width,input.height,width,height);
  return {width,height,sampleAspectRatio:aspect};
 },
 stateful:step=>step.scaleEvalMode==='frame'});
