// SPDX-License-Identifier: LGPL-2.1-or-later
import {flipVideoFrame} from '../video-flip.js';
import {singlePad,defineVideoOperator} from './descriptor.js';
import {bareStep,timelinePads} from './options.js';
export type VflipStep={readonly name:'vflip'};
export type TimedVflipStep={readonly name:'vflip';readonly enableExpression?:string};
export const vflipOperator=defineVideoOperator<VflipStep,TimedVflipStep>({name:'vflip',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['vflip'],timeline:true,
 parse:token=>singlePad(bareStep('vflip',token)),parseTimed:token=>timelinePads('vflip',token),
 frame:(frame,_step,options)=>flipVideoFrame(frame,'vertical',options),
 actorFrame:(frame,_step,context)=>context.enabled(frame)?flipVideoFrame(frame,'vertical',{maxFrameBytes:context.maxFrameBytes}):frame});
