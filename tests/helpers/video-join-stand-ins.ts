// Test-only framesync joins registered exactly as a new join operator is (one descriptor each, through the registry
// module), so the declared join rule runs end to end before the native filters that need it land. Each stand-in
// passes one input's synchronized frame through; the native graph it is compared with produces exactly that input's
// pixels (a zero maskedmerge mask, a 255 threshold plane, mix weights 1 0), so the comparison isolates the clock.
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {defineVideoOperator} from '../../packages/avfilter/src/video-ops/descriptor.js';
import type {VideoJoinRule,VideoJoinStep,VideoOperatorDescriptor,VideoShape} from '../../packages/avfilter/src/video-ops/descriptor.js';
import type * as Registry from '../../packages/avfilter/src/video-ops/registry.js';
/** Owned tight copy of frames[source] with the synchronized timestamp and input 0's metadata, as av_frame_copy_props. */
function passThrough(frames:readonly VideoFrameData[],source:number):VideoFrameData{
 const picked=frames[source]!,base=frames[0]!,layout=pixelLayout(picked.pixelFormat,picked.width,picked.height),data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries())for(let y=0;y<plane.height;y++){const from=y*picked.linesizes[index]!;data.set(picked.planes[index]!.subarray(from,from+plane.rowBytes),plane.offset+y*plane.rowBytes);}
 return {width:picked.width,height:picked.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:base.pts===null?null:{value:base.pts.value,timeBase:{...base.pts.timeBase}},metadata:{...base.metadata}};
}
const sameShape=(inputs:readonly VideoShape[])=>{const first=inputs[0]!;if(inputs.some(input=>input.format!==first.format||input.width!==first.width||input.height!==first.height))throw new Error('Stand-in join inputs differ');return {width:first.width,height:first.height};};
function standIn(name:string,inputs:number,source:number,join:VideoJoinRule<VideoJoinStep>):VideoOperatorDescriptor<VideoJoinStep>{
 return defineVideoOperator<VideoJoinStep>({name,role:'join',join,paths:['graph','stream','actor','timed'],examples:[`split=${inputs}${Array.from({length:inputs},(_,pad)=>`[p${pad}]`).join('')};${Array.from({length:inputs},(_,pad)=>`[p${pad}]`).join('')}${name}`],
  parse(token){if(token.options!==null)throw new Error(`${name} takes no options`);return {inputs,outputs:1,configuration:Object.freeze({name,shortest:false})};},
  geometry:(_step,shapes)=>sameShape(shapes),combine:frames=>passThrough(frames,source),stateful:()=>true});
}
/** Stand-in name, input count, native graph token, and the input whose pixels native outputs. */
export const joinStandIns=Object.freeze([
 {op:standIn('nmaskedmerge',3,0,{rate:'base',props:'base'}),native:'maskedmerge',inputs:3,source:0,fill:{2:0}},
 {op:standIn('nthreshold',4,2,{rate:'base',props:'base',after:(_step,count)=>Array.from({length:count},()=>'stop' as const)}),native:'threshold',inputs:4,source:2,fill:{1:255}},
 {op:standIn('nmix',2,0,{rate:'base'}),native:'mix=weights=1 0',inputs:2,source:0,fill:{}},
] as const);
/** vf_mix duration=first: in[0].after=EXT_STOP and every other input EXT_INFINITY, refused at plan time. */
export const mixedJoinStandIn=Object.freeze({op:standIn('nmixfirst',2,0,{rate:'base',after:(_step,count)=>Array.from({length:count},(_,pad)=>pad?'infinity' as const:'stop' as const)}),native:'mix=weights=1 0:duration=first'});
/** The registry module with the stand-ins added; lookups fall back to the registered operators. */
export function withJoinStandIns(registry:typeof Registry):typeof Registry{
 const added=[...joinStandIns.map(entry=>entry.op),mixedJoinStandIn.op] as VideoOperatorDescriptor[];for(const op of added){registry.validateVideoOperator(op);if(registry.videoOperator(op.name))throw new Error(`Stand-in ${op.name} is registered`);}
 const table=new Map(added.map(op=>[op.name,op])),lookup=(name:string)=>table.get(name)??registry.videoOperator(name);
 return {...registry,videoOperators:Object.freeze([...registry.videoOperators,...added]) as never,videoOperator:lookup,supportsVideoPath:(name,path)=>lookup(name)?.paths.includes(path)===true,
  requireVideoPath(name,path,failure){const op=lookup(name);if(!op?.paths.includes(path))throw failure?failure(name):new Error(`Video filter ${name} is not implemented for ${path} execution`);return op;}};
}
