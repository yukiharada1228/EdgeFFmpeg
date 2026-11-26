// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_stack.c (xstack_options, init, query_formats, config_output). See ../../NOTICE-XSTACK.
import {filterOptions} from '../video-syntax.js';
import {parseXstackLayout,xstackGeometry,xstackVideoFrames} from '../video-xstack.js';
import type {XstackLayout} from '../video-xstack.js';
import type {FilterToken,FilterPads} from '../filter-topology.js';
import {VideoFilterParseError,defineVideoOperator} from './descriptor.js';
import {negotiableFormats} from './formats.js';
export type XstackStep={readonly name:'xstack';readonly inputs:number;readonly layout:XstackLayout;readonly shortest:boolean};
/** ff_formats_pixdesc_filter(0, BITSTREAM|HWACCEL|PAL) without fill, in AVPixelFormat order: every negotiable format except these. */
const rejected=new Set(['monow','monob','pal8','bgr4','rgb4','xv30be','v30xbe']);
export const xstackPixelFormats:readonly string[]=Object.freeze(negotiableFormats.filter(format=>!rejected.has(format)));
const booleans=['0','1','true','false','yes','no','on','off'];
/** xstack_options in declared (shorthand) order: inputs, layout, grid, shortest, fill. Runtime commands and enable= are refused. */
export function parseXstackOptions(options:string|null):XstackStep{
 let inputs=2,layout:string|null=null,grid:readonly [number,number]|null=null,shortest=false;
 for(const option of filterOptions(options,['inputs','layout','grid','shortest','fill'])){
  const {key,value}=option;
  if(key==='inputs'){const count=Number(value);if(!/^\d{1,3}$/.test(value)||count<2||count>32)throw new VideoFilterParseError('Only bounded decimal xstack input counts are implemented');inputs=count;}
  else if(key==='layout')layout=value;
  else if(key==='grid'){const match=/^(\d{1,3})x(\d{1,3})$/.exec(value),columns=Number(match?.[1]),rows=Number(match?.[2]);if(!match||columns<1||rows<1||columns*rows<2||columns*rows>32)throw new VideoFilterParseError('Only decimal CxR xstack grids of two to thirty-two inputs are implemented');grid=[columns,rows];}
  else if(key==='shortest'&&booleans.includes(value))shortest=['1','true','yes','on'].includes(value);
  // Native fills with ff_draw only when the colour parses; any other value would change the format list and the output.
  else if(key==='fill'){if(value!=='none')throw new VideoFilterParseError('Xstack fill colours are not implemented');}
  else if(key==='enable')throw new VideoFilterParseError('Xstack timeline expressions are not implemented');
  else throw new VideoFilterParseError('Unsupported xstack option');
 }
 if(layout!==null&&grid)throw new VideoFilterParseError('Both layout and grid were specified. Only one is allowed');
 if(layout===null&&!grid){if(inputs!==2)throw new VideoFilterParseError('No xstack layout or grid specified');grid=[2,1];}
 let parsed:XstackLayout;
 if(grid){inputs=grid[0]*grid[1];parsed=Object.freeze({kind:'grid',columns:grid[0],rows:grid[1]});}
 else{try{parsed=Object.freeze({kind:'layout',positions:parseXstackLayout(layout!,inputs)});}catch(error){throw new VideoFilterParseError((error as Error).message);}}
 return Object.freeze({name:'xstack',inputs,layout:parsed,shortest});
}
const pads=(token:FilterToken):FilterPads<XstackStep>=>{const configuration=parseXstackOptions(token.options);return {inputs:configuration.inputs,outputs:1,configuration};};
/** vf_stack framesync semantics: every input sync=1, before=EXT_STOP, after=EXT_INFINITY (EXT_STOP under shortest). */
export const xstackOperator=defineVideoOperator<XstackStep>({name:'xstack',role:'join',paths:['graph','stream','actor','timed'],
 examples:['split,xstack','split=4[a][b][c][d];[a]hflip[x];[d]vflip[y];[x][b][c][y]xstack=grid=2x2','split=3[a][b][c];[a][b][c]xstack=inputs=3:layout=0_0|0_h0|0_h0+h1:shortest=1',
  'format=yuv420p,split=3[a][b][c];[a]scale=16:8[w];[w][b][c]xstack=inputs=3:layout=0_0|0_h0|w1_h0','format=rgb24,split=3[a][b][c];[c]vflip[d];[a][b][d]xstack=grid=3x1:shortest=1'],
 parse:pads,formats:()=>xstackPixelFormats,geometry:(step,inputs)=>{const plan=xstackGeometry(inputs,step.layout);return {width:plan.width,height:plan.height};},
 combine:(frames,step,options)=>xstackVideoFrames(frames,step.layout,options),stateful:()=>true});
