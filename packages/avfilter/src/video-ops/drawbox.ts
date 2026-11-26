// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapted from pinned FFmpeg libavfilter/vf_drawbox.c. See ../../NOTICE-DRAWBOX.
import {drawboxGeometry,drawboxNativeFormats,drawboxPixelFormats,drawboxVideoFrame,parseDrawboxOptions} from '../video-drawbox.js';
import type {VideoDrawboxSettings} from '../video-drawbox.js';
import {VideoFilterParseError,defineVideoOperator,singlePad} from './descriptor.js';
import {executableFormat,negotiableFormats,storageFormat} from './formats.js';
export type DrawboxStep={readonly name:'drawbox'}&VideoDrawboxSettings;
if(!drawboxNativeFormats.every(format=>negotiableFormats.includes(format))||!drawboxPixelFormats.every(format=>executableFormat(storageFormat(format))))throw new Error('Drawbox formats must be negotiable and its kernels executable');
/** box_source, enable= and runtime commands are refused; geometry is config_input on the negotiated format and size. */
export const drawboxOperator=defineVideoOperator<DrawboxStep>({name:'drawbox',role:'frame',paths:['linear','graph','stream','actor','timed'],
 examples:['format=yuv444p,drawbox=1:2:4:3:red:1','format=yuv420p,drawbox=x=-2:y=3:w=6:h=9:c=0x20c040:t=fill,hflip','format=rgba,drawbox=2:2:3:3:blue@0x80:1:1','format=yuva420p,drawbox=x=1:y=1:w=iw-2:h=ih/2:t=2:replace=1:color=0x10e08040','format=rgb24,drawbox=c=invert:t=2'],
 parse(token){try{return singlePad(Object.freeze({name:'drawbox' as const,...parseDrawboxOptions('drawbox',token.options)}));}catch(error){throw new VideoFilterParseError((error as Error).message);}},
 formats:()=>drawboxNativeFormats,
 geometry(step,[input]){if(!input)throw new Error('Drawbox needs one input');drawboxGeometry('drawbox',step,input.format,input.width,input.height);return {width:input.width,height:input.height};},
 validate:pixelFormat=>{if(!drawboxPixelFormats.includes(pixelFormat))throw new Error('drawbox pixel format is not supported');},
 frame:(frame,step,options)=>drawboxVideoFrame('drawbox',frame,step,options)});
