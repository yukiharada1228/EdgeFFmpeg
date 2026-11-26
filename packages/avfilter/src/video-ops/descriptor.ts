// SPDX-License-Identifier: LGPL-2.1-or-later
// Per-operator video filter contract read by every parser, negotiator, planner and executor.
import type {VideoFrameData,Rational,ExpressionNumericProfile} from '@edge-ffmpeg/avutil';
import type {PixelArithmetic} from '@edge-ffmpeg/swscale';
import type {FilterToken,FilterPads} from '../filter-topology.js';
import type {FrameEvent} from '../setpts/stream.js';
import type {createCrop} from '../activation/crop.js';
export class VideoFilterParseError extends Error {}
/** linear: compileVideoFilterChain; graph: compileVideoFilterGraph/compileMultiInputVideoFilterGraph;
 * stream: createReplayVideoExecution; actor: activation actors; timed: avformat createTimedGraphExecution. */
export type VideoExecutionPath='linear'|'graph'|'stream'|'actor'|'timed';
export const videoExecutionPaths:readonly VideoExecutionPath[]=Object.freeze(['linear','graph','stream','actor','timed']);
/** Each path maps a role to one executor branch; a path never infers behaviour from a name. */
export type VideoOperatorRole='identity'|'fanout'|'sink'|'resize'|'frame'|'join'|'retime';
export interface VideoStep {readonly name:string}
/** Role contracts: join steps carry shortest; retime steps carry a setpts expression. */
export interface VideoJoinStep extends VideoStep {readonly shortest:boolean}
/** framesync in[i].after: EXT_STOP ends the output when this input ends; EXT_INFINITY repeats its last frame. */
export type VideoJoinExtension='stop'|'infinity';
/** A join's native clock and synchronization rule: ff_framesync_configure over the filter's config_output and
 * process_frame. Every input has sync=1 and before=EXT_STOP, and the output time base is the av_gcd_q of the input
 * time bases. rate 'common' is vf_stack: the output frame rate is the inputs' shared declared rate, or 1/0 when any
 * differs. rate 'base' is a filter whose config_output sets ol->frame_rate = il->frame_rate: the output frame rate is
 * input 0's. */
export interface VideoJoinRule<S extends VideoStep=VideoStep> {
 readonly rate:'common'|'base';
 /** Output frame properties. 'none' (absent) is an output from ff_get_video_buffer (vf_stack, xmedian, mix): no
  * duration and no decoder time base. 'base' is av_frame_copy_props from input 0's synchronized frame (maskedmerge,
  * threshold, ...): its duration value unrescaled, its interlacing and its decoder time base (-enc_time_base demux).
  * 'base' needs rate 'base'. */
 readonly props?:'none'|'base';
 /** in[i].after per input pad; absent is EXT_STOP on every pad under step.shortest and EXT_INFINITY otherwise.
  * Every path refuses mixed modes at plan time. */
 after?(step:S,inputs:number):readonly VideoJoinExtension[];
}
export interface VideoRetimeStep extends VideoStep {readonly expression:string;readonly stripFps:boolean}
export interface VideoShape {readonly format:string;readonly width:number;readonly height:number;readonly sampleAspectRatio?:Rational}
export interface VideoSize {readonly width:number;readonly height:number}
export interface VideoFrameOptions {readonly maxFrameBytes:number;readonly maxStateBytes?:number;readonly arithmetic?:PixelArithmetic;readonly signal?:AbortSignal}
export interface TimedGeometryContext {readonly input:VideoShape;readonly inputs:readonly VideoShape[];readonly outputFormat:string|null;readonly numericProfile:ExpressionNumericProfile}
export interface TimedGeometry {readonly width:number;readonly height:number;readonly sampleAspectRatio:Rational|undefined;readonly step?:VideoStep}
/** Activation node services for one consumed frame. */
export interface ActorFrameContext {
 readonly event:FrameEvent;readonly maxFrameBytes:number;readonly configured:VideoShape;
 inputGeometry():VideoShape;outputGeometry():VideoShape;
 /** Re-evaluates the node timeline before the callback, as native filter_frame_framed does. */
 enabled(frame:VideoFrameData):boolean;
 /** Crop expression state shared with crop geometry commands. */
 crop():ReturnType<typeof createCrop>;
}
/** Optional members are absent behaviour, never implicit pass-through: registry validation
 * rejects a path flag whose role needs a member the descriptor does not provide. */
export interface VideoOperatorDescriptor<S extends VideoStep=VideoStep,T extends VideoStep=S> {
 readonly name:S['name']|T['name'];
 readonly role:VideoOperatorRole;
 readonly paths:readonly VideoExecutionPath[];
 /** Registry fixtures: filtergraph fragments whose first filter takes the only input and whose last filter
  * gives the only output. tests/unit/video-operator-registry.test.ts runs each one on every flagged path
  * from an 8x8 gray source and expects the explicit rejection on every other path. */
 readonly examples:readonly string[];
 /** Join clock and synchronization rule; absent on a join is {rate:'common'}, the vf_stack rule. */
 readonly join?:VideoJoinRule<S|T>;
 /** Scoped option parser shared by linear chains, frame graphs and replay streams. */
 parse?(token:FilterToken):FilterPads<S>;
 /** Activation option parser; falls back to parse. */
 parseTimed?(token:FilterToken):FilterPads<T>;
 /** Candidate formats shared by every pad, in preference order: a non-empty list of negotiableFormats
  * entries without duplicates, as native query_formats declares them. A negotiated format outside
  * negotiationOrder is refused before output. Absent means every negotiable format. */
 formats?(step:S|T):readonly string[];
 /** formats() leaves out the yuvj420p, yuvj422p and yuvj444p siblings that native lists beside the yuv420p,
  * yuv422p and yuv444p it names; every negotiator adds them back. Absent means formats() is the native list. */
 readonly jpegSiblings?:boolean;
 /** Output size from the negotiated input shapes, on every path. Size-dependent refusals throw here and are repeated in frame. */
 geometry?(step:S|T,inputs:readonly VideoShape[]):VideoSize;
 /** Timed output size and aspect; absent uses geometry and keeps the input aspect. */
 timedGeometry?(step:T,context:TimedGeometryContext):TimedGeometry;
 /** Plan-time validation against the negotiated input format, on every path. */
 validate?(pixelFormat:string,step:S|T):void;
 /** Frame passes unchanged for this configured input size. */
 bypass?(step:S|T,width:number,height:number):boolean;
 frame?(frame:VideoFrameData,step:S|T,options:VideoFrameOptions):VideoFrameData;
 combine?(frames:readonly VideoFrameData[],step:S|T,options:VideoFrameOptions):VideoFrameData;
 /** Extra public fields of a linear VideoFilterStage. */
 stageFields?(step:S):Readonly<Record<string,unknown>>;
 /** Activation per-frame callback; absent uses frame and bypass. */
 actorFrame?(frame:VideoFrameData,step:T,context:ActorFrameContext):VideoFrameData;
 /** Accepts enable= timeline commands. */
 readonly timeline?:boolean;
 /** Answers w/h/x/y geometry commands. */
 readonly geometryCommands?:boolean;
 stripsFrameRate?(step:T):boolean;
 /** Timed plan marks the node as carrying per-frame state. */
 stateful?(step:T):boolean;
}
/** Freezes a descriptor, its path list and its examples; explicit type arguments type every hook. */
export function defineVideoOperator<S extends VideoStep,T extends VideoStep=S>(descriptor:VideoOperatorDescriptor<S,T>):VideoOperatorDescriptor<S,T>{return Object.freeze({...descriptor,paths:Object.freeze([...descriptor.paths]),examples:Object.freeze([...descriptor.examples])});}
export const singlePad=<S>(configuration:S):FilterPads<S>=>({inputs:1,outputs:1,configuration});
