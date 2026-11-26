// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_drawbox.c (drawgrid). See ../../NOTICE-DRAWBOX.
import {drawboxGeometry,drawboxNativeFormats,drawboxPixelFormats,drawboxVideoFrame,parseDrawboxOptions} from '../video-drawbox.js';
import type {VideoDrawboxSettings} from '../video-drawbox.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
export type DrawgridStep={readonly name:'drawgrid'}&VideoDrawboxSettings;
/** drawbox's kernel with pixel_belongs_to_grid over the whole frame; enable= and runtime commands are refused. */
export const drawgridOperator=defineVideoOperator<DrawgridStep>({name:'drawgrid',role:'frame',paths:['linear','graph','stream','actor','timed'],
 examples:['format=yuv444p,drawgrid=1:2:3:3:red:1','format=yuv420p,drawgrid=x=-1:y=5:w=4:h=3:c=0x20c040,vflip','format=bgra,drawgrid=w=3:h=5:t=2:c=0x40ff20@0x80:replace=1','format=yuva420p,drawgrid=2:1:iw/3:ih/2:white@0.5:1:1','format=bgr24,drawgrid=c=invert:w=4:h=4'],
 parse(token){try{return singlePad(Object.freeze({name:'drawgrid' as const,...parseDrawboxOptions('drawgrid',token.options)}));}catch(error){throw new VideoFilterParseError((error as Error).message);}},
 formats:()=>drawboxNativeFormats,
 geometry(step,[input]){if(!input)throw new Error('Drawgrid needs one input');drawboxGeometry('drawgrid',step,input.format,input.width,input.height);return {width:input.width,height:input.height};},
 validate:pixelFormat=>{if(!drawboxPixelFormats.includes(pixelFormat))throw new Error('drawgrid pixel format is not supported');},
 frame:(frame,step,options)=>drawboxVideoFrame('drawgrid',frame,step,options)});
