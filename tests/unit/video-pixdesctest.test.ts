import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution,planTimedVideoGraph,VideoFilterError,videoOperator} from '@edge-ffmpeg/avfilter';
import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {pixdesctestOperator} from '../../packages/avfilter/src/video-ops/pixdesctest.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {negotiationOrder} from '../../packages/avfilter/src/video-ops/formats.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {executeTimedGraph} from '../../packages/avformat/src/actor-video/execute.js';
import type {Store} from '../../packages/avformat/src/actor-video/spool/index.js';
const time={num:1n,den:25n},rate={num:25n,den:1n},EOF=-541478725;
const gray=(n:number,width=5,height=3,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[Uint8Array.from({length:stride*height},(_,i)=>(i*29+n*71+7)&255)],linesizes:[stride],pts:{value:9007199254740993n+BigInt(n),timeBase:time},metadata:{colorRange:2}});
const snapshot=(frame:VideoFrameData)=>({...frame,planes:frame.planes.map(plane=>[...plane])});
const memoryStore=():Store<TimedVideoOutputEvent>=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,value);},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return value;},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
it('parses pixdesctest as an option-free identity operator over the whole negotiation table on every path',()=>{
 expect(videoOperator('pixdesctest')).toBe(pixdesctestOperator);expect(pixdesctestOperator.role).toBe('identity');expect(pixdesctestOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
 expect(pixdesctestOperator.frame).toBeUndefined();expect(pixdesctestOperator.formats).toBeUndefined();expect(pixdesctestOperator.geometry).toBeUndefined();expect(pixdesctestOperator.timeline).toBeUndefined();expect(pixdesctestOperator.geometryCommands).toBeUndefined();
 for(const token of [{name:'pixdesctest',options:null},{name:'pixdesctest',options:''}]){const pads=pixdesctestOperator.parse!(token as never);expect(pads).toEqual({inputs:1,outputs:1,configuration:{name:'pixdesctest'}});expect(Object.isFrozen(pads.configuration)).toBe(true);}
 // Native vf_pixdesctest.c has no query_formats, so every table format negotiates without a conversion stage.
 for(const format of negotiationOrder){const plan=compileVideoFilterChain('pixdesctest').plan(format,5,3);expect(plan.stages,format).toEqual([]);expect(plan.pixelFormat).toBe(format);expect(compileVideoFilterGraph('[0:v]pixdesctest[o]').plan({format,width:5,height:3},[null]).negotiated.nodes[0]!.inputs[0]!.format,format).toBe(format);}
 expect(compileVideoFilterChain('pixdesctest,hflip,pixdesctest').plan('nv21',5,3).stages.map(stage=>[stage.operation,stage.pixelFormat])).toEqual([['hflip','nv21']]);
 // Palette and padded layouts have no frame storage here, so no padding byte is ever claimed: both negotiators refuse them by name.
 for(const format of ['pal8','rgb0','rgb555le','monob']){expect(()=>compileVideoFilterChain('pixdesctest').plan(format,5,3),format).toThrow('Unsupported video negotiation format');expect(()=>compileVideoFilterGraph('[0:v]pixdesctest[o]').plan({format,width:5,height:3},[null]),format).toThrow(`negotiates ${format}, which is not implemented`);}
});
it('refuses every pixdesctest option and enable= with VideoFilterParseError before planning on every path',()=>{
 const source={geometry:{format:'gray',width:8,height:8},timeBase:time,frameRate:rate};
 for(const options of ['enable=1','enable=gte(t\\,1)','threads=1','a=b','x=1:y=2'])expect(()=>pixdesctestOperator.parse!({name:'pixdesctest',options} as never),options).toThrow(VideoFilterParseError);
 for(const description of ['pixdesctest=enable=1','pixdesctest=threads=1','null,pixdesctest=a=b','pixdesctest=foo']){
  expect(()=>compileVideoFilterChain(description),description).toThrow(VideoFilterError);
  for(const check of [()=>compileVideoFilterGraph(`[0:v]${description}[o]`),()=>planTimedVideoGraph(description,[source],[null]),()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})])expect(check,description).toThrow();
 }
 expect(()=>compileVideoFilterChain('pixdesctest=enable=1')).toThrow('Timeline and reflection options are not implemented');expect(()=>compileVideoFilterGraph('[0:v]pixdesctest=enable=1[o]')).toThrow(VideoFilterParseError);
 expect(()=>createReplayVideoExecution('[0:v]pixdesctest=enable=1[o]',[{geometry:source.geometry,timeBase:time,open:()=>{throw new Error('Unexpected open');}}],[null],{maxFrameBytes:256,maxStateBytes:256,maxResidentBytes:4096,maxSourceTraversals:2})).toThrow(VideoFilterParseError);
});
it('forwards the frame unchanged on the linear, graph and replay paths within budgets and signals',async()=>{
 const frame=gray(0),before=snapshot(frame),plan=compileVideoFilterChain('pixdesctest').plan('gray',5,3);
 const output=plan.apply(frame,{maxFrameBytes:15,maxStateBytes:0});expect(snapshot(output)).toEqual(before);expect(snapshot(frame)).toEqual(before);
 expect(()=>plan.apply(frame,{maxFrameBytes:0,maxStateBytes:0})).toThrow('budget');expect(()=>plan.apply(gray(0,4,3),{maxFrameBytes:15,maxStateBytes:0})).toThrow('does not match configured graph input');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>plan.apply(frame,{maxFrameBytes:15,signal:controller.signal})).toThrow('stop');
 // Padded rows pass through pixdesctest untouched; the next materializing operator reads them through the stride.
 const padded=gray(1,5,3,8),paddedBefore=snapshot(padded),flipped=compileVideoFilterChain('pixdesctest,hflip').plan('gray',5,3).apply(padded,{maxFrameBytes:64,maxStateBytes:0});
 expect([...flipped.planes[0]!]).toEqual([0,1,2].flatMap(row=>[...padded.planes[0]!.subarray(row*8,row*8+5)].reverse()));expect(snapshot(padded)).toEqual(paddedBefore);
 expect(()=>compileVideoFilterChain('pixdesctest,hflip').plan('gray',5,3).apply(gray(1,5,3,4),{maxFrameBytes:64,maxStateBytes:0})).toThrow();
 const graph=compileVideoFilterGraph('[0:v]split[a][b];[a]pixdesctest[x];[b]pixdesctest,pixdesctest[y]').plan({format:'gray',width:5,height:3},[null,null]),outputs=graph.apply(frame,{maxFrameBytes:64,maxStateBytes:1<<16,maxResidentBytes:1<<16});
 expect(outputs.map(snapshot)).toEqual([before,before]);expect(snapshot(frame)).toEqual(before);
 const execution=createReplayVideoExecution('[0:v]pixdesctest[o]',[{geometry:{format:'gray',width:5,height:3},timeBase:time,async *open(signal){for(let n=0;n<3;n++){signal.throwIfAborted();yield gray(n);}}}],[null],{maxFrameBytes:64,maxStateBytes:64,maxResidentBytes:1<<16,maxSourceTraversals:2}),replayed:VideoFrameData[]=[];
 try{for await(const value of execution.outputs[0]!.frames)replayed.push(value);}finally{await execution.close();}
 expect(replayed.map(value=>[...value.planes[0]!])).toEqual([0,1,2].map(n=>[...gray(n).planes[0]!]));expect(replayed.map(value=>value.pts!.value)).toEqual([0,1,2].map(n=>gray(n).pts!.value));
});
it('forwards the frame unchanged through activation actors and the timed executor and refuses runtime commands',async()=>{
 const shape={format:'gray',width:5,height:3},frames=[0,1,2].map(n=>gray(n)),before=frames.map(snapshot);
 const actors=createFrameActors('pixdesctest,pixdesctest',{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<16,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:rate,geometry:shape}]}),received:VideoFrameData[]=[];
 try{
  // vf_pixdesctest.c has no process_command and no timeline flag: enable answers AVERROR_PATCHWELCOME and every other command ENOSYS.
  expect(actors.sendFilterCommand('pixdesctest','enable','0').code).toBe(-1163346256);
  for(const [command,argument]of [['w','2'],['h','2'],['x','1'],['expr','PTS'],['bogus','1']] as const)expect(actors.sendFilterCommand('pixdesctest',command,argument).code,command).toBe(-38);
  for(const frame of frames)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame});actors.endInput(0,EOF,3n);
  for(let attempt=0;attempt<16;attempt++){const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);break;}received.push(result.event!.frame);}
 }finally{actors.dispose();}
 expect(received.map(snapshot)).toEqual(before);expect(frames.map(snapshot)).toEqual(before);
 const timed:VideoFrameData[]=[],source=()=>({async *[Symbol.asyncIterator]():AsyncGenerator<TimedVideoOutputEvent>{for(const frame of frames)yield {kind:'frame',frame,duration:1n};yield {kind:'end',status:'eof',pts:3n,rawPts:3n,inputPts:null,secondaryErrors:[]};}});
 await executeTimedGraph(planTimedVideoGraph('pixdesctest',[{geometry:shape,timeBase:time,frameRate:rate}],[null]),[source],memoryStore,{numericProfile:'linux-x64',maxFrameBytes:64,maxStateBytes:1<<16,arithmetic:'scalar',maxEvents:64,maxSyncResidentBytes:1<<16,maxOperatorSteps:4096,async frame(_output,event){timed.push(event.frame);}});
 expect(timed.map(value=>[...value.planes[0]!])).toEqual(before.map(value=>value.planes[0]));expect(frames.map(snapshot)).toEqual(before);
});
