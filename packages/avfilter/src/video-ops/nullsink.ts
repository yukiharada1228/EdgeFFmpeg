// SPDX-License-Identifier: LGPL-2.1-or-later
import {filterOptions} from '../video-syntax.js';
import {defineVideoOperator} from './descriptor.js';
export type NullsinkStep={readonly name:'nullsink'};
export const nullsinkOperator=defineVideoOperator<NullsinkStep>({name:'nullsink',role:'sink',paths:['graph','stream','actor','timed'],examples:['split[a][b];[a]nullsink;[b]hflip'],
 parse(token){if(filterOptions(token.options,[]).length)throw new Error('Unsupported nullsink option');return {inputs:1,outputs:0,configuration:Object.freeze({name:'nullsink'})};}});
