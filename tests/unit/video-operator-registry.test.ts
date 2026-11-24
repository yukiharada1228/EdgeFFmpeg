import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,compileMultiInputVideoFilterGraph,createReplayVideoExecution,planTimedVideoGraph,parseFilterTopology,resolveVideoFilter as resolveTimed,videoOperators,videoOperator,supportsVideoPath,requireVideoPath,videoExecutionPaths,VideoFilterError} from '@edge-ffmpeg/avfilter';
import type {VideoOperatorDescriptor,VideoExecutionPath,TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {validateVideoOperator} from '../../packages/avfilter/src/video-ops/registry.js';
import {negotiableFormat,executableFormat} from '../../packages/avfilter/src/video-ops/formats.js';
import {resolveVideoFilter as resolveScoped} from '../../packages/avfilter/src/video-graph-resolver.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {negotiateVideoTopology as negotiateTimedTopology} from '../../packages/avfilter/src/activation/formats.js';
import {createTimedGraphExecution,executeTimedGraph} from '../../packages/avformat/src/actor-video/execute.js';
import type {Store} from '../../packages/avformat/src/actor-video/spool/index.js';
// Everything below is derived from the registrations: adding an operator needs no edit here.
// Its descriptor carries the examples this file runs on every flagged path and rejects on every other path.
const all:readonly VideoExecutionPath[]=['linear','graph','stream','actor','timed'],scoped:readonly VideoExecutionPath[]=['graph','stream','actor','timed'];
/** Flags of the operators that predate the registry, pinned to the former name allowlists. Later operators are never listed here. */
const legacy:Readonly<Record<string,readonly VideoExecutionPath[]>>={
 null:all,
 format:all,
 scale:all,
 hflip:all,
 vflip:all,
 transpose:all,
 negate:['linear','graph','stream'],
 split:scoped,
 nullsink:scoped,
 hstack:scoped,
 vstack:scoped,
 crop:['actor'],
 setsar:['actor'],
 setdar:['actor'],
 setpts:['actor','timed'],
};
const unknown=['bogus','constructor','__proto__','source','sink','trim'],operators=videoOperators as readonly VideoOperatorDescriptor[];
const unflagged=(path:VideoExecutionPath)=>operators.filter(op=>!op.paths.includes(path));
const shape={format:'gray',width:8,height:8},time={num:1n,den:25n},rate={num:25n,den:1n},source={geometry:shape,timeBase:time,frameRate:rate},EOF=-541478725;
const budget={maxFrameBytes:1<<18,maxStateBytes:1<<22,maxResidentBytes:1<<24};
const input=(n:number):VideoFrameData=>({width:8,height:8,pixelFormat:'gray',planes:[Uint8Array.from({length:64},(_,i)=>(i*37+n*101+(i>>3)*13)%256)],linesizes:[8],pts:{value:BigInt(n),timeBase:time},metadata:{}});
/** Tight rows and seconds, so paths that pad planes or rebase clocks compare equal. */
const tight=(frame:VideoFrameData)=>{const layout=pixelLayout(frame.pixelFormat,frame.width,frame.height);return {format:layout.pixelFormat,width:frame.width,height:frame.height,seconds:frame.pts?Number(frame.pts.value)*Number(frame.pts.timeBase.num)/Number(frame.pts.timeBase.den):null,planes:layout.planes.map((plane,index)=>Array.from({length:plane.height},(_,row)=>Array.from(frame.planes[index]!.subarray(row*frame.linesizes[index]!,row*frame.linesizes[index]!+plane.rowBytes))))};};
const graphDescription=(example:string)=>`[0:v]${example}[o]`;
const memoryStore=():Store<TimedVideoOutputEvent>=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,value);},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return value;},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const timedSource=()=>({async *[Symbol.asyncIterator]():AsyncGenerator<TimedVideoOutputEvent>{for(let n=0;n<2;n++)yield {kind:'frame',frame:input(n),duration:1n};yield {kind:'end',status:'eof',pts:2n,rawPts:2n,inputPts:null,secondaryErrors:[]};}});
const timedOptions={numericProfile:'darwin-arm64' as const,maxFrameBytes:budget.maxFrameBytes,maxStateBytes:budget.maxStateBytes,arithmetic:'scalar' as const,maxEvents:64,maxSyncResidentBytes:1<<20,maxOperatorSteps:4096};
/** One runner per path, each through that path's public entry point, two frames from an 8x8 gray source. */
const run:Readonly<Record<VideoExecutionPath,(example:string)=>Promise<VideoFrameData[]>>>={
 async linear(example){const plan=compileVideoFilterChain(example).plan('gray',8,8,{arithmetic:'scalar'});return [0,1].map(n=>plan.apply(input(n),budget));},
 async graph(example){const plan=compileVideoFilterGraph(graphDescription(example)).plan(shape,[null],{arithmetic:'scalar'});return [0,1].map(n=>plan.apply(input(n),budget)[0]!);},
 async stream(example){const execution=createReplayVideoExecution(graphDescription(example),[{geometry:shape,timeBase:time,async *open(){for(let n=0;n<2;n++)yield input(n);}}],[null],{...budget,maxSourceTraversals:16},{arithmetic:'scalar'});
  try{const frames:VideoFrameData[]=[];for await(const frame of execution.outputs[0]!.frames)frames.push(frame);return frames;}finally{await execution.close();}},
 async actor(example){const actors=createFrameActors(example,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<20,maxFrameBytes:budget.maxFrameBytes,arithmetic:'scalar',numericProfile:'darwin-arm64',inputs:[{timeBase:time,frameRate:rate,geometry:shape}]});
  try{for(let n=0;n<2;n++)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:input(n)});actors.endInput(0,EOF,2n);const frames:VideoFrameData[]=[];
   for(let attempt=0;attempt<16;attempt++){const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);return frames;}frames.push(result.event!.frame);}throw new Error('Actor output did not end');}finally{actors.dispose();}},
 async timed(example){const frames:VideoFrameData[]=[];await executeTimedGraph(planTimedVideoGraph(example,[source],[null]),[timedSource],memoryStore,{...timedOptions,async frame(_output,event){frames.push(event.frame);}});return frames;},
};
/** The explicit rejection of `op` on an unflagged path, derived from which parsers and flags it has. */
const rejection=(op:VideoOperatorDescriptor,path:VideoExecutionPath):string=>{
 const scopedParser=op.parse!==undefined,timedParser=scopedParser||op.parseTimed!==undefined;
 if(path==='linear')return 'Unsupported video filter';
 if(path==='graph'||path==='stream')return !scopedParser?'Unsupported video filter':`Video filter ${op.name} is not implemented for ${op.paths.includes('graph')?'stream':'graph'} execution`;
 if(path==='actor')return timedParser?'Actor operators not implemented':'Unsupported video filter';
 return !timedParser?'Unsupported video filter':op.paths.includes('actor')?'Timed executor operator remains unimplemented: '+op.name:'Actor operators not implemented';
};
it('registers each video operator once with frozen flags and examples, keeping the legacy flags',()=>{
 const names=videoOperators.map(op=>op.name);expect(new Set(names).size).toBe(names.length);expect([...names].sort()).toEqual(expect.arrayContaining(Object.keys(legacy).sort()));
 expect(Object.isFrozen(videoOperators)).toBe(true);expect(videoExecutionPaths).toEqual(all);
 for(const op of operators){
  expect(Object.isFrozen(op)&&Object.isFrozen(op.paths)&&Object.isFrozen(op.examples),op.name).toBe(true);expect(videoOperator(op.name)).toBe(op);expect(()=>validateVideoOperator(op)).not.toThrow();expect(op.examples.length,op.name).toBeGreaterThan(0);
  if(Object.hasOwn(legacy,op.name))expect(op.paths,op.name).toEqual(legacy[op.name]);
  for(const path of all){expect(supportsVideoPath(op.name,path),`${op.name} ${path}`).toBe(op.paths.includes(path));if(op.paths.includes(path))expect(requireVideoPath(op.name,path)).toBe(op);else expect(()=>requireVideoPath(op.name,path)).toThrow(`Video filter ${op.name} is not implemented for ${path} execution`);}
 }
 for(const name of unknown){expect(videoOperator(name),name).toBeUndefined();for(const path of all)expect(()=>requireVideoPath(name,path),name).toThrow('is not implemented');}
 expect(()=>requireVideoPath('bogus','actor',name=>new RangeError('custom '+name))).toThrow(RangeError);
 // Every path keeps at least one legacy operator it rejects, so the rejection tests below never run empty.
 for(const path of all)expect(unflagged(path).filter(op=>Object.hasOwn(legacy,op.name)).length,path).toBeGreaterThan(0);
});
it('rejects descriptors that flag a path without the members its role needs',()=>{
 const parse=()=>({inputs:1,outputs:1,configuration:{name:'probe'}}),frame=<T>(value:T)=>value,combine=(frames:readonly VideoFrameData[])=>frames[0]!,geometry=()=>({width:1,height:1}),examples=['probe'];
 const cases:readonly [Partial<VideoOperatorDescriptor>,string][]=[
  [{role:'frame',paths:['graph'],parse},'no frame function for graph'],
  [{role:'frame',paths:['timed'],parse},'no frame function for timed'],
  [{role:'frame',paths:['linear'],frame},'no parser for linear'],
  [{role:'join',paths:['graph'],parse,combine},'no join functions for graph'],
  [{role:'resize',paths:['linear'],parse},'no resize geometry for linear'],
  [{role:'retime',paths:['linear'],parse},'role retime is not executable on linear'],
  [{role:'fanout',paths:['linear'],parse},'role fanout is not executable on linear'],
  [{role:'identity',paths:['actor']},'no parser for actor'],
  [{role:'identity',paths:['stream'],parse},'stream requires graph'],
  [{role:'frame',paths:['stream'],parse,frame},'stream requires graph'],
  [{role:'identity',paths:['graph'],parse,geometry},'role identity keeps its input geometry'],
  [{role:'fanout',paths:['graph'],parse,timedGeometry:geometry as never},'role fanout keeps its input geometry'],
  [{role:'identity',paths:['graph'],parse,frame},'frame needs role frame'],
  [{role:'resize',paths:['graph'],parse,geometry,validate:()=>{}},'validate needs role frame'],
  [{role:'identity',paths:['actor'],parse,actorFrame:frame},'actorFrame needs role frame'],
  [{role:'join',paths:['graph'],parse,combine,geometry,bypass:()=>true},'bypass needs role frame'],
  [{role:'frame',paths:['graph'],parse,frame,combine},'combine needs role join'],
  [{role:'identity',paths:['graph','graph'],parse},'paths'],
  [{role:'identity',paths:['gpu' as VideoExecutionPath],parse},'paths'],
  [{role:'magic' as 'frame',paths:[],parse},'role'],
  [{name:'source',role:'identity',paths:[],parse},'name'],
  [{name:'trim',role:'identity',paths:[],parse},'name'],
  [{name:'a=b',role:'identity',paths:[],parse},'name'],
  [{role:'identity',paths:['graph'],parse,examples:[]},'examples'],
  [{role:'identity',paths:['graph'],parse,examples:['']},'examples'],
  [{role:'identity',paths:['graph'],parse,examples:undefined as never},'examples'],
 ];
 for(const [descriptor,reason]of cases)expect(()=>validateVideoOperator({name:'probe',examples,...descriptor} as VideoOperatorDescriptor),reason).toThrow(`Invalid video operator descriptor ${descriptor.name??'probe'}: ${reason}`);
 expect(()=>validateVideoOperator({name:'probe',role:'frame',paths:['actor'],parseTimed:parse,actorFrame:frame,examples} as VideoOperatorDescriptor)).not.toThrow();expect(()=>validateVideoOperator({name:'probe',role:'identity',paths:[],parse,examples} as VideoOperatorDescriptor)).not.toThrow();
});
it('runs every registered example on each flagged path with identical frames',async()=>{
 let runs=0;
 for(const op of operators)for(const example of op.examples){
  let reference:ReturnType<typeof tight>[]|undefined,first:VideoExecutionPath|undefined;
  for(const path of op.paths){
   const frames=(await run[path](example)).map(tight);runs++;expect(frames.length,`${op.name} ${example} ${path}`).toBeGreaterThan(0);
   if(reference)expect(frames,`${op.name} ${example}: ${path} differs from ${first}`).toEqual(reference);else{reference=frames;first=path;}
  }
  // Candidate lists honour the descriptor contract shared by the three negotiators: native's list over every negotiable
  // format, of which at least one member has frame storage here (the others are refused when negotiated).
  const steps=[...op.parse?parseFilterTopology(graphDescription(example),resolveScoped).nodes:[],...parseFilterTopology(graphDescription(example),resolveTimed).nodes].map(node=>node.configuration);
  for(const step of steps){const formats=videoOperator(step.name)!.formats?.(step as never);if(formats)expect(formats.length>0&&new Set(formats).size===formats.length&&formats.every(negotiableFormat)&&formats.some(executableFormat),`${op.name} ${example} formats`).toBe(true);}
 }
 expect(runs).toBeGreaterThanOrEqual(operators.reduce((sum,op)=>sum+op.paths.length,0));
});
it('rejects unregistered and unflagged operators on the linear path',()=>{
 for(const op of unflagged('linear')){
  for(const description of [op.name,'null,'+op.name,op.name+',null'])expect(()=>compileVideoFilterChain(description),`${op.name} ${description}`).toThrow(new VideoFilterError(rejection(op,'linear')));
  // Examples may use graph syntax, which linear chains also reject.
  for(const example of op.examples)expect(()=>compileVideoFilterChain(example),`${op.name} ${example}`).toThrow(VideoFilterError);
 }
 for(const name of unknown){expect(()=>compileVideoFilterChain(name),name).toThrow(VideoFilterError);expect(()=>compileVideoFilterChain('null,'+name),name).toThrow('Unsupported video filter');}
});
it('rejects unregistered and unflagged operators on the frame graph and replay paths',()=>{
 const replay=(description:string)=>createReplayVideoExecution(description,[{geometry:shape,timeBase:time,open:()=>{throw new Error('Unexpected open');}}],[null],{...budget,maxSourceTraversals:4});
 for(const op of unflagged('graph'))for(const example of op.examples){const description=graphDescription(example);
  expect(()=>compileVideoFilterGraph(description),`${op.name} ${example}`).toThrow(rejection(op,'graph'));expect(()=>compileMultiInputVideoFilterGraph(description),`${op.name} ${example}`).toThrow(rejection(op,'graph'));
 }
 for(const op of unflagged('stream'))for(const example of op.examples)expect(()=>replay(graphDescription(example)),`${op.name} ${example}`).toThrow(rejection(op,'stream'));
 for(const name of unknown){const description=graphDescription(name);for(const compile of [compileVideoFilterGraph,compileMultiInputVideoFilterGraph,replay])expect(()=>compile(description),name).toThrow('Unsupported video filter');}
});
it('rejects unregistered and unflagged operators in the timed planner and activation actors',()=>{
 // Intentional correction: planTimedVideoGraph previously planned negate with every format although no timed executor runs it.
 for(const description of ['negate','negate=y','split[a][b];[a]negate;[b]null','hflip,negate'])expect(()=>planTimedVideoGraph(description,[source],description.includes(';')?[null,null]:[null]),description).toThrow('Actor operators not implemented');
 for(const op of unflagged('actor'))for(const example of op.examples){
  expect(()=>createFrameActors(example,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:1<<16}),`${op.name} ${example}`).toThrow(rejection(op,'actor'));
  if(!op.paths.includes('timed'))expect(()=>planTimedVideoGraph(example,[source],[null]),`${op.name} ${example}`).toThrow(rejection(op,'timed'));
 }
 for(const name of unknown){expect(()=>planTimedVideoGraph(name,[source],[null]),name).toThrow('Unsupported video filter');expect(()=>createFrameActors(name,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64}),name).toThrow('Unsupported video filter');}
});
it('rejects unregistered and unflagged operators in the timed graph executor',async()=>{
 const options={...timedOptions,async frame(){throw new Error('Unexpected frame');}},stores=()=>{throw new Error('Unexpected store');},sources=[()=>{throw new Error('Unexpected source');}];
 for(const op of unflagged('timed'))for(const example of op.examples){
  if(op.paths.includes('actor'))await expect(createTimedGraphExecution(planTimedVideoGraph(example,[source],[null]),sources,stores,options),`${op.name} ${example}`).rejects.toThrow(rejection(op,'timed'));
  else expect(()=>planTimedVideoGraph(example,[source],[null]),`${op.name} ${example}`).toThrow(rejection(op,'timed'));
 }
 // A forged plan reaches the executor's own check, which never passes a step through unchanged.
 const plan=planTimedVideoGraph('null',[source],[null]),forged=(configuration:{readonly name:string})=>({...plan,graph:{...plan.graph,nodes:plan.graph.nodes.map(node=>({...node,configuration}))}}) as typeof plan;
 for(const configuration of [...unflagged('timed').map(op=>({name:op.name})),...unknown.map(name=>({name}))])await expect(createTimedGraphExecution(forged(configuration),sources,stores,options),configuration.name).rejects.toThrow('Timed executor operator remains unimplemented: '+configuration.name);
});
it('negotiates and validates negate from the one shared table in every negotiator',()=>{
 const yuv={format:'nv12',width:4,height:4};
 expect(compileVideoFilterChain('negate').plan('nv12',4,4).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv420p'],['negate','yuv420p']]);
 expect(compileVideoFilterGraph('[0:v]negate[o]').plan(yuv,[null]).negotiated.nodes[0]!.inputs[0]!.format).toBe('yuv420p');
 // The timed negotiator previously kept nv12 because its private table did not restrict negate, and never ran plan-time validation.
 expect(negotiateTimedTopology('negate',yuv,[null]).nodes[0]!.inputs[0]!.format).toBe('yuv420p');expect(negotiateTimedTopology('transpose',{format:'yuv422p',width:4,height:4},[null]).nodes[0]!.inputs[0]!.format).toBe(compileVideoFilterGraph('[0:v]transpose[o]').plan({format:'yuv422p',width:4,height:4},[null]).negotiated.nodes[0]!.inputs[0]!.format);
 for(const check of [()=>compileVideoFilterChain('negate=components=r').plan('gray',4,4),()=>compileVideoFilterGraph('[0:v]negate=components=r[o]').plan(shape,[null]),()=>negotiateTimedTopology('negate=components=r',shape,[null])])expect(check).toThrow('Requested components not available');
});
