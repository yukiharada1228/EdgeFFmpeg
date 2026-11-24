// SPDX-License-Identifier: LGPL-2.1-or-later
// Option semantics adapted from pinned FFmpeg vf_crop.c. See ../../NOTICE and ../../NOTICE-VIDEO-OPS.
import {compileExpression} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {createCrop,cropVariables} from '../activation/crop.js';
import {filterBoolean} from './options.js';
import {defineVideoOperator} from './descriptor.js';
export type CropStep={readonly name:'crop';readonly cropWidth:string;readonly cropHeight:string;readonly cropX:string;readonly cropY:string;readonly cropExact:boolean;readonly cropKeepAspect:boolean};
/** Expression state lives in the activation runtime so w/h/x/y commands and frames share it. */
export const cropOperator=defineVideoOperator<never,CropStep>({name:'crop',role:'frame',paths:['actor'],examples:['crop=4:2','crop=w=iw/2:x=1'],geometryCommands:true,
 parseTimed(token){let width='iw',height='ih',x='(iw-ow)/2',y='(ih-oh)/2',exact=false,keepAspect=false;for(const option of filterOptions(token.options,['out_w','out_h','x','y','keep_aspect','exact'])){if(option.key==='out_w'||option.key==='w')width=option.value;else if(option.key==='out_h'||option.key==='h')height=option.value;else if(option.key==='x')x=option.value;else if(option.key==='y')y=option.value;else if(option.key==='exact')exact=filterBoolean(option.value);else if(option.key==='keep_aspect')keepAspect=filterBoolean(option.value);else throw new Error('Unsupported crop option');}for(const expression of [width,height,x,y])compileExpression(expression,{numericProfile:'linux-x64',constants:cropVariables});return {inputs:1,outputs:1,configuration:Object.freeze({name:'crop',cropWidth:width,cropHeight:height,cropX:x,cropY:y,cropExact:exact,cropKeepAspect:keepAspect})};},
 timedGeometry(step,{input,numericProfile}){const aspect=input.sampleAspectRatio,state=createCrop({width:input.width,height:input.height,format:input.format,outWidth:step.cropWidth,outHeight:step.cropHeight,x:step.cropX,y:step.cropY,exact:step.cropExact,keepAspect:step.cropKeepAspect,...(aspect?{sampleAspectRatio:aspect}:{}),numericProfile,timeBase:{num:1n,den:25n},maxFrameBytes:2147483647});try{const geometry=state.geometry;return {width:geometry.width,height:geometry.height,sampleAspectRatio:geometry.sampleAspectRatio};}finally{state.dispose();}},
 actorFrame(_frame,_step,context){const crop=context.crop(),geometry=context.inputGeometry();crop.synchronizeInput(geometry.width,geometry.height);return crop.process(context.event).frame;},
 stateful:()=>true});
