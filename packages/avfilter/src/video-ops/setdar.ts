// SPDX-License-Identifier: LGPL-2.1-or-later
import {evaluateSetAspect} from '../activation/set-aspect.js';
import {reduceAspectRational} from '../activation/scale-aspect.js';
import {defineVideoOperator} from './descriptor.js';
import {aspectFrame,aspectPads} from './aspect-options.js';
import type {AspectStep} from './aspect-options.js';
export const setdarOperator=defineVideoOperator<never,AspectStep<'setdar'>>({name:'setdar',role:'frame',paths:['actor'],examples:['setdar=16/9'],
 parseTimed:token=>aspectPads('setdar',token),
 timedGeometry(step,{input,numericProfile}){const width=input.width,height=input.height;let aspect=evaluateSetAspect(step.expression,step.max,input,numericProfile);const known=aspect.num!==0n;aspect=known?reduceAspectRational(aspect.num*BigInt(height),aspect.den*BigInt(width)):Object.freeze({num:1n,den:1n});return {width,height,sampleAspectRatio:aspect,step:{...step,frameSampleAspectRatio:known?aspect:Object.freeze({num:0n,den:1n})}};},
 actorFrame:aspectFrame});
