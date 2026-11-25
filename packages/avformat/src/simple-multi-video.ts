import type {BackendContext,ReadHandle,VirtualFileSystem} from '@edge-ffmpeg/core';
import type {ParsedCommand} from '@edge-ffmpeg/cli';
import type {PixelArithmetic} from '@edge-ffmpeg/swscale';
import type {ExpressionNumericProfile} from '@edge-ffmpeg/avutil';
import {normalizeSimpleVideoCommand} from './actor-video/simple-command.js';
import {planMultiCommand} from './multi-video-plan.js';
import {executeMultiVideo} from './multi-video.js';
import {probeRawRead} from './raw-read-probe.js';
/** Reuse the bounded replay engine for ordinary raw multi-input/output commands. */
export async function executeSimpleMultiVideo(command:ParsedCommand,context:BackendContext,arithmetic:PixelArithmetic,numericProfile:ExpressionNumericProfile=arithmetic==='x86_64'?'linux-x64':'darwin-arm64'):Promise<readonly string[]>{
 const automatic=command.inputs.length>1&&command.outputs.some(output=>!output.options.some(option=>option.name==='-map'));
 let provisional:ReturnType<typeof planMultiCommand>|undefined,firstError:unknown;
 for(const candidate of [undefined,...(automatic?command.inputs.map((_,index)=>index):[])]){
  try{provisional=planMultiCommand(normalizeSimpleVideoCommand(command,undefined,candidate),context.budget,arithmetic,numericProfile);break;}catch(error){firstError??=error;}
 }
 if(!provisional)throw firstError;
 if(!automatic)return executeMultiVideo(normalizeSimpleVideoCommand(command),context,arithmetic,numericProfile);
 const accepted=new Map<string,ReadHandle[]>(),hasPackets:boolean[]=[];
 for(const source of provisional.sources){
  context.signal.throwIfAborted();const handle=await context.filesystem.openRead(source.path),probe=await probeRawRead(handle,context.signal);
  const handles=accepted.get(source.path)??[];handles.push(handle);accepted.set(source.path,handles);hasPackets.push(probe.input.size>0n);
 }
 const original=context.filesystem,filesystem:VirtualFileSystem={
  async openRead(path){return accepted.get(path)?.shift()??original.openRead(path);},
  openWrite(path,options){return original.openWrite(path,options);},
  ...(original.outputExists?{outputExists(path:string,signal?:AbortSignal,options?:Parameters<NonNullable<VirtualFileSystem['outputExists']>>[2]){return original.outputExists!(path,signal,options);}}:{})
 };
 return executeMultiVideo(normalizeSimpleVideoCommand(command,hasPackets),{...context,filesystem},arithmetic,numericProfile);
}
