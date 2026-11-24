// SPDX-License-Identifier: LGPL-2.1-or-later
import {negateMasks,negatePixelFormats,negateVideoFrame,parseNegateOptions} from '../video-negate.js';
import {singlePad,defineVideoOperator} from './descriptor.js';
import {negotiationOrder} from './formats.js';
export type NegateStep={readonly name:'negate';readonly components:number;readonly negateAlpha:boolean};
const formats=Object.freeze(negotiationOrder.filter(format=>negatePixelFormats.includes(format)));
/** Timed actor and DAG execution remain unimplemented; their planners reject negate explicitly. */
export const negateOperator=defineVideoOperator<NegateStep>({name:'negate',role:'frame',paths:['linear','graph','stream'],examples:['negate','negate=components=y'],
 parse:token=>singlePad(Object.freeze({name:'negate',...parseNegateOptions(token.options)})),
 formats:()=>formats,validate:(pixelFormat,step)=>{negateMasks(pixelFormat,step);},
 frame:(frame,step,options)=>negateVideoFrame(frame,step,options),
 stageFields:step=>({negate:Object.freeze({components:step.components,negateAlpha:step.negateAlpha})})});
