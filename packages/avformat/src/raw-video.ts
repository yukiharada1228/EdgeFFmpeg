import {probeRawRead} from './raw-read-probe.js';
import {assertOutputPolicy} from './output-policy.js';
import {videoTimestampFlag,videoTimestampOptions} from './video-output/timestamp-options.js';
import {rescale} from '@edge-ffmpeg/avutil';
import {decodedRawVideoTimeRange} from './video-output/input-rate-range.js';
import {muxTimedRawVideo} from './actor-video/dynamic-video-mux.js';
import {videoPacketDuration} from './video-output/packet-duration.js';
import {resolveVideoCommandOptions,inputVideoRates} from './video-output/option-order.js';
import type {VideoFilterPlan} from '@edge-ffmpeg/avfilter';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
import {canConvertPixelFormat,convertVideoFrame,pixelConversionStateBytes,resizeVideoFrame,pixelResizeStateBytes,canResizePixelFormat,UnstablePixelReferenceError} from '@edge-ffmpeg/swscale';

import {timeOptions,setVideoTimeOption as setTimeOption,resolveDuration} from './time-range.js';
import {ExecutionError} from '@edge-ffmpeg/core';
import type {BackendContext} from '@edge-ffmpeg/core';
import type {ParsedCommand} from '@edge-ffmpeg/cli';
import {parseFrameLimit} from '@edge-ffmpeg/cli';
import {pixelLayout,parseVideoFrameRate,parseVideoSize} from '@edge-ffmpeg/avutil';
import type {PixelArithmetic} from '@edge-ffmpeg/swscale';
import type {MediaPacket,Rational} from '@edge-ffmpeg/avutil';
import {decodeRawVideo,encodeRawVideo} from '@edge-ffmpeg/avcodec';
import {openRawVideo,muxRawVideo,muxRawVideoFrameCrc} from '@edge-ffmpeg/containers';
/** Finite rawvideo CLI path with scoped time/frame selection; component packing conversion is explicit. */
export async function executeRawVideo(command:ParsedCommand,context:BackendContext,pixelArithmetic:PixelArithmetic='aarch64'):Promise<readonly string[]>{
  command=resolveVideoCommandOptions(command);
  const {copyTs}=videoTimestampOptions(command.global);
  const unsupported=(message:string):never=>{throw new ExecutionError('unsupported-command',message);};
  const input=command.inputs[0]!,output=command.outputs[0]!;
  let overwrite=false,noOverwrite=false,exitOnError=false;
  if(command.global.some(option=>option.name==='-cpuflags'&&option.value==='0'))pixelArithmetic='scalar';
  for(const option of command.global){if(option.name==='-xerror'||option.name==='-noxerror')exitOnError=option.name==='-xerror';else if(option.name==='-y')overwrite=true;else if(option.name==='-n')noOverwrite=true;else if(!videoTimestampFlag(option.name)&&option.name!=='-hide_banner'&&!(option.name==='-cpuflags'&&option.value==='0'))unsupported(`Unsupported raw video global option: ${option.name}`);}
  const inputTime=timeOptions(),outputTime=timeOptions();
  let inputFormat:string|null=null,width=0,height=0,pixelFormat='yuv420p',frameRate:Rational={num:25n,den:1n};
  for(const option of input.options){
    if(setTimeOption(inputTime,option.name,option.value))continue;
    if(option.name==='-f')inputFormat=option.value;
    else if(option.name==='-video_size'||option.name==='-s'){
      try{({width,height}=parseVideoSize(option.value??''));}catch{throw new ExecutionError('invalid-arguments','Invalid raw video input size');}
    }else if(option.name==='-pixel_format'||option.name==='-pix_fmt')pixelFormat=option.value!;
    else if(option.name==='-framerate')frameRate=parseVideoFrameRate(option.value!);
    else if(option.name!=='-bitexact'&&!(option.name==='-fflags'&&['bitexact','+bitexact'].includes(option.value??'')))unsupported(`Unsupported raw video input option: ${option.name}`);
  }
  const inputRates=inputVideoRates(input,frameRate),demuxFrameRate=inputRates.demuxFrameRate;frameRate=inputRates.frameRate;
  if(inputFormat!=='rawvideo')unsupported('Only declared rawvideo input is supported');
  let codec='rawvideo',format:string|null=null,maxFrames:bigint|null=null,outputPixel:string|null=null,outputSize:string|null=null,copyOutputRate:Rational|undefined,copyMaxRate:Rational|undefined,bitexact=false,maps=0,filterSpec:string|null=null;
  for(const option of output.options){
    if(setTimeOption(outputTime,option.name,option.value))continue;
    if(['-c','-codec','-c:v','-codec:v','-c:v:0','-codec:v:0','-c:0','-codec:0','-vcodec'].includes(option.name))codec=option.value!;
    else if(option.name==='-f')format=option.value;
    else if(option.name==='-pix_fmt')outputPixel=option.value;
    else if(option.name==='-r')copyOutputRate=parseVideoFrameRate(option.value!);
    else if(option.name==='-fpsmax')copyMaxRate=parseVideoFrameRate(option.value!);
    else if(['-fps_mode','-enc_time_base'].includes(option.name))continue;
    else if(['-vf','-filter','-filter:v','-filter:v:0','-filter:0'].includes(option.name))filterSpec=option.value;
    else if(['-s','-s:v','-s:v:0','-s:0'].includes(option.name))outputSize=option.value;
    else if(['-frames','-frames:v','-frames:v:0','-frames:0','-vframes'].includes(option.name)){try{maxFrames=parseFrameLimit(option.value!);}catch(error){throw new ExecutionError('invalid-arguments',error instanceof Error?error.message:String(error));}}
    else if(option.name==='-bitexact'||option.name==='-fflags'&&['bitexact','+bitexact'].includes(option.value??''))bitexact=true;
    else if(option.name==='-map'){if(++maps>1||!['0','0:0','0:v','0:v:0'].includes(option.value??''))unsupported('Only one raw video stream mapping is supported');}
    else if(!['-an','-sn','-dn'].includes(option.name))unsupported(`Unsupported raw video output option: ${option.name}`);
  }
  resolveDuration(inputTime);resolveDuration(outputTime);
  if(!['rawvideo','copy'].includes(codec))unsupported(`Unsupported raw video codec: ${codec}`);
  if(format!=='rawvideo'&&format!=='framecrc')unsupported('Raw video output requires explicit rawvideo or framecrc format');
  // Native new_stream_video validates rates before the encoder/copy branch.
  if(copyOutputRate&&copyMaxRate)unsupported('Cannot combine output rate and maximum rate');
  if(codec!=='copy'&&output.options.some(option=>['-r','-fpsmax','-fps_mode','-enc_time_base'].includes(option.name)))unsupported('Output synchronization options require the timed video backend');
  // Pixel format, fps_mode and enc_time_base belong to encoding, not streamcopy.
  if(codec==='copy')outputPixel=null;
  const copyFrameRate=copyOutputRate??frameRate,copyTimeBase={num:copyFrameRate.den,den:copyFrameRate.num},rescaleCopy=codec==='copy'&&(inputRates.forced||copyOutputRate!==undefined);
  if(filterSpec!==null&&codec==='copy')unsupported('Video filtering and streamcopy cannot be combined');
  let requestedSize:{width:number;height:number}|undefined;
  // Native streamcopy ignores output -s, including values never parsed as sizes.
  if(outputSize!==null&&codec!=='copy')try{requestedSize=parseVideoSize(outputSize);}catch{throw new ExecutionError('invalid-arguments','Invalid output video size');}
  let filterPlan:VideoFilterPlan|null=null;
  try{filterPlan=filterSpec===null?null:compileVideoFilterChain(filterSpec).plan(pixelFormat,width,height,{inputTrim:input.options.some(option=>['-ss','-t','-to'].includes(option.name)),...(outputPixel!==null?{outputPixelFormat:outputPixel}:{}),...(requestedSize?{outputSize:requestedSize}:{}),arithmetic:pixelArithmetic});}catch(error){unsupported(error instanceof Error?error.message:String(error));}
  const outputWidth=filterPlan?.width??requestedSize?.width??width,outputHeight=filterPlan?.height??requestedSize?.height??height,layout=pixelLayout(pixelFormat,width,height),outputLayout=pixelLayout(filterPlan?.pixelFormat??outputPixel??layout.pixelFormat,outputWidth,outputHeight),conversion=!filterPlan&&outputLayout.pixelFormat!==layout.pixelFormat,resizing=!filterPlan&&(outputWidth!==width||outputHeight!==height);
  if(resizing&&!canResizePixelFormat(layout.pixelFormat,outputLayout.pixelFormat))unsupported('Requested raw video resizing or combined format conversion is not implemented');
  if(conversion&&(codec==='copy'||!canConvertPixelFormat(layout.pixelFormat,outputLayout.pixelFormat)))unsupported('Requested raw video pixel-format conversion is not implemented');
  let stateBytes=0;try{stateBytes=resizing?pixelResizeStateBytes(layout.pixelFormat,filterPlan?.width??width,filterPlan?.height??height,outputWidth,outputHeight,outputLayout.pixelFormat,pixelArithmetic):conversion?pixelConversionStateBytes(layout.pixelFormat,outputLayout.pixelFormat,width,height,pixelArithmetic):0;}catch(error){if(error instanceof UnstablePixelReferenceError)unsupported(error.message);throw error;}
  stateBytes+=filterPlan?.stateBytes??0;
  const slots=codec==='copy'?3n:8n,required=BigInt(stateBytes)+2n*BigInt(filterPlan?.intermediateBytes??0)+(conversion||resizing||filterPlan?4n*BigInt(layout.bytes)+6n*BigInt(outputLayout.bytes):slots*BigInt(layout.bytes))+(format==='framecrc'?512n:0n);
  if((filterPlan?.maxFrameBytes??0)>context.budget.maxBufferBytes||layout.bytes>context.budget.maxBufferBytes||outputLayout.bytes>context.budget.maxBufferBytes||required>BigInt(context.budget.maxResidentBytes))throw new ExecutionError('resource-budget','Raw video frame buffers exceed the configured payload budget');
  context.signal.throwIfAborted();const acceptedSource=await context.filesystem.openRead(input.url),rawProbe=await probeRawRead(acceptedSource,context.signal),source=rawProbe.input,parameters={width,height,pixelFormat:layout.pixelFormat,frameRate};
  const video=await openRawVideo(source,{...parameters,frameRate:demuxFrameRate,maxFrameBytes:context.budget.maxBufferBytes,maxReadBytes:context.budget.maxBufferBytes,signal:context.signal}),range=decodedRawVideoTimeRange(video.info.frameCount,demuxFrameRate,frameRate,inputRates.forced,inputTime,outputTime,{copyTs,frameBytes:video.info.frameBytes,inputSeekSet:input.options.some(option=>option.name==='-ss'),copy:codec==='copy',outputSeekSet:output.options.some(option=>option.name==='-ss'),maxFrames}),frameCount=range.frames;
  await assertOutputPolicy(context,output.url,overwrite,noOverwrite);
  if(rawProbe.failure){if(exitOnError)throw rawProbe.failure;context.reportDiagnostic?.({code:rawProbe.failure.code,message:rawProbe.failure.message});}
  if(range.initializationStart!==undefined)for await(const packet of video.packets(range.initializationStart,1n))decodeRawVideo(packet,parameters,{maxFrameBytes:context.budget.maxBufferBytes,signal:context.signal});
  async function* packets():AsyncIterable<MediaPacket>{
    let emitted=0n;
    for await(const source of video.packets(range.start,frameCount)){
      const pts=range.ptsForFrame(emitted),duration=range.durationForFrame(emitted++),packet={...source,pts,dts:pts,duration,timeBase:codec==='copy'?source.timeBase:{num:frameRate.den,den:frameRate.num}};
      if(codec==='copy'){if(rescaleCopy){const timeBase=copyTimeBase,converted=rescale(pts,source.timeBase,timeBase);yield {...packet,pts:converted,dts:converted,duration:videoPacketDuration(rescale(duration,source.timeBase,timeBase),copyFrameRate,timeBase),timeBase};}else yield packet;}
      else{const options={maxFrameBytes:context.budget.maxBufferBytes,maxStateBytes:stateBytes,outputPixelFormat:outputLayout.pixelFormat,arithmetic:pixelArithmetic,signal:context.signal},decoded=decodeRawVideo(packet,parameters,options),frame=filterPlan?filterPlan.apply(decoded,options):decoded;yield encodeRawVideo(resizing?resizeVideoFrame(frame,outputWidth,outputHeight,options):conversion?convertVideoFrame(frame,outputLayout.pixelFormat,options):frame,frameRate,options);}
    }
  }
  context.signal.throwIfAborted();const destination=await context.filesystem.openWrite(output.url,{overwrite}),options={metadataProfile:'ffmpeg-9.0.2' as const,frameCount,duration:range.durationForFrame,timestamp:range.ptsForFrame,maxWriteBytes:context.budget.maxBufferBytes,bitexact,signal:context.signal};
  const inputOnlyRange=decodedRawVideoTimeRange(video.info.frameCount,demuxFrameRate,frameRate,inputRates.forced,inputTime,{seek:0n,duration:null,stop:null},{copyTs,frameBytes:video.info.frameBytes,inputSeekSet:input.options.some(option=>option.name==='-ss'),copy:codec==='copy',outputSeekSet:false,maxFrames:null}),noDecodedInput=codec!=='copy'&&inputRates.forced&&inputOnlyRange.frames===0n&&inputOnlyRange.initializationStart===undefined;
  const outputParameters={...parameters,...(noDecodedInput?{frameRate:demuxFrameRate}:{}),width:outputWidth,height:outputHeight,pixelFormat:outputLayout.pixelFormat};
  if(rescaleCopy)await muxTimedRawVideo(destination,packets(),{maxPacketBytes:outputLayout.bytes,width:outputWidth,height:outputHeight,pixelFormat:outputLayout.pixelFormat,timeBase:copyTimeBase,framecrc:format==='framecrc',bitexact,maxWriteBytes:context.budget.maxBufferBytes,signal:context.signal});
  else if(format==='framecrc')await muxRawVideoFrameCrc(destination,outputParameters,packets(),options);else await muxRawVideo(destination,outputParameters,packets(),options);
  return [output.url];
}
