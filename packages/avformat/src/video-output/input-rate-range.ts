// SPDX-License-Identifier: LGPL-2.1-or-later
// Forced decoder cadence follows fftools/ffmpeg_dec.c video_frame_process;
// physical raw demux seeking keeps its independent format-level clock.
import type {Rational} from '@edge-ffmpeg/avutil';
import type {RawVideoTimeRange} from '../video-time-range.js';
import {rawVideoTimeRange} from '../video-time-range.js';
import {resolveDuration} from '../time-range.js';
import type {TimeOptions} from '../time-range.js';
export function decodedRawVideoTimeRange(total:bigint,demuxRate:Rational,decoderRate:Rational,forced:boolean,input:TimeOptions,output:TimeOptions,options:Parameters<typeof rawVideoTimeRange>[4]):RawVideoTimeRange&{readonly initializationStart?:bigint}{
 if(!forced||options.copy)return rawVideoTimeRange(total,demuxRate,input,output,options);
 const physical=rawVideoTimeRange(total,demuxRate,{seek:input.seek,duration:null,stop:null},{seek:0n,duration:null,stop:null},{...options,copy:true,outputSeekSet:false,maxFrames:null}),decoded=rawVideoTimeRange(physical.frames,decoderRate,{seek:options.copyTs?input.seek:0n,duration:resolveDuration(input),stop:null},output,{...options,copy:false,inputSeekSet:false,physicalSeek:false});
 return Object.freeze({...(decoded.frames===0n&&physical.frames>0n?{initializationStart:physical.start}:{}),start:physical.start+decoded.start,frames:decoded.frames,ptsForFrame:decoded.ptsForFrame,durationForFrame:decoded.durationForFrame});
}
