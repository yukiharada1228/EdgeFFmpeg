// SPDX-License-Identifier: LGPL-2.1-or-later
// Join clock and synchronization rules adapt pinned libavfilter/framesync.c (ff_framesync_configure),
// vf_stack.c config_output and the framesync filters whose config_output copies input 0's link rate.
// Copyright (c) 2013 Nicolas George and the FFmpeg developers. See ../NOTICE.
import type {Rational,VideoFrameData} from '@edge-ffmpeg/avutil';
import type {VideoOperatorDescriptor,VideoStep,VideoJoinStep,VideoJoinExtension} from './video-ops/descriptor.js';
import type {FrameEvent} from './setpts/stream.js';
/** A resolved join rule. Uniform after modes reduce to shortest: every input EXT_STOP or every input EXT_INFINITY. */
export interface VideoJoinPlan {readonly rate:'common'|'base';readonly props:'none'|'base';readonly shortest:boolean}
/** Resolves the declared rule of one join node at plan time, before any output; mixed after modes are refused. */
export function videoJoinPlan(op:VideoOperatorDescriptor,step:VideoStep,inputs:number):VideoJoinPlan{
 if(op.role!=='join')throw new Error(`Video filter ${op.name} is not a join`);
 if(!Number.isSafeInteger(inputs)||inputs<1)throw new Error(`Invalid join input count for video filter ${op.name}`);
 const rule=op.join??{rate:'common' as const},props=rule.props??'none',after=rule.after?rule.after(step,inputs):Array.from({length:inputs},():VideoJoinExtension=>(step as VideoJoinStep).shortest?'stop':'infinity');
 if(rule.rate!=='common'&&rule.rate!=='base'||props!=='none'&&props!=='base'||props==='base'&&rule.rate!=='base'||!Array.isArray(after)||after.length!==inputs||after.some(mode=>mode!=='stop'&&mode!=='infinity'))throw new Error(`Invalid join rule for video filter ${op.name}`);
 if(after.some(mode=>mode!==after[0]))throw new Error(`Video filter ${op.name} mixes EXT_STOP and EXT_INFINITY across its inputs, which is not implemented`);
 return Object.freeze({rate:rule.rate,props,shortest:after[0]==='stop'});
}
/** Output link frame rate. 'base' copies input 0's declared fields; 'common' compares raw fields, as vf_stack does,
 * because reducing equivalent rates would change native negotiation. */
export function videoJoinFrameRate(rate:VideoJoinPlan['rate'],rates:readonly Rational[]):Readonly<Rational>{
 const first=rates[0];if(!first)throw new Error('Join requires inputs');
 return Object.freeze(rate==='base'||rates.every(q=>q.num===first.num&&q.den===first.den)?{num:first.num,den:first.den}:{num:1n,den:0n});
}
/** Output frame event. props 'base' keeps input 0's duration value unrescaled and its interlacing, as
 * av_frame_copy_props does; 'none' outputs come from ff_get_video_buffer and carry no duration. */
export function videoJoinEvent(props:VideoJoinPlan['props'],base:FrameEvent,frame:VideoFrameData):FrameEvent{
 return props==='base'?Object.freeze({kind:'frame' as const,frame,duration:base.duration,...(base.interlaced===undefined?{}:{interlaced:base.interlaced})}):Object.freeze({kind:'frame' as const,frame,duration:0n});
}
