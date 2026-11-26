import {pixelLayout,rescale} from '@edge-ffmpeg/avutil';
import {synchronizationTimeBase} from './frame-sync.js';
import {videoJoinPlan} from './video-join.js';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {resizeVideoFrame,pixelResizeStateBytes} from '@edge-ffmpeg/swscale';
import type {PixelArithmetic} from '@edge-ffmpeg/swscale';
import {parseFilterTopology,filterTopologyOrder} from './filter-topology.js';
import {requireVideoPath} from './video-ops/registry.js';
import {resolveVideoFilter} from './video-graph-resolver.js';
import {negotiateVideoTopology} from './video-graph-formats.js';
import type {Geometry} from './video-graph-formats.js';
export interface GraphFrameBudget{readonly maxFrameBytes:number;readonly maxStateBytes:number;readonly maxResidentBytes:number;readonly signal?:AbortSignal}
function validate(frame:VideoFrameData,maxFrameBytes:number):number{
 const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<layout.bytes||frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new Error('Invalid graph frame layout or budget');
 let storage=0n;for(const [index,plane]of layout.planes.entries()){const data=frame.planes[index],stride=frame.linesizes[index];if(!(data instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride!<plane.rowBytes||stride!>2147483647||BigInt(data.length)<BigInt(stride!)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new Error('Invalid graph frame stride or storage');storage+=BigInt(data.length);}
 if(storage>BigInt(maxFrameBytes))throw new Error('Graph input storage exceeds frame budget');if(frame.pts&&(typeof frame.pts.value!=='bigint'||typeof frame.pts.timeBase.num!=='bigint'||typeof frame.pts.timeBase.den!=='bigint'||frame.pts.timeBase.num<=0n||frame.pts.timeBase.den<=0n))throw new Error('Invalid graph frame timestamp');return Number(storage);
}
function clone(frame:VideoFrameData,options:GraphFrameBudget):VideoFrameData{
 validate(frame,options.maxFrameBytes);const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height),data=new Uint8Array(layout.bytes);
 for(const [index,plane]of layout.planes.entries())for(let row=0;row<plane.height;row++){options.signal?.throwIfAborted();const start=row*frame.linesizes[index]!;data.set(frame.planes[index]!.subarray(start,start+plane.rowBytes),plane.offset+row*plane.rowBytes);}
 return {width:frame.width,height:frame.height,pixelFormat:layout.pixelFormat,planes:layout.planes.map(plane=>data.subarray(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:frame.pts===null?null:{value:frame.pts.value,timeBase:{...frame.pts.timeBase}},metadata:{...frame.metadata}};
}
const same=(a:Geometry,b:Geometry)=>a.format===b.format&&a.width===b.width&&a.height===b.height;
export function compileMultiFrameGraph(description:string){
 const graph=parseFilterTopology(description,resolveVideoFilter),order=filterTopologyOrder(graph);if(!graph.inputs.length||graph.inputs.length>32)throw new Error('Only one to thirty-two external frame sources are implemented');
 const operators=Object.freeze(graph.nodes.map(node=>requireVideoPath(node.configuration.name,'graph')));
 return Object.freeze({graph,plan(sources:readonly Geometry[],targets:readonly (string|null)[],options:{readonly arithmetic?:PixelArithmetic;readonly inputTrim?:boolean|readonly boolean[];readonly inputRegistrationOrder?:readonly number[];readonly outputRegistrationOrder?:readonly number[];readonly outputSizes?:readonly ({readonly width:number;readonly height:number}|null)[]}={}){
  const arithmetic=options.arithmetic??'aarch64';if(!['aarch64','scalar','x86_64'].includes(arithmetic))throw new Error('Invalid graph arithmetic');
  if(sources.length!==graph.inputs.length)throw new Error('Source geometry binding count mismatch');
  const layouts=sources.map(source=>pixelLayout(source.format,source.width,source.height));sources=Object.freeze(layouts.map(layout=>Object.freeze({format:layout.pixelFormat,width:layout.width,height:layout.height})));
  const sourceBytes=layouts.reduce((total,layout)=>total+BigInt(layout.bytes),0n),bindings=new Map(graph.inputs.map((pad,index)=>[`${pad.node}:${pad.pad}`,index]));
  const sourceFor=(node:number,pad:number)=>{const index=bindings.get(`${node}:${pad}`);if(index===undefined)throw new Error('Unbound graph input pad');return index;};
  const negotiated=negotiateVideoTopology(description,sources,targets,{...(options.inputRegistrationOrder?{inputRegistrationOrder:options.inputRegistrationOrder}:{}),...(options.inputTrim?{inputTrim:options.inputTrim}:{}),...(options.outputRegistrationOrder?{outputRegistrationOrder:options.outputRegistrationOrder}:{}),...(options.outputSizes?{outputSizes:options.outputSizes}:{})}),incoming=graph.nodes.map(node=>Array.from({length:node.inputs},()=>null as {node:number;pad:number}|null));
  for(const edge of graph.edges)incoming[edge.to.node]![edge.to.pad]=edge.from;
  let state=0n,allocated=0n,maxFrameBytes=Math.max(...layouts.map(layout=>layout.bytes));
  const account=(input:Geometry,output:Geometry,copy=false)=>{const bytes=pixelLayout(output.format,output.width,output.height).bytes;maxFrameBytes=Math.max(maxFrameBytes,bytes);if(copy||!same(input,output)){allocated+=BigInt(bytes);if(!copy)state+=BigInt(pixelResizeStateBytes(input.format,input.width,input.height,output.width,output.height,output.format,arithmetic));}};
  for(const index of order){const node=graph.nodes[index]!,op=operators[index]!,step=node.configuration,plan=negotiated.nodes[index]!,input=plan.inputs[0]!,output=plan.outputs[0];
   for(const [pad,geometry]of plan.inputs.entries()){const edge=incoming[index]![pad];account(edge?negotiated.nodes[edge.node]!.outputs[edge.pad]!:sources[sourceFor(index,pad)]!,geometry);}
   // Joins and frame operators materialize owned frames; resizes add converter state.
   // Callers synchronize join batches; the declared rule is still resolved so every path refuses the same joins.
   if(op.role==='join'){videoJoinPlan(op,step,node.inputs);account(input,output!,true);}
   else if(op.role==='frame'){op.validate?.(input.format,step);if(!op.bypass?.(step,input.width,input.height))account(input,output!,true);}
   else if(op.role==='resize')account(input,output!);
   else if(op.role!=='identity'&&op.role!=='fanout'&&op.role!=='sink')throw new Error(`Video filter ${step.name} has no frame graph role`);
  }
  for(const [index,pad]of graph.outputs.entries()){const before=negotiated.nodes[pad.node]!.outputs[pad.pad]!,output=negotiated.sinks[index]!;account(before,output);account(output,output,true);}
  const required=sourceBytes+allocated+state;if(required>BigInt(Number.MAX_SAFE_INTEGER)||state>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Graph payload allocation exceeds safe size');
  const checkBudget=(budget:GraphFrameBudget,storage=Number(sourceBytes))=>{if(!Number.isSafeInteger(budget.maxFrameBytes)||budget.maxFrameBytes<maxFrameBytes||!Number.isSafeInteger(budget.maxStateBytes)||budget.maxStateBytes<Number(state)||!Number.isSafeInteger(budget.maxResidentBytes)||budget.maxResidentBytes<Number(required)+storage-Number(sourceBytes))throw new Error('Graph typed payload exceeds configured budget');};
  const applyBatch=(frames:readonly VideoFrameData[],budget:GraphFrameBudget):readonly VideoFrameData[]=>{
   budget.signal?.throwIfAborted();if(frames.length!==sources.length)throw new Error('Source frame binding count mismatch');let storage=0n;
   for(const [index,frame]of frames.entries()){storage+=BigInt(validate(frame,budget.maxFrameBytes));if(!same({format:pixelLayout(frame.pixelFormat,frame.width,frame.height).pixelFormat,width:frame.width,height:frame.height},sources[index]!))throw new Error('Frame does not match configured graph source');}
   const first=frames[0]!.pts;for(const frame of frames){const pts=frame.pts;if(pts===null?first!==null:first===null||pts.value*pts.timeBase.num*first.timeBase.den!==first.value*first.timeBase.num*pts.timeBase.den)throw new Error('Batch frames must be synchronized before graph processing');}
   if(storage>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Source storage exceeds safe size');checkBudget(budget,Number(storage));
   const pixels={maxFrameBytes:budget.maxFrameBytes,maxStateBytes:budget.maxStateBytes,arithmetic,...(budget.signal?{signal:budget.signal}:{})},convert=(value:VideoFrameData,target:Geometry)=>same({format:pixelLayout(value.pixelFormat,value.width,value.height).pixelFormat,width:value.width,height:value.height},target)?value:resizeVideoFrame(value,target.width,target.height,{...pixels,outputPixelFormat:target.format}),values=new Map<number,VideoFrameData>();
   for(const index of order){budget.signal?.throwIfAborted();const node=graph.nodes[index]!,op=operators[index]!,plan=negotiated.nodes[index]!,inputs=plan.inputs.map((geometry,pad)=>{const edge=incoming[index]![pad];return convert(edge?values.get(edge.node)!:frames[sourceFor(index,pad)]!,geometry);});let current=inputs[0]!;const step=node.configuration;
    if(op.role==='join'){
     const stamp=inputs[0]!.pts,clock=stamp?synchronizationTimeBase(inputs.map(input=>input.pts!.timeBase)):null;
     const synchronized=clock?inputs.map(input=>({...input,pts:{value:rescale(input.pts!.value,input.pts!.timeBase,clock),timeBase:clock}})):inputs;
     current=op.combine!(synchronized,step,pixels);
    }
    else if(op.role==='frame'){if(!op.bypass?.(step,current.width,current.height))current=op.frame!(current,step,pixels);}
    else if(op.role==='resize')current=convert(current,plan.outputs[0]!);
    values.set(index,current);
   }
   return Object.freeze(graph.outputs.map((pad,index)=>clone(convert(values.get(pad.node)!,negotiated.sinks[index]!),budget)));
  };
  return Object.freeze({sources,negotiated,arithmetic,maxFrameBytes,stateBytes:Number(state),allocatedFrameBytes:Number(allocated),requiredPayloadBytes:Number(required),applyBatch,
   async *processBatches(frames:AsyncIterable<readonly VideoFrameData[]>,budget:GraphFrameBudget):AsyncIterable<readonly VideoFrameData[]> {
    const snapshot={...budget};snapshot.signal?.throwIfAborted();checkBudget(snapshot);const iterator=frames[Symbol.asyncIterator]();let finished=false,failed=false;
    try{for(;;){snapshot.signal?.throwIfAborted();const next=await iterator.next();snapshot.signal?.throwIfAborted();if(next.done){finished=true;return;}yield applyBatch(next.value,snapshot);}}
    catch(error){failed=true;throw error;}
    finally{if(!finished)try{await iterator.return?.();}catch(error){if(!failed)throw error;}}
   }
  });
 }});
}

export function compileFrameGraph(description:string){
 const multi=compileMultiFrameGraph(description);if(multi.graph.inputs.length!==1)throw new Error('Only one external frame source is implemented');
 return Object.freeze({graph:multi.graph,plan(source:Geometry,targets:readonly (string|null)[],options:Parameters<typeof multi.plan>[2]={}){
  const plan=multi.plan([source],targets,options);return Object.freeze({...plan,source:plan.sources[0]!,apply:(frame:VideoFrameData,budget:GraphFrameBudget)=>plan.applyBatch([frame],budget),
   process(frames:AsyncIterable<VideoFrameData>,budget:GraphFrameBudget){async function* batches(){for await(const frame of frames)yield [frame];}return plan.processBatches(batches(),budget);}
  });
 }});
}
