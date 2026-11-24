// SPDX-License-Identifier: LGPL-2.1-or-later
import {evaluateSetAspect} from '../activation/set-aspect.js';
import {defineVideoOperator} from './descriptor.js';
import {aspectFrame,aspectPads} from './aspect-options.js';
import type {AspectStep} from './aspect-options.js';
export const setsarOperator=defineVideoOperator<never,AspectStep<'setsar'>>({name:'setsar',role:'frame',paths:['actor'],examples:['setsar=4/3'],
 parseTimed:token=>aspectPads('setsar',token),
 timedGeometry:(step,{input,numericProfile})=>({width:input.width,height:input.height,sampleAspectRatio:evaluateSetAspect(step.expression,step.max,input,numericProfile)}),
 actorFrame:aspectFrame});
