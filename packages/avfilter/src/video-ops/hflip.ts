// SPDX-License-Identifier: LGPL-2.1-or-later
import {flipVideoFrame} from '../video-flip.js';
import {cropConfiguredFrame} from '../activation/configured-crop.js';
import {singlePad,defineVideoOperator} from './descriptor.js';
import {bareStep,timelinePads} from './options.js';
export type HflipStep={readonly name:'hflip'};
export type TimedHflipStep={readonly name:'hflip';readonly enableExpression?:string};
export const hflipOperator=defineVideoOperator<HflipStep,TimedHflipStep>({name:'hflip',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['hflip'],timeline:true,
 parse:token=>singlePad(bareStep('hflip',token)),parseTimed:token=>timelinePads('hflip',token),
 frame:(frame,_step,options)=>flipVideoFrame(frame,'horizontal',options),
 actorFrame(frame,_step,context){
  if(!context.enabled(frame))return frame;const configured=context.configured,current=context.outputGeometry();
  if(current.width!==configured.width||current.height!==configured.height)throw new Error('Reconfigured hflip output padding remains unverified');
  if(frame.width!==configured.width||frame.height!==configured.height)frame=cropConfiguredFrame(frame,configured.width,configured.height,context.maxFrameBytes);
  return flipVideoFrame(frame,'horizontal',{maxFrameBytes:context.maxFrameBytes});
 }});
