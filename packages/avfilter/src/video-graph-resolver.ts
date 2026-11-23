import {filterOptions} from './video-syntax.js';
import {parseVideoFilterToken} from './video-parse.js';
import type {ParsedVideoStep} from './video-parse.js';
import type {FilterToken,FilterPads} from './filter-topology.js';
export type GraphVideoStep=ParsedVideoStep|{readonly name:'split'|'nullsink'}|{readonly name:'hstack'|'vstack';readonly shortest:boolean};
export function resolveVideoFilter(token:FilterToken):FilterPads<GraphVideoStep>{
 if(token.name==='hstack'||token.name==='vstack'){
  let inputs=2,shortest=false;for(const option of filterOptions(token.options,['inputs','shortest'])){
   if(option.key==='inputs'){const count=Number(option.value);if(!/^\d+$/.test(option.value)||!Number.isInteger(count)||count<2||count>32)throw new Error('Only bounded decimal stack input counts are implemented');inputs=count;}
   else if(option.key==='shortest'&&['0','1','true','false','yes','no','on','off'].includes(option.value))shortest=['1','true','yes','on'].includes(option.value);
   else throw new Error('Unsupported stack option');
  }return {inputs,outputs:1,configuration:Object.freeze({name:token.name,shortest})};
 }
 if(token.name==='split'){
  let outputs=2;for(const option of filterOptions(token.options,['outputs'])){const count=Number(option.value);if(option.key!=='outputs'||!/^\d+$/.test(option.value)||!Number.isInteger(count)||count<1||count>32)throw new Error('Only bounded positive decimal split output counts are implemented');outputs=count;}
  return {inputs:1,outputs,configuration:Object.freeze({name:'split'})};
 }
 if(token.name==='nullsink'){if(filterOptions(token.options,[]).length)throw new Error('Unsupported nullsink option');return {inputs:1,outputs:0,configuration:Object.freeze({name:'nullsink'})};}
 return {inputs:1,outputs:1,configuration:parseVideoFilterToken(token)};
}
