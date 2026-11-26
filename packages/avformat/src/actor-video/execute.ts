import {pixelLayout} from '@edge-ffmpeg/avutil';
import {resizeVideoFrame,pixelResizeStateBytes} from '@edge-ffmpeg/swscale';
import type {PixelArithmetic} from '@edge-ffmpeg/swscale';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import type {Geometry} from "@edge-ffmpeg/avfilter";
import {createSetptsStream,createTimedSynchronization,requireVideoPath,videoJoinPlan,videoJoinEvent} from '@edge-ffmpeg/avfilter';
import type {VideoRetimeStep} from '@edge-ffmpeg/avfilter';
import type {TimedVideoOutputEvent,TimedVideoSourceEvent,TimedVideoFrameEvent,TimedVideoOutputEnd} from '@edge-ffmpeg/avfilter';
import type {ExpressionNumericProfile,ExpressionPrint} from '@edge-ffmpeg/avutil';
import {filterTopologyOrder} from "@edge-ffmpeg/avfilter";
import {createSharedSpool} from "./spool/index.js";import type {Store} from "./spool/index.js";
import {createExecutionFailures} from "./stage-failure.js";
import type {planTimedVideoGraph} from "@edge-ffmpeg/avfilter";
type Plan=ReturnType<typeof planTimedVideoGraph>;
type Factory=(signal:AbortSignal)=>AsyncIterable<TimedVideoOutputEvent>;
/** Prototype DAG executor. Store factories must be lazy and perform no I/O at creation. */
export async function createTimedGraphExecution(plan:Plan,sources:readonly Factory[],stores:(node:number)=>Store<TimedVideoOutputEvent>,options:{numericProfile:ExpressionNumericProfile;onPrint?(node:number,entry:ExpressionPrint):void;logLevel?:number;maxFrameBytes:number;maxStateBytes:number;arithmetic:PixelArithmetic;maxEvents:number;maxSyncResidentBytes:number;maxOperatorSteps:number;signal?:AbortSignal;frame(output:number,event:TimedVideoFrameEvent):Promise<void>;terminal?(output:number,event:TimedVideoOutputEnd):Promise<void>;diagnostics?(records:ReturnType<ReturnType<typeof createExecutionFailures>['snapshot']>):Promise<void>}){
 options={...options};sources=[...sources];
 const graph=plan.graph,order=filterTopologyOrder(graph);
 if(graph.nodes.some(node=>node.configuration.enableExpression!==undefined||node.configuration.scaleWidthExpression!==undefined))throw new Error('Inline dynamic filter expressions currently require activation execution');
 if(sources.length!==graph.inputs.length)throw new Error('Execution source count mismatch');
 const unimplemented=(name:string)=>new Error('Timed executor operator remains unimplemented: '+name),operators=graph.nodes.map(node=>{const op=requireVideoPath(node.configuration.name,'timed',unimplemented);if(node.inputs<1)throw unimplemented(node.configuration.name);return op;});
 for(const n of [options.maxFrameBytes,options.maxStateBytes,options.maxEvents,options.maxSyncResidentBytes,options.maxOperatorSteps])if(!Number.isSafeInteger(n)||n<1)throw new Error('Invalid timed executor bound');
 if(!['aarch64','x86_64','scalar'].includes(options.arithmetic))throw new Error('Invalid pixel arithmetic profile');
 for(const geometry of [...plan.sources.map(source=>source.geometry),...plan.nodes.flatMap(node=>[...node.inputs,...node.outputs]),...plan.sinks])if(pixelLayout(geometry.format,geometry.width,geometry.height).bytes>options.maxFrameBytes)throw new Error('Planned frame exceeds byte budget');
 const checkResize=(input:Geometry,output:Geometry)=>{if(pixelResizeStateBytes(input.format,input.width,input.height,output.width,output.height,output.format,options.arithmetic)>options.maxStateBytes)throw new Error('Planned conversion exceeds state budget');};
 for(const edge of graph.edges)checkResize(plan.nodes[edge.from.node]!.outputs[edge.from.pad]!,plan.nodes[edge.to.node]!.inputs[edge.to.pad]!);
 for(const index of graph.nodes.keys())if(operators[index]!.role==='resize')checkResize(plan.nodes[index]!.inputs[0]!,plan.nodes[index]!.outputs[0]!);
 for(const [index,pad]of graph.outputs.entries())checkResize(plan.nodes[pad.node]!.outputs[pad.pad]!,plan.sinks[index]!);
 const controller=new AbortController(),ledger=createExecutionFailures(),opens=new Map<string,Factory>(),spools:ReturnType<typeof createSharedSpool<TimedVideoOutputEvent>>[]=[],stages:ReturnType<typeof createSetptsStream>[]=[],drains:Factory[]=[],joins:{close():Promise<unknown>}[]=[];
 const pixels={maxFrameBytes:options.maxFrameBytes,maxStateBytes:options.maxStateBytes,arithmetic:options.arithmetic,signal:controller.signal};
 const convert=(frame:VideoFrameData,target:Geometry)=>frame.width===target.width&&frame.height===target.height&&frame.pixelFormat===target.format?frame:resizeVideoFrame(frame,target.width,target.height,{...pixels,outputPixelFormat:target.format});
 const abort=()=>controller.abort(options.signal!.reason);if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});
 const inputBindings=new Map(graph.inputs.map((input,index)=>[`${input.node}:${input.pad}`,((signal:AbortSignal)=>({async *[Symbol.asyncIterator](){const declared=plan.sources[index]!,iterator=sources[index]!(signal)[Symbol.asyncIterator]();let ended=false;try{for(;;){const next=await iterator.next();if(next.done){ended=true;break;}const event=next.value;signal.throwIfAborted();if(event.kind==='frame'){
   const frame=event.frame,layout=pixelLayout(frame.pixelFormat,frame.width,frame.height),expected=pixelLayout(declared.geometry.format,declared.geometry.width,declared.geometry.height);
   if(layout.pixelFormat!==expected.pixelFormat||frame.width!==declared.geometry.width||frame.height!==declared.geometry.height||frame.planes.length!==layout.planes.length||frame.linesizes.length!==layout.planes.length)throw new Error('Source frame differs from graph declaration');
   let resident=0;for(const [pad,plane]of layout.planes.entries()){const bytes=frame.planes[pad]!,stride=frame.linesizes[pad]!;if(!(bytes instanceof Uint8Array)||!Number.isSafeInteger(stride)||stride<plane.rowBytes||BigInt(bytes.byteLength)<BigInt(stride)*BigInt(plane.height-1)+BigInt(plane.rowBytes))throw new Error('Invalid graph source plane storage');resident+=bytes.byteLength;}
   if(resident>options.maxFrameBytes)throw new Error('Graph source payload exceeds byte budget');const stamp=frame.pts;if(stamp&&(typeof stamp.value!=='bigint'||stamp.value<-(1n<<63n)||stamp.value>=(1n<<63n)||stamp.timeBase.num!==declared.timeBase.num||stamp.timeBase.den!==declared.timeBase.den))throw new Error('Graph source timestamp differs from declared clock');
  }yield event;}}catch(error){ledger.observe('source:'+index,'primary',error);throw error;}finally{if(!ended)try{await iterator.return?.();}catch(error){ledger.observe('source:'+index,'cleanup',error);}}}})) as Factory]));
 const toSource=(factory:Factory)=>(signal:AbortSignal)=>({async *[Symbol.asyncIterator]():AsyncGenerator<TimedVideoSourceEvent>{for await(const event of factory(signal)){signal.throwIfAborted();if(event.kind==='frame')yield event;else if(event.status==='eof')yield {kind:'end',status:'eof',pts:event.pts};else yield {kind:'end',status:'error',pts:event.pts,error:event.error};}}});
 try{
  for(const index of order){const node=graph.nodes[index]!,geometry=plan.nodes[index]!;
   const preparedInputs=Array.from({length:node.inputs},(_,pad):Factory=>{const incoming=graph.edges.find(edge=>edge.to.node===index&&edge.to.pad===pad),factory=incoming?opens.get(`${incoming.from.node}:${incoming.from.pad}`)!:inputBindings.get(`${index}:${pad}`)!;if(!factory)throw new Error('Missing execution input');return signal=>({async *[Symbol.asyncIterator](){for await(const event of factory(signal)){signal.throwIfAborted();if(event.kind==='frame')yield {...event,frame:convert(event.frame,geometry.inputs[pad]!)};else {if(event.status!=='eof')ledger.observe(`node:${index}:input:${pad}`,'input',event.error);for(const error of event.secondaryErrors)ledger.observe(`node:${index}:input:${pad}`,'cleanup',error);yield event;}}}});});
   const prepared=preparedInputs[0]!;let output=prepared;
   // Identity, fanout and sink roles forward the prepared input; every other role has one branch.
   const step=node.configuration,op=operators[index]!;if(op.role==='frame'||op.role==='resize')output=signal=>({async *[Symbol.asyncIterator](){for await(const event of prepared(signal)){if(event.kind!=='frame'){yield event;continue;}let frame=event.frame;if(op.role==='resize')frame=convert(frame,geometry.outputs[0]!);else if(!op.bypass?.(step,frame.width,frame.height))frame=op.frame!(frame,step,pixels);yield {...event,frame};}}});
   if(op.role==='join'){
    const rule=videoJoinPlan(op,step,node.inputs),join=createTimedSynchronization(preparedInputs.map((factory,pad)=>({timeBase:geometry.inputs[pad]!.timeBase,open(signal:AbortSignal){return {async *[Symbol.asyncIterator](){for await(const event of factory(signal)){if(event.kind==='frame')yield {kind:'frame' as const,value:event};else if(event.status==='eof')yield {kind:'end' as const,status:'eof' as const,pts:event.pts};else yield {kind:'end' as const,status:'error' as const,pts:event.pts,error:event.error};}}};}})),{shortest:rule.shortest,maxResidentBytes:options.maxSyncResidentBytes,maxPendingFrames:node.inputs*2,maxOperatorSteps:options.maxOperatorSteps,signal:controller.signal,timestamp:event=>event.frame.pts,retain(event,available){const bytes=event.frame.planes.reduce((sum,plane)=>sum+plane.byteLength,0);if(bytes>available)throw new Error('Join lease budget exceeded');return {value:{...event,frame:{...event.frame,planes:event.frame.planes.map(plane=>plane.slice()),linesizes:[...event.frame.linesizes],metadata:{...event.frame.metadata}}},bytes,release(){}};}});
    joins.push(join);ledger.register('join:'+index,join.completion);
    output=()=>({async *[Symbol.asyncIterator](){try{for await(const event of join){if(event.kind==='frame'){const pts={...event.pts,value:event.pts.value===-(1n<<63n)?event.pts.value+1n:event.pts.value};yield videoJoinEvent(rule.props,event.values[0]!,op.combine!(event.values.map(value=>({...value.frame,pts})),step,pixels));}else yield {kind:'end' as const,status:'eof' as const,pts:event.pts,rawPts:event.rawPts,inputPts:null,secondaryErrors:[]};}}finally{await join.close();}}});
   }
   if(op.role==='retime'){const retime=step as VideoRetimeStep,clock=plan.nodes[index]!.inputs[0]!,stage=createSetptsStream(toSource(prepared),{numericProfile:options.numericProfile,...(options.onPrint?{onPrint:(entry:ExpressionPrint)=>options.onPrint!(index,entry)}:{}),...(options.logLevel===undefined?{}:{logLevel:options.logLevel}),expression:retime.expression,stripFps:retime.stripFps,timeBase:clock.timeBase,frameRate:clock.frameRate,maxFrameBytes:options.maxFrameBytes});stages.push(stage);ledger.register('setpts:'+index,stage.completion);output=signal=>stage.open(signal);}
   if(!node.outputs){drains.push(output);continue;}
   const spool=createSharedSpool(signal=>output(signal),stores(index),{readers:node.outputs,maxEvents:options.maxEvents,terminal:event=>event.kind==='end',signal:controller.signal});spools.push(spool);ledger.register('spool:'+index,spool.closed.then(result=>({...result,status:result.status==='closed'?'eof' as const:'error' as const})));
   for(let pad=0;pad<node.outputs;pad++)opens.set(`${index}:${pad}`,()=>spool.open(pad));
  }
 }catch(error){ledger.observe('executor','primary',error);if(!controller.signal.aborted)controller.abort(error);await cleanup();await ledger.settle();try{await options.diagnostics?.(ledger.snapshot());}catch(diagnostic){ledger.observe('diagnostics','primary',diagnostic);}ledger.assertSuccess();throw error;}
 let finishing:Promise<void>|undefined,draining:Promise<void>|undefined;const active=new Set<AsyncIterator<TimedVideoOutputEvent>>();
 function wrap(factory:Factory,index:number):AsyncIterable<TimedVideoOutputEvent>{let acquired=false;return {[Symbol.asyncIterator](){if(acquired)throw new Error('Timed graph output already acquired');acquired=true;const reader=factory(controller.signal)[Symbol.asyncIterator]();let terminal=false,closed=false,busy=false;
 const iterator:AsyncIterator<TimedVideoOutputEvent>={async next(){if(busy)throw new Error('Concurrent graph output reads');if(closed)return {done:true,value:undefined};busy=true;try{controller.signal.throwIfAborted();if(terminal){await iterator.return?.();return {done:true,value:undefined};}const next=await reader.next();controller.signal.throwIfAborted();if(next.done)throw new Error('Output ended without terminal');const event=next.value;if(event.kind==='end'){terminal=true;if(event.status!=='eof')ledger.observe('sink:'+index,'input',event.error);for(const error of event.secondaryErrors)ledger.observe('sink:'+index,'cleanup',error);return {done:false,value:event};}return {done:false,value:index<0?event:{...event,frame:convert(event.frame,plan.sinks[index]!)}};
 }catch(error){ledger.observe('sink:'+index,'primary',error);if(!controller.signal.aborted)controller.abort(error);throw error;}finally{busy=false;}},async return(){if(!closed){closed=true;active.delete(iterator);try{await reader.return?.();}catch(error){ledger.observe('sink:'+index,'cleanup',error);throw error;}}return {done:true,value:undefined};}};active.add(iterator);return iterator;}};}
 async function cleanup(){
  // Stop unconsumed stage tails before aborting their spool source signals.
  for(const stage of [...stages].reverse())try{await stage.close();}catch(error){ledger.observe('setpts','cleanup',error);}
  for(const join of [...joins].reverse())try{await join.close();}catch(error){ledger.observe('join','cleanup',error);}
  for(const [index,spool]of [...spools.entries()].reverse())try{await spool.close();}catch(error){ledger.observe('spool:'+index,'cleanup',error);}
  options.signal?.removeEventListener('abort',abort);
 }
 return {outputs:graph.outputs.map((pad,index)=>wrap(opens.get(`${pad.node}:${pad.pad}`)!,index)),
  fail(error:unknown){ledger.observe('executor','primary',error);if(!controller.signal.aborted)controller.abort(error);},
  drain(){return draining??=Promise.all(drains.map(async(factory,index)=>{for await(const _event of wrap(factory,-index-1)){void _event;/* Null sinks consume all requested frames. */}})).then(()=>{});},
  finish(){return finishing??=(async()=>{const results=await Promise.allSettled([...active].map(iterator=>iterator.return?.()));for(const result of results)if(result.status==='rejected')ledger.observe('outputs','cleanup',result.reason);await cleanup();await ledger.settle();try{await options.diagnostics?.(ledger.snapshot());}catch(error){ledger.observe('diagnostics','primary',error);}ledger.assertSuccess();})();}
 };
}

export async function executeTimedGraph(...args:Parameters<typeof createTimedGraphExecution>){
 const [plan,sources,stores,provided]=args,options={...provided},execution=await createTimedGraphExecution(plan,sources,stores,options);
 const tasks=[...execution.outputs.map(async(output,index)=>{for await(const event of output){try{if(event.kind==='frame')await options.frame(index,event);else await options.terminal?.(index,event);}catch(error){execution.fail(error);throw error;}}}),execution.drain()];
 try{await Promise.all(tasks);}catch(error){execution.fail(error);}await Promise.allSettled(tasks);await execution.finish();
}
