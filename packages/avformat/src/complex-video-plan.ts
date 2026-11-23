import {videoTimestampFlag} from './video-output/timestamp-options.js';
import {resolveVideoCommandOptions} from './video-output/option-order.js';
import {ExecutionError} from '@edge-ffmpeg/core';
import type {ResourceBudget} from '@edge-ffmpeg/core';
import {parseFrameLimit} from '@edge-ffmpeg/cli';
import {pixelLayout,parseVideoSize,parseVideoFrameRate} from '@edge-ffmpeg/avutil';
import type {Rational} from '@edge-ffmpeg/avutil';
import type {PixelArithmetic} from '@edge-ffmpeg/swscale';
import {timeOptions,setVideoTimeOption as setTimeOption,resolveDuration} from './time-range.js';
import {compileVideoFilterGraph as compileFrameGraph} from '@edge-ffmpeg/avfilter';
import {parseArgv} from '@edge-ffmpeg/cli';
import type {ParsedCommand} from '@edge-ffmpeg/cli';
const invalid=(message:string):never=>{throw new ExecutionError('invalid-arguments',message);};
const unsupported=(message:string):never=>{throw new ExecutionError('unsupported-command',message);};
function path(value:string):string{if(!value.startsWith('/')||/[\\\0]/.test(value))invalid('Expected an absolute virtual file path');const parts=value.split('/').filter(Boolean);if(!parts.length||parts.some(part=>part==='.'||part==='..'))invalid('Invalid virtual file path');return '/'+parts.join('/');}
/** One declared rawvideo source and named, explicitly mapped graph outputs. */
export function planComplexVideo(argv:readonly string[],budget:Readonly<ResourceBudget>,defaultArithmetic:PixelArithmetic='aarch64'){return planComplexCommand(parseArgv(argv),budget,defaultArithmetic);}
export function planComplexCommand(command:ParsedCommand,budget:Readonly<ResourceBudget>,defaultArithmetic:PixelArithmetic='aarch64'){
 command=resolveVideoCommandOptions(command);
 if(Object.values(budget).some(value=>!Number.isSafeInteger(value)||value<=0)||budget.maxBufferBytes>budget.maxResidentBytes)throw new ExecutionError('resource-budget','Invalid complex video budget');if(command.inputs.length!==1||!command.outputs.length)unsupported('Complex rawvideo currently requires one input and at least one output');
 let description:string|null=null,overwrite=false,noOverwrite=false,arithmetic=defaultArithmetic;
 for(const option of command.global){if(option.name==='-filter_complex'||option.name==='-lavfi'){if(description!==null)unsupported('Multiple complex graphs are not implemented');description=option.value;}else if(option.name==='-y')overwrite=true;else if(option.name==='-n')noOverwrite=true;else if(['-xerror','-noxerror'].includes(option.name))continue;else if(option.name==='-cpuflags'&&option.value==='0')arithmetic='scalar';else if(option.name!=='-hide_banner'&&!videoTimestampFlag(option.name))unsupported(`Unsupported complex rawvideo global option: ${option.name}`);}
 if(description===null)invalid('Missing complex filter graph');
 const input=command.inputs[0]!,inputPath=path(input.url),inputTime=timeOptions();let format:string|null=null,pixelFormat='yuv420p',width=0,height=0,frameRate:Rational={num:25n,den:1n};
 for(const option of input.options){if(setTimeOption(inputTime,option.name,option.value))continue;if(option.name==='-f')format=option.value;else if(['-video_size','-s'].includes(option.name))({width,height}=parseVideoSize(option.value??''));else if(['-pixel_format','-pix_fmt'].includes(option.name))pixelFormat=option.value!;else if(option.name==='-framerate')frameRate=parseVideoFrameRate(option.value!);else if(option.name!=='-bitexact'&&!(option.name==='-fflags'&&['bitexact','+bitexact'].includes(option.value??'')))unsupported(`Unsupported complex rawvideo input option: ${option.name}`);}
 if(format!=='rawvideo')unsupported('Complex video input requires declared rawvideo');resolveDuration(inputTime);const source=pixelLayout(pixelFormat,width,height),graph=compileFrameGraph(description!);
 if(graph.graph.inputs.length!==1||graph.graph.inputs[0]!.label!==null&&!['0','0:0','0:v','0:v:0'].includes(graph.graph.inputs[0]!.label!))unsupported('Unsupported complex input stream binding');
 const bound=new Set<number>(),destinations=new Set<string>();
 const outputs=command.outputs.map(file=>{
  const outputPath=path(file.url);if(outputPath===inputPath||destinations.has(outputPath))invalid('Input and output paths must be distinct');destinations.add(outputPath);
  const time=timeOptions();let map:string|null=null,codec='rawvideo',format:string|null=null,pixelFormat:string|null=null,size:{width:number;height:number}|null=null,frames:bigint|null=null,bitexact=false;
  for(const option of file.options){if(setTimeOption(time,option.name,option.value))continue;
   if(option.name==='-map'){if(map!==null)unsupported('One mapped video stream per output is implemented');map=option.value;}
   else if(['-c','-codec','-c:v','-codec:v','-c:v:0','-codec:v:0','-c:0','-codec:0','-vcodec'].includes(option.name))codec=option.value!;
   else if(option.name==='-f')format=option.value;else if(option.name==='-pix_fmt')pixelFormat=option.value;
   else if(['-s','-s:v','-s:v:0','-s:0'].includes(option.name))size=parseVideoSize(option.value??'');
   else if(['-frames','-frames:v','-frames:v:0','-frames:0','-vframes'].includes(option.name))frames=parseFrameLimit(option.value!);
   else if(option.name==='-bitexact'||option.name==='-fflags'&&['bitexact','+bitexact'].includes(option.value??''))bitexact=true;
   else if(!['-an','-sn','-dn'].includes(option.name))unsupported(`Unsupported complex rawvideo output option: ${option.name}`);
  }
  if(codec!=='rawvideo')unsupported('Complex video output requires rawvideo encoding');if(format!=='rawvideo'&&format!=='framecrc')unsupported('Complex video output requires rawvideo or framecrc muxing');
  if(map===null||!/^\[[^\0\]]+\]$/.test(map))unsupported('A named complex output map is required');const label=map!.slice(1,-1),pad=graph.graph.outputs.findIndex((output,index)=>output.label===label&&!bound.has(index));if(pad<0)invalid('Complex output label is absent or already bound');bound.add(pad);resolveDuration(time);
  return Object.freeze({path:outputPath,pad,format:format as 'rawvideo'|'framecrc',pixelFormat,size:size?Object.freeze({...size}):null,time:Object.freeze({...time}),frames,bitexact,outputSeekSet:file.options.some(option=>option.name==='-ss')});
 });
 if(bound.size!==graph.graph.outputs.length)invalid('Every external graph output must be mapped');
 const targets=graph.graph.outputs.map((_,pad)=>outputs.find(output=>output.pad===pad)!.pixelFormat),sizes=graph.graph.outputs.map((_,pad)=>outputs.find(output=>output.pad===pad)!.size),inputTrim=input.options.some(option=>['-ss','-t','-to'].includes(option.name)),plan=graph.plan({format:source.pixelFormat,width,height},targets,{arithmetic,inputTrim,outputSizes:sizes});
 const encodedBytes=outputs.reduce((sum,output)=>{const geometry=plan.negotiated.sinks[output.pad]!;return sum+BigInt(pixelLayout(geometry.format,geometry.width,geometry.height).bytes);},0n),required=BigInt(plan.requiredPayloadBytes)+3n*BigInt(source.bytes)+4n*encodedBytes+512n*BigInt(outputs.filter(output=>output.format==='framecrc').length);
 if(outputs.length>budget.maxPendingPackets||plan.maxFrameBytes>budget.maxBufferBytes||plan.stateBytes>budget.maxResidentBytes||required>BigInt(budget.maxResidentBytes))throw new ExecutionError('resource-budget','Complex video graph buffers or aggregate output queues exceed budget');
 return Object.freeze({inputPath,inputTime:Object.freeze({...inputTime}),inputSeekSet:input.options.some(option=>option.name==='-ss'),parameters:Object.freeze({width,height,pixelFormat:source.pixelFormat,frameRate:Object.freeze({...frameRate})}),outputs:Object.freeze(outputs),graphPlan:plan,overwrite,noOverwrite,requiredPayloadBytes:required});
}
