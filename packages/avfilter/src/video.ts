import {parseVideoGraph} from './video-graph.js';
import type {GraphVideoStep} from './video-graph.js';
import type {VideoNegateSettings} from './video-negate.js';
import {negotiateVideoFormats} from './video-format-negotiation.js';
import {requireVideoPath,videoOperator} from './video-ops/registry.js';
import type {VideoOperatorName} from './video-ops/registry.js';
import {pixelLayout,videoStoragePixelFormat} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {canResizePixelFormat,pixelResizeStateBytes,resizeVideoFrame} from '@edge-ffmpeg/swscale';
import type {PixelResizeOptions,PixelArithmetic} from '@edge-ffmpeg/swscale';
export class VideoFilterError extends Error {}
export type VideoFilterStep=GraphVideoStep;
export interface VideoFilterNegotiation {readonly inputTrim?:boolean;readonly outputPixelFormat?:string;readonly outputSize?:{readonly width:number;readonly height:number};readonly arithmetic?:PixelArithmetic}
/** operation names a frame operator stage; resize stages omit it. */
export interface VideoFilterStage {readonly operation?:VideoOperatorName;readonly direction?:0|1|2|3;readonly negate?:VideoNegateSettings;readonly inputPixelFormat:string;readonly inputWidth:number;readonly inputHeight:number;readonly pixelFormat:string;readonly width:number;readonly height:number;readonly stateBytes:number}
export interface VideoFilterPlan {
 readonly pixelFormat:string;readonly arithmetic:PixelArithmetic;readonly stages:readonly VideoFilterStage[];
 readonly width:number;readonly height:number;readonly stateBytes:number;readonly intermediateBytes:number;readonly maxFrameBytes:number;
 apply(frame:VideoFrameData,options:PixelResizeOptions):VideoFrameData;
}
/** Bounded single-path video graph with labels and positive constant dimensions. */
export function compileVideoFilterChain(description:string):{readonly steps:readonly VideoFilterStep[];plan(pixelFormat:string,width:number,height:number,negotiation?:VideoFilterNegotiation):VideoFilterPlan}{
 let steps:readonly VideoFilterStep[],registrationOrder:readonly number[];
 try{({steps,registrationOrder}=parseVideoGraph(description));}catch(error){throw new VideoFilterError(error instanceof Error?error.message:'Invalid video filter syntax');}
 for(const step of steps)requireVideoPath(step.name,'linear',name=>new VideoFilterError(`Video filter ${name} is not implemented for linear chains`));
 return Object.freeze({steps:Object.freeze(steps),plan(pixelFormat:string,width:number,height:number,negotiation:VideoFilterNegotiation={}):VideoFilterPlan{
  const sourceWidth=width,sourceHeight=height,legacyRange=videoStoragePixelFormat(pixelFormat)!==pixelFormat,source=pixelLayout(videoStoragePixelFormat(pixelFormat),width,height),arithmetic=negotiation.arithmetic??'aarch64';
  if(!['aarch64','scalar','x86_64'].includes(arithmetic))throw new VideoFilterError('Invalid graph arithmetic profile');
  pixelFormat=source.pixelFormat;const stages:VideoFilterStage[]=[],runners:((frame:VideoFrameData,options:PixelResizeOptions)=>VideoFrameData)[]=[];let state=0n,intermediate=0n,maxFrameBytes=source.bytes;
  // A frame operator stage keeps its step; a stage without one is a resize.
  const stage=(nextWidth:number,nextHeight:number,nextFormat:string,step?:VideoFilterStep)=>{
   const op=step&&videoOperator(step.name)!,operation=step?.name;
   const layout=pixelLayout(nextFormat,nextWidth,nextHeight);if(!operation&&width===nextWidth&&height===nextHeight&&pixelFormat===layout.pixelFormat)return;
   if(op&&!op.geometry&&(width!==nextWidth||height!==nextHeight||pixelFormat!==layout.pixelFormat))throw new VideoFilterError('Flip must preserve geometry and pixel format');
   if(!canResizePixelFormat(pixelFormat,layout.pixelFormat))throw new VideoFilterError('Scale pixel format is not implemented');
   if(op?.validate)try{op.validate(layout.pixelFormat,step!);}catch(error){throw new VideoFilterError(error instanceof Error?error.message:`Invalid ${operation} configuration`);}
   const bytes=operation?0:pixelResizeStateBytes(pixelFormat,width,height,nextWidth,nextHeight,layout.pixelFormat,arithmetic);
   const configured:VideoFilterStage=Object.freeze({...(operation?{operation}:{}),...op?.stageFields?.(step!),inputPixelFormat:pixelFormat,inputWidth:width,inputHeight:height,pixelFormat:layout.pixelFormat,width:nextWidth,height:nextHeight,stateBytes:bytes});
   stages.push(configured);runners.push(op?(frame,options)=>op.frame!(frame,step!,options):(frame,options)=>resizeVideoFrame(frame,configured.width,configured.height,{...options,outputPixelFormat:configured.pixelFormat,arithmetic}));state+=BigInt(bytes);intermediate+=BigInt(layout.bytes);maxFrameBytes=Math.max(maxFrameBytes,layout.bytes);width=nextWidth;height=nextHeight;pixelFormat=layout.pixelFormat;
  };
  const negotiatedSteps:import('./video-format-negotiation.js').NegotiationStep[]=[...(negotiation.inputTrim?[{name:'null'} as const]:[]),...steps];const offset=negotiation.inputTrim?1:0;
  if(negotiation.outputSize)negotiatedSteps.push({name:'scale',width:negotiation.outputSize.width,height:negotiation.outputSize.height});
  const target=negotiation.outputPixelFormat===undefined?undefined:pixelLayout(negotiation.outputPixelFormat,1,1).pixelFormat;
  let operations:ReturnType<typeof negotiateVideoFormats>;
  try{operations=negotiateVideoFormats(source.pixelFormat,negotiatedSteps,target,[...registrationOrder.map(index=>index+offset),...(negotiation.inputTrim?[0]:[]),...(negotiation.outputSize?[steps.length+offset]:[])]);}catch(error){throw new VideoFilterError(error instanceof Error?error.message:'Video format negotiation failed');}
  for(const next of operations){
   const op=videoOperator(next.step.name)!;if(op.bypass?.(next.step,width,height))continue;
   let size={width,height};if(op.geometry)try{size=op.geometry(next.step,[{format:pixelFormat,width,height}]);}catch(error){throw new VideoFilterError(error instanceof Error?error.message:`Invalid ${next.step.name} geometry`);}
   stage(size.width,size.height,next.pixelFormat,next.operation===undefined?undefined:next.step);
  }
  if(state>BigInt(Number.MAX_SAFE_INTEGER)||intermediate>BigInt(Number.MAX_SAFE_INTEGER))throw new VideoFilterError('Video graph payload exceeds safe size');
  const configuredStages=Object.freeze(stages),outputWidth=width,outputHeight=height,outputPixelFormat=pixelFormat;
  return Object.freeze({width,height,pixelFormat,arithmetic,stages:configuredStages,stateBytes:Number(state),intermediateBytes:Number(intermediate),maxFrameBytes,apply(frame:VideoFrameData,options:PixelResizeOptions){
   options.signal?.throwIfAborted();if(options.outputPixelFormat&&pixelLayout(options.outputPixelFormat,outputWidth,outputHeight).pixelFormat!==outputPixelFormat)throw new VideoFilterError('Graph output format must match its negotiated format');
   if(options.arithmetic!==undefined&&options.arithmetic!==arithmetic)throw new VideoFilterError('Graph arithmetic profile must match its negotiated profile');
   if(frame.width!==sourceWidth||frame.height!==sourceHeight||pixelLayout(videoStoragePixelFormat(frame.pixelFormat),frame.width,frame.height).pixelFormat!==source.pixelFormat)throw new VideoFilterError('Video frame does not match configured graph input');
   const maxStateBytes=options.maxStateBytes??options.maxFrameBytes;
   if(!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<1||!Number.isSafeInteger(maxStateBytes)||maxStateBytes<0||options.maxFrameBytes<maxFrameBytes||maxStateBytes<Number(state))throw new VideoFilterError('Video graph exceeds frame or state budget');
   let current=frame;if(frame.pixelFormat!==source.pixelFormat||legacyRange)current={...frame,pixelFormat:source.pixelFormat,metadata:{...frame.metadata,...((legacyRange||videoStoragePixelFormat(frame.pixelFormat)!==frame.pixelFormat)?{colorRange:2}:{})}};for(const run of runners)current=run(current,options);return current;
  }});
 }});
}
