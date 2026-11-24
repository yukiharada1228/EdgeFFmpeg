// SPDX-License-Identifier: LGPL-2.1-or-later
import {singlePad,defineVideoOperator} from './descriptor.js';
import {bareStep} from './options.js';
export type NullStep={readonly name:'null'};
export const nullOperator=defineVideoOperator<NullStep>({name:'null',role:'identity',paths:['linear','graph','stream','actor','timed'],examples:['null'],
 parse:token=>singlePad(bareStep('null',token))});
