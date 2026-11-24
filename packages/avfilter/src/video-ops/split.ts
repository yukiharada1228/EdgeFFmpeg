// SPDX-License-Identifier: LGPL-2.1-or-later
import {filterOptions} from '../video-syntax.js';
import {defineVideoOperator} from './descriptor.js';
export type SplitStep={readonly name:'split'};
export const splitOperator=defineVideoOperator<SplitStep>({name:'split',role:'fanout',paths:['graph','stream','actor','timed'],examples:['split[a][b];[a]nullsink;[b]null','split=3[a][b][c];[a][b]hstack[d];[c]nullsink;[d]null'],
 parse(token){
  let outputs=2;for(const option of filterOptions(token.options,['outputs'])){const count=Number(option.value);if(option.key!=='outputs'||!/^\d+$/.test(option.value)||!Number.isInteger(count)||count<1||count>32)throw new Error('Only bounded positive decimal split output counts are implemented');outputs=count;}
  return {inputs:1,outputs,configuration:Object.freeze({name:'split'})};
 }});
