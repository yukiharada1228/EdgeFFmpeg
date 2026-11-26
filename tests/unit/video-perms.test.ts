import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution,planTimedVideoGraph,VideoFilterError,videoOperator} from '@edge-ffmpeg/avfilter';
import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {permsOperator} from '../../packages/avfilter/src/video-ops/perms.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {negotiationOrder} from '../../packages/avfilter/src/video-ops/formats.js';
import {VideoFilterSyntaxError} from '../../packages/avfilter/src/video-syntax.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {executeTimedGraph} from '../../packages/avformat/src/actor-video/execute.js';
import type {Store} from '../../packages/avformat/src/actor-video/spool/index.js';
const time={num:1n,den:25n},rate={num:25n,den:1n},EOF=-541478725;
const gray=(n:number,width=5,height=3,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[Uint8Array.from({length:stride*height},(_,i)=>(i*29+n*71+7)&255)],linesizes:[stride],pts:{value:9007199254740993n+BigInt(n),timeBase:time},metadata:{colorRange:2}});
const snapshot=(frame:VideoFrameData)=>({...frame,planes:frame.planes.map(plane=>[...plane])});
const memoryStore=():Store<TimedVideoOutputEvent>=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,value);},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return value;},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const parse=(options:string|null)=>permsOperator.parse!({name:'perms',options} as never).configuration;
const forms=['perms','perms=ro','perms=rw','perms=toggle','perms=random:7','perms=mode=toggle:seed=0','perms=none:-1','perms=random:4294967295'];
it('parses mode then seed positionally or by name with last-wins repeats as an identity operator over the whole table on every path',()=>{
 expect(videoOperator('perms')).toBe(permsOperator);expect(permsOperator.role).toBe('identity');expect(permsOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
 expect(permsOperator.frame).toBeUndefined();expect(permsOperator.formats).toBeUndefined();expect(permsOperator.geometry).toBeUndefined();expect(permsOperator.timeline).toBeUndefined();expect(permsOperator.geometryCommands).toBeUndefined();
 for(const [options,mode,seed]of [[null,'none',null],['','none',null],['none','none',null],['ro','ro',null],['rw','rw',null],['toggle','toggle',null],['mode=ro','ro',null],['random:7','random',7n],['random:seed=0','random',0n],['mode=random:seed=4294967295','random',4294967295n],
  ['seed=7:mode=random','random',7n],['toggle:-1','toggle',null],['ro:seed=9','ro',9n],['ro:mode=rw','rw',null],['mode=ro:mode=toggle:mode=none','none',null],['random:1:seed=2','random',2n],['random:5:seed=-1:seed=3','random',3n],['seed=4:seed=-1','none',null],["'toggle'",'toggle',null],['mode=\\rw','rw',null]] as const){
  const configuration=parse(options);expect(configuration,String(options)).toEqual({name:'perms',mode,seed});expect(Object.isFrozen(configuration)).toBe(true);
 }
 // f_perms.c has no query_formats, so every table format negotiates without a conversion stage.
 for(const format of negotiationOrder)for(const form of forms){const plan=compileVideoFilterChain(form).plan(format,5,3);expect(plan.stages,format).toEqual([]);expect(plan.pixelFormat).toBe(format);expect(compileVideoFilterGraph(`[0:v]${form}[o]`).plan({format,width:5,height:3},[null]).negotiated.nodes[0]!.inputs[0]!.format,format).toBe(format);}
 expect(compileVideoFilterChain('perms=ro,hflip,perms=toggle').plan('nv21',5,3).stages.map(stage=>[stage.operation,stage.pixelFormat])).toEqual([['hflip','nv21']]);
});
it('refuses bogus modes, malformed seeds, unseeded random, enable= and extra positional options with exact messages before planning on every path',()=>{
 const source={geometry:{format:'gray',width:8,height:8},timeBase:time,frameRate:rate};
 for(const [options,error,message]of [['bogus',VideoFilterParseError,'Unsupported perms mode: bogus'],['mode=1',VideoFilterParseError,'Unsupported perms mode: 1'],['mode=RO',VideoFilterParseError,'Unsupported perms mode: RO'],['mode=ro+rw',VideoFilterParseError,'Unsupported perms mode: ro+rw'],['mode=',VideoFilterParseError,'Unsupported perms mode: '],
  ['seed=-2',VideoFilterParseError,'Invalid perms seed: -2'],['seed=07',VideoFilterParseError,'Invalid perms seed: 07'],['seed=4294967296',VideoFilterParseError,'Invalid perms seed: 4294967296'],['seed=0x7',VideoFilterParseError,'Invalid perms seed: 0x7'],['seed=+7',VideoFilterParseError,'Invalid perms seed: +7'],['seed=7.0',VideoFilterParseError,'Invalid perms seed: 7.0'],
  ['random',VideoFilterParseError,'perms random mode requires an explicit seed'],['random:-1',VideoFilterParseError,'perms random mode requires an explicit seed'],['random:7:seed=-1',VideoFilterParseError,'perms random mode requires an explicit seed'],
  ['enable=1',VideoFilterParseError,'Unsupported perms option: enable'],['ro:enable=gte(t\\,1)',VideoFilterParseError,'Unsupported perms option: enable'],['threads=1',VideoFilterParseError,'Unsupported perms option: threads'],['foo=1',VideoFilterParseError,'Unsupported perms option: foo'],
  ['ro:7:1',VideoFilterSyntaxError,'Missing filter option name'],['mode=ro:7',VideoFilterSyntaxError,'Missing filter option name']] as const)
  expect(()=>parse(options),options).toThrow(new error(message));
 for(const description of ['perms=bogus','perms=seed=-2','perms=seed=07','perms=enable=1','perms=ro:7:1','perms=random','null,perms=random:-1']){
  expect(()=>compileVideoFilterChain(description),description).toThrow(VideoFilterError);
  for(const check of [()=>compileVideoFilterGraph(`[0:v]${description}[o]`),()=>planTimedVideoGraph(description,[source],[null]),()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})])expect(check,description).toThrow();
 }
 expect(()=>compileVideoFilterChain('perms=bogus')).toThrow('Unsupported perms mode: bogus');expect(()=>compileVideoFilterGraph('[0:v]perms=enable=1[o]')).toThrow(VideoFilterParseError);
 expect(()=>createReplayVideoExecution('[0:v]perms=random[o]',[{geometry:source.geometry,timeBase:time,open:()=>{throw new Error('Unexpected open');}}],[null],{maxFrameBytes:256,maxStateBytes:256,maxResidentBytes:4096,maxSourceTraversals:2})).toThrow('perms random mode requires an explicit seed');
});
it('forwards every frame unchanged for every mode on the linear, graph and replay paths within budgets, strides and signals',async()=>{
 for(const form of forms){
  const frame=gray(0),before=snapshot(frame),plan=compileVideoFilterChain(form).plan('gray',5,3);
  const output=plan.apply(frame,{maxFrameBytes:15,maxStateBytes:0});expect(snapshot(output),form).toEqual(before);expect(snapshot(frame)).toEqual(before);
  expect(()=>plan.apply(frame,{maxFrameBytes:0,maxStateBytes:0})).toThrow('budget');expect(()=>plan.apply(gray(0,4,3),{maxFrameBytes:15,maxStateBytes:0})).toThrow('does not match configured graph input');
  const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>plan.apply(frame,{maxFrameBytes:15,signal:controller.signal})).toThrow('stop');
  // Padded rows pass through perms untouched; the next materializing operator reads them through the stride and owns tight planes.
  const padded=gray(1,5,3,8),paddedBefore=snapshot(padded),flipped=compileVideoFilterChain(`${form},hflip`).plan('gray',5,3).apply(padded,{maxFrameBytes:64,maxStateBytes:0});
  expect([...flipped.planes[0]!]).toEqual([0,1,2].flatMap(row=>[...padded.planes[0]!.subarray(row*8,row*8+5)].reverse()));expect(flipped.linesizes).toEqual([5]);expect(flipped.planes[0]!.buffer).not.toBe(padded.planes[0]!.buffer);expect(snapshot(padded)).toEqual(paddedBefore);
  expect(()=>compileVideoFilterChain(`${form},hflip`).plan('gray',5,3).apply(gray(1,5,3,4),{maxFrameBytes:64,maxStateBytes:0})).toThrow();
  const graph=compileVideoFilterGraph(`[0:v]split[a][b];[a]${form}[x];[b]${form},perms=toggle[y]`).plan({format:'gray',width:5,height:3},[null,null]),outputs=graph.apply(frame,{maxFrameBytes:64,maxStateBytes:1<<16,maxResidentBytes:1<<16});
  expect(outputs.map(snapshot)).toEqual([before,before]);expect(snapshot(frame)).toEqual(before);
  const execution=createReplayVideoExecution(`[0:v]${form}[o]`,[{geometry:{format:'gray',width:5,height:3},timeBase:time,async *open(signal){for(let n=0;n<3;n++){signal.throwIfAborted();yield gray(n);}}}],[null],{maxFrameBytes:64,maxStateBytes:64,maxResidentBytes:1<<16,maxSourceTraversals:2}),replayed:VideoFrameData[]=[];
  try{for await(const value of execution.outputs[0]!.frames)replayed.push(value);}finally{await execution.close();}
  expect(replayed.map(value=>[...value.planes[0]!])).toEqual([0,1,2].map(n=>[...gray(n).planes[0]!]));expect(replayed.map(value=>value.pts!.value)).toEqual([0,1,2].map(n=>gray(n).pts!.value));
 }
});
it('forwards every frame unchanged through activation actors and the timed executor and refuses runtime commands',async()=>{
 const shape={format:'gray',width:5,height:3},frames=[0,1,2].map(n=>gray(n)),before=frames.map(snapshot);
 for(const form of forms){
  const actors=createFrameActors(`${form},perms=ro`,{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<16,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:rate,geometry:shape}]}),received:VideoFrameData[]=[];
  try{
   // Native accepts enable (timeline) and mode (process_command); the scoped adaptation refuses both: enable answers
   // AVERROR_PATCHWELCOME as for a filter without timeline support and every other command ENOSYS on the linux-x64 profile.
   expect(actors.sendFilterCommand('perms','enable','0').code).toBe(-1163346256);
   for(const [command,argument]of [['mode','rw'],['mode','toggle'],['seed','1'],['w','2'],['bogus','1']] as const)expect(actors.sendFilterCommand('perms',command,argument).code,command).toBe(-38);
   for(const frame of frames)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame});actors.endInput(0,EOF,3n);
   for(let attempt=0;attempt<16;attempt++){const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);break;}received.push(result.event!.frame);}
  }finally{actors.dispose();}
  expect(received.map(snapshot),form).toEqual(before);expect(frames.map(snapshot)).toEqual(before);
  const timed:VideoFrameData[]=[],source=()=>({async *[Symbol.asyncIterator]():AsyncGenerator<TimedVideoOutputEvent>{for(const frame of frames)yield {kind:'frame',frame,duration:1n};yield {kind:'end',status:'eof',pts:3n,rawPts:3n,inputPts:null,secondaryErrors:[]};}});
  await executeTimedGraph(planTimedVideoGraph(form,[{geometry:shape,timeBase:time,frameRate:rate}],[null]),[source],memoryStore,{numericProfile:'linux-x64',maxFrameBytes:64,maxStateBytes:1<<16,arithmetic:'scalar',maxEvents:64,maxSyncResidentBytes:1<<16,maxOperatorSteps:4096,async frame(_output,event){timed.push(event.frame);}});
  expect(timed.map(value=>[...value.planes[0]!]),form).toEqual(before.map(value=>value.planes[0]));expect(frames.map(snapshot)).toEqual(before);
 }
});
