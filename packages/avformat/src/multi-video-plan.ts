import {videoTimestampFlag,videoTimestampOptions,hasDirectVideoSource} from './video-output/timestamp-options.js';
import {resolveVideoCommandOptions,inputVideoRates} from './video-output/option-order.js';
import {ExecutionError} from '@edge-ffmpeg/core';
import type {ResourceBudget} from '@edge-ffmpeg/core';
import {parseFrameLimit} from '@edge-ffmpeg/cli';
import {pixelLayout,parseVideoSize,parseVideoFrameRate} from '@edge-ffmpeg/avutil';
import type {Rational} from '@edge-ffmpeg/avutil';
import type {PixelArithmetic} from '@edge-ffmpeg/swscale';
import {timeOptions,setVideoTimeOption as setTimeOption,resolveDuration} from './time-range.js';
import {compileMultiInputVideoFilterGraph as compileFrameGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import {parseArgv} from '@edge-ffmpeg/cli';
import {parseVideoOutputOptions} from './video-output/output-options.js';
import type {ParsedCommand} from '@edge-ffmpeg/cli';
const invalid=(message:string):never=>{throw new ExecutionError('invalid-arguments',message);};
const unsupported=(message:string):never=>{throw new ExecutionError('unsupported-command',message);};
function path(value:string):string{if(!value.startsWith('/')||/[\\\0]/.test(value))invalid('Expected an absolute virtual file path');const parts=value.split('/').filter(Boolean);if(!parts.length||parts.some(part=>part==='.'||part==='..'))invalid('Invalid virtual file path');return '/'+parts.join('/');}
/** Declared rawvideo sources bound to external graph pads with named output maps. */
export function planMultiVideo(argv:readonly string[],budget:Readonly<ResourceBudget>,defaultArithmetic:PixelArithmetic='aarch64'){return planMultiCommand(parseArgv(argv),budget,defaultArithmetic);}
export function planMultiCommand(command:ParsedCommand,budget:Readonly<ResourceBudget>,defaultArithmetic:PixelArithmetic='aarch64'){
 command=resolveVideoCommandOptions(command);
 if(Object.values(budget).some(value=>!Number.isSafeInteger(value)||value<=0)||budget.maxBufferBytes>budget.maxResidentBytes)throw new ExecutionError('resource-budget','Invalid complex video budget');if(!command.inputs.length||command.inputs.length>32||!command.outputs.length)unsupported('Complex rawvideo requires one to thirty-two inputs and at least one output');
 let description:string|null=null,overwrite=false,noOverwrite=false,arithmetic=defaultArithmetic;
 for(const option of command.global){if(option.name==='-filter_complex'||option.name==='-lavfi'){if(description!==null)unsupported('Multiple complex graphs are not implemented');description=option.value;}else if(option.name==='-y')overwrite=true;else if(option.name==='-n')noOverwrite=true;else if(['-xerror','-noxerror'].includes(option.name))continue;else if(option.name==='-cpuflags'&&option.value==='0')arithmetic='scalar';else if(option.name!=='-hide_banner'&&!videoTimestampFlag(option.name))unsupported(`Unsupported complex rawvideo global option: ${option.name}`);}
 if(description===null)invalid('Missing complex filter graph');
 const sources=command.inputs.map(input=>{const inputPath=path(input.url),inputTime=timeOptions();let format:string|null=null,pixelFormat='yuv420p',width=0,height=0,frameRate:Rational={num:25n,den:1n};
 for(const option of input.options){if(setTimeOption(inputTime,option.name,option.value))continue;if(option.name==='-f')format=option.value;else if(['-video_size','-s'].includes(option.name))({width,height}=parseVideoSize(option.value??''));else if(['-pixel_format','-pix_fmt'].includes(option.name))pixelFormat=option.value!;else if(option.name==='-framerate')frameRate=parseVideoFrameRate(option.value!);else if(option.name!=='-bitexact'&&!(option.name==='-fflags'&&['bitexact','+bitexact'].includes(option.value??'')))unsupported(`Unsupported complex rawvideo input option: ${option.name}`);}
 if(format!=='rawvideo')unsupported('Complex video input requires declared rawvideo');resolveDuration(inputTime);const source=pixelLayout(pixelFormat,width,height),rates=inputVideoRates(input,frameRate);frameRate=rates.frameRate;return Object.freeze({path:inputPath,copyTs:videoTimestampOptions(command.global).copyTs,demuxFrameRate:rates.demuxFrameRate,forcedFrameRate:rates.forced,time:Object.freeze({...inputTime}),inputSeekSet:input.options.some(option=>option.name==='-ss'),inputTrim:input.options.some(option=>['-ss','-t','-to'].includes(option.name)),parameters:Object.freeze({width,height,pixelFormat:source.pixelFormat,frameRate:Object.freeze({...frameRate})}),geometry:Object.freeze({format:source.pixelFormat,width,height}),frameBytes:source.bytes});});
 const graph=compileFrameGraph(description!),used=new Set<number>(),bindings=graph.graph.inputs.map(pad=>{let index:number;if(pad.label===null){index=sources.findIndex((_,index)=>!used.has(index));if(index<0)invalid('No unused rawvideo input for unlabeled pad');}else{if(!/^(?:0|[1-9][0-9]*)(?::(?:0|v(?::0)?))?$/.test(pad.label))unsupported('Unsupported rawvideo stream binding');index=Number(pad.label.split(':')[0]);if(!Number.isSafeInteger(index)||index>=sources.length)invalid('Input file index out of range');}used.add(index);return index;});

 const bound=new Set<number>(),destinations=new Set<string>();
 const outputs=command.outputs.map(file=>{
  const declaredFormat=file.options.filter(option=>option.name==='-f').at(-1)?.value;if(declaredFormat!=='rawvideo'&&declaredFormat!=='framecrc')unsupported('Unsupported output format');const timing=parseVideoOutputOptions(file.options,declaredFormat as 'rawvideo'|'framecrc',{copyTs:videoTimestampOptions(command.global).copyTs,directVideoSource:hasDirectVideoSource(file)});
  const outputPath=path(file.url);if(sources.some(source=>source.path===outputPath)||destinations.has(outputPath))invalid('Input and output paths must be distinct');destinations.add(outputPath);
  const time=timeOptions();let map:string|null=null,codec='rawvideo',format:string|null=null,pixelFormat:string|null=null,size:{width:number;height:number}|null=null,frames:bigint|null=null,bitexact=false;
  for(const option of timing.remaining){if(setTimeOption(time,option.name,option.value))continue;
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
  return Object.freeze({...timing,path:outputPath,pad,format:format as 'rawvideo'|'framecrc',pixelFormat,size:size?Object.freeze({...size}):null,time:Object.freeze({...time}),frames,bitexact,outputSeekSet:file.options.some(option=>option.name==='-ss')});
 });
 if(bound.size!==graph.graph.outputs.length)invalid('Every external graph output must be mapped');
 const targets=graph.graph.outputs.map((_,pad)=>outputs.find(output=>output.pad===pad)!.pixelFormat),sizes=graph.graph.outputs.map((_,pad)=>outputs.find(output=>output.pad===pad)!.size),ordered=bindings.map(index=>sources[index]!),plan=graph.plan(ordered.map(source=>source.geometry),targets,{arithmetic,inputTrim:ordered.map(source=>source.inputTrim),outputSizes:sizes});
 const encodedBytes=outputs.reduce((sum,output)=>{const geometry=plan.negotiated.sinks[output.pad]!;return sum+BigInt(pixelLayout(geometry.format,geometry.width,geometry.height).bytes);},0n),reserved=4n*encodedBytes+512n*BigInt(outputs.filter(output=>output.format==='framecrc').length);
 if(outputs.length>budget.maxPendingPackets||reserved>=BigInt(budget.maxResidentBytes))throw new ExecutionError('resource-budget','Aggregate output queues exceed budget');
 const replayBudget=Object.freeze({maxFrameBytes:budget.maxBufferBytes,maxStateBytes:budget.maxResidentBytes,maxResidentBytes:budget.maxResidentBytes-Number(reserved),maxSourceTraversals:4096});
 let payload:number,traversals:number;try{const preflight=createReplayVideoExecution(description!,ordered.map(source=>({geometry:source.geometry,timeBase:{num:source.parameters.frameRate.den,den:source.parameters.frameRate.num},readBufferBytes:3*source.frameBytes,async *open(){}})),targets,replayBudget,{arithmetic,inputTrim:ordered.map(source=>source.inputTrim),outputSizes:sizes});payload=preflight.requiredPayloadBytes;traversals=preflight.sourceTraversals;}catch(error){throw new ExecutionError('resource-budget',error instanceof Error?error.message:String(error));}
 return Object.freeze({description:description!,sources:Object.freeze(sources),bindings:Object.freeze(bindings),outputs:Object.freeze(outputs),targets:Object.freeze(targets),sizes:Object.freeze(sizes),graphPlan:plan,arithmetic,replayBudget,sourceTraversals:traversals,overwrite,noOverwrite,requiredPayloadBytes:BigInt(payload)+reserved});
}
