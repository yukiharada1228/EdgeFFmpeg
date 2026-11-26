// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_edgedetect.c and libavutil/opt.c. See ../../NOTICE-EDGEDETECT.
import {compileExpression} from '@edge-ffmpeg/avutil';
import {filterOptions} from '../video-syntax.js';
import {filterIntegerOption} from '../activation/integer-option.js';
import {edgedetectLayout,edgedetectModes,edgedetectPixelFormats,edgedetectVideoFrame} from '../video-edgedetect.js';
import type {EdgedetectMode,EdgedetectStep} from '../video-edgedetect.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
export type {EdgedetectStep};
/** The vf_edgedetect "flags" unit constants. */
const planeNames:Readonly<Record<string,number>>={y:1,u:2,v:4,r:4,g:1,b:2};
const integer=(value:string)=>/^(?:\d+|0[xX][0-9a-fA-F]+)$/.test(value)?Number(value):NaN;
/** AV_OPT_TYPE_DOUBLE in [0,1]. Only literals, + - * / and parentheses with the default/min/max/none/all constants are
 * implemented: no functions, no other constants and no ^, so the value is IEEE-exact on every platform. */
function threshold(value:string,key:'high'|'low',defaultValue:number):number{
 if(!value||value.length>255||value.replace(/(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|default|min|max|none|all/g,'').replace(/[+\-*/() ]/g,'')!=='')throw new VideoFilterParseError(`Only arithmetic edgedetect ${key} expressions are implemented`);
 let result:number;try{result=compileExpression(value,{numericProfile:'linux-x64',constants:['default','max','min','none','all']})(Float64Array.of(defaultValue,1,0,0,-1));}catch(error){throw new VideoFilterParseError(`Invalid edgedetect ${key}: ${(error as Error).message}`);}
 if(!Number.isFinite(result)||result<0||result>1)throw new VideoFilterParseError(`Edgedetect ${key} is outside [0 - 1]`);
 return result;
}
/** AV_OPT_TYPE_FLAGS with the "flags" unit: +/- folded terms, each a unit constant or a decimal/hex integer. The declared
 * range 1..7 is not enforced natively (write_number skips it for flags); only bits 0..2 select planes. */
function planeFlags(value:string,current:number):number{
 if(value===''||value.length>255)throw new VideoFilterParseError('Only bounded nonempty edgedetect plane flags are implemented');
 let position=0;
 for(;;){
  let command='';if(value[position]==='+'||value[position]==='-')command=value[position++]!;
  let end=position;while(end<value.length&&value[end]!=='+'&&value[end]!=='-')end++;
  const text=value.slice(position,end),term=Object.hasOwn(planeNames,text)?planeNames[text]!:integer(text);
  if(!Number.isSafeInteger(term)||term>0xffffffff)throw new VideoFilterParseError('Only y, u, v, r, g, b and decimal or hexadecimal integer edgedetect plane flags up to 4294967295 are implemented');
  const intnum=current>>>0,d=command==='+'?Number(BigInt(intnum)|BigInt(term)):command==='-'?Number(BigInt(intnum)&~BigInt(term)):term;
  current=d|0;position=end;if(position>=value.length)return current;
 }
}
/** edgedetect_options in declared order (shorthand high:low:mode:planes), then init's low_u8/high_u8. */
export function parseEdgedetectOptions(options:string|null):EdgedetectStep{
 let high=50/255,low=20/255,mode:EdgedetectMode='wires',planes=7;
 for(const option of filterOptions(options,['high','low','mode','planes'])){
  switch(option.key){
   case 'high':high=threshold(option.value,'high',50/255);break;
   case 'low':low=threshold(option.value,'low',20/255);break;
   case 'mode':{let n:number;try{n=filterIntegerOption(option.value,{min:0,max:2,defaultValue:0,constants:{wires:0,colormix:1,canny:2}});}catch(error){throw new VideoFilterParseError('Invalid edgedetect mode: '+(error as Error).message);}mode=edgedetectModes[n]!;break;}
   case 'planes':planes=planeFlags(option.value,planes);break;
   case 'enable':throw new VideoFilterParseError('Edgedetect timeline expressions are not implemented');
   default:throw new VideoFilterParseError('Unsupported edgedetect option');
  }
 }
 // The uint8_t conversion of x*255.+.5 truncates; x is in [0,1].
 return Object.freeze({name:'edgedetect',high,low,highU8:Math.trunc(high*255+0.5),lowU8:Math.trunc(low*255+0.5),mode,planes});
}
export const edgedetectOperator=defineVideoOperator<EdgedetectStep>({name:'edgedetect',role:'frame',paths:['linear','graph','stream','actor','timed'],examples:['edgedetect','edgedetect=mode=canny:high=0.3:low=0.05','edgedetect=0.2:0.1:colormix,hflip','format=yuv420p,edgedetect=mode=canny:planes=y+v'],
 parse:token=>singlePad(parseEdgedetectOptions(token.options)),
 formats:step=>edgedetectPixelFormats[step.mode],
 geometry:(step,[input])=>{edgedetectLayout(input!.format,input!.width,input!.height,step);return {width:input!.width,height:input!.height};},
 frame:(frame,step,options)=>edgedetectVideoFrame(frame,step,options)});
