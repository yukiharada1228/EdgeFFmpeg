import {assertOutputPolicy} from './output-policy.js';
import {bmpEncoderPixelFormat,prepareBmpEncodingFrame} from './bmp-frame.js';
import {ExecutionError,InputReadError} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {parseVideoFrameRate} from '@edge-ffmpeg/avutil';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {parseFrameLimit} from '@edge-ffmpeg/cli';
import {openOutputGroup,OutputGroupError} from './output-group.js';
import {decodeBmp,encodeBmp} from '@edge-ffmpeg/avcodec';
import {openBmpStream} from '@edge-ffmpeg/containers';
const unsupported=(message:string):never=>{throw new ExecutionError('unsupported-command',message);};
const codecOption=(name:string)=>/^-((c|codec)(:v(:0)?|:0)?|vcodec)$/.test(name);
/** BMP image2pipe candidate. No native runtime or external service dependency. */
export function createBmpBackend():ExecutionBackend{return {async execute(command,context){
 if(command.inputs.length!==1||command.outputs.length!==1)unsupported('BMP stream currently requires one input and one output');
 const input=command.inputs[0]!,output=command.outputs[0]!;
 for(const file of [input,output])if(!file.url.startsWith('/')||file.url==='/')unsupported('BMP stream requires absolute virtual paths');
 if(input.url.replace(/\/{2,}/g,'/')===output.url.replace(/\/{2,}/g,'/'))unsupported('BMP input and output paths must differ');
 let overwrite=false,noOverwrite=false;
 for(const option of command.global){if(option.name==='-y')overwrite=true;else if(option.name==='-n')noOverwrite=true;else if(['-xerror','-noxerror'].includes(option.name))continue;else if(option.name!=='-hide_banner'&&!(option.name==='-cpuflags'&&option.value==='0'))unsupported('Unsupported BMP global option: '+option.name);}
 let inputFormat:string|null=null,inputCodec:string|null=null,rate={num:25n,den:1n};
 for(const option of input.options){
  if(option.name==='-f')inputFormat=option.value;
  else if(codecOption(option.name))inputCodec=option.value;
  else if(option.name==='-framerate')rate=parseVideoFrameRate(option.value??'');
  else if(option.name!=='-bitexact')unsupported('Unsupported BMP input option: '+option.name);
 }
 if(inputFormat!=='image2pipe'||inputCodec!=='bmp')unsupported('BMP stream requires declared image2pipe input and BMP decoder');
 let outputFormat:string|null=null,codec:string|null=null,pixel:string|null=null,maxFrames:bigint|null=null,maps=0;
 for(const option of output.options){
  if(option.name==='-f')outputFormat=option.value;
  else if(codecOption(option.name))codec=option.value;
  else if(option.name==='-pix_fmt')pixel=option.value;
  else if(['-frames','-frames:v','-frames:v:0','-frames:0','-vframes'].includes(option.name))maxFrames=parseFrameLimit(option.value??'');
  else if(option.name==='-map'){if(++maps>1)unsupported('Multiple BMP maps are not connected yet');if(!['0','0:0','0:v','0:v:0','0:v:0?'].includes(option.value??''))unsupported('Unsupported BMP map');}
  else if(!['-an','-sn','-dn','-bitexact'].includes(option.name))unsupported('Unsupported BMP output option: '+option.name);
 }
 if(!['rawvideo','image2pipe'].includes(outputFormat??''))unsupported('BMP output requires rawvideo or image2pipe');
 codec??=outputFormat==='rawvideo'?'rawvideo':null;
 if(codec!=='copy'&&codec!=='rawvideo'&&codec!=='bmp')unsupported('Unsupported BMP output codec');
 if(outputFormat==='image2pipe'&&codec==='rawvideo')unsupported('Raw video requires rawvideo muxer');
 if(codec==='copy'&&pixel!==null)unsupported('Pixel conversion is incompatible with BMP stream copy');
 const maxFrameBytes=Math.min(2147483647,context.budget.maxBufferBytes,Math.floor(context.budget.maxResidentBytes/8)),maxPacketBytes=maxFrameBytes;
 const handle=await context.filesystem.openRead(input.url),packets=openBmpStream(handle,{frameRate:rate,maxReadBytes:context.budget.maxBufferBytes,maxPacketBytes,maxFrames:1048576,signal:context.signal}),iterator=packets[Symbol.asyncIterator](),options={maxFrameBytes,maxPacketBytes,signal:context.signal};
 let first:Awaited<ReturnType<typeof iterator.next>>;
 try{await handle.probeRead?.(context.signal);context.signal.throwIfAborted();first=await iterator.next();}
 catch(error){context.signal.throwIfAborted();if(!(error instanceof InputReadError))throw error;throw new ExecutionError('invalid-arguments','Output file does not contain any stream',{exitCode:234});}
 if(first.done)throw new ExecutionError('invalid-arguments','Output file does not contain any stream',{exitCode:234});
 if(command.global.some(option=>['-xerror','-noxerror'].includes(option.name)))unsupported('BMP midstream read error policy is not connected yet');
 // Native decoding probes the first frame even for zero outputs; copy can proceed
 // when decoder probing failed, so it must not require decoded frame metadata.
 const initial=codec==='copy'?null:decodeBmp(first.value,options);
 if(initial&&pixel!==null&&pixel!==initial.pixelFormat)unsupported('BMP pixel conversion is not connected yet');
 await assertOutputPolicy(context,output.url,overwrite,noOverwrite);
 const encoderPixel=initial?bmpEncoderPixelFormat(initial.pixelFormat):null;
 const group=await openOutputGroup(context.filesystem,[output.url],overwrite,context.signal),writer=group.writers[0]!;
 try{
  let next:IteratorResult<MediaPacket>=first,count=0n;
  while(!next.done&&(maxFrames===null||count<maxFrames)){
   context.signal.throwIfAborted();
   const frame=initial===null?null:count===0n?initial:decodeBmp(next.value,options);
   if(frame&&initial&&(frame.width!==initial.width||frame.height!==initial.height||frame.pixelFormat!==initial.pixelFormat))unsupported('Changing BMP stream format is not connected yet');
   const chunks=codec==='copy'?[next.value.data]:codec==='bmp'?[encodeBmp(prepareBmpEncodingFrame(frame!,encoderPixel!,options),options).data]:frame!.planes;
   for(const chunk of chunks)for(let at=0;at<chunk.length;at+=context.budget.maxBufferBytes){context.signal.throwIfAborted();await writer.write(chunk.subarray(at,at+context.budget.maxBufferBytes));context.signal.throwIfAborted();}
   count++;if(maxFrames!==null&&count>=maxFrames)break;next=await iterator.next();
  }
  await writer.commit();await group.commit();return [output.url];
 }catch(error){if(error instanceof OutputGroupError)throw error;try{await group.abort(error);}catch(cleanup){throw new OutputGroupError('BMP output cleanup failed',group.effects(),error,[cleanup]);}throw error;
 }finally{await iterator.return?.();}
}};}
