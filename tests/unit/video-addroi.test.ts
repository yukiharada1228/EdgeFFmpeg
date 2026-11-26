import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution,planTimedVideoGraph,VideoFilterError,videoOperator} from '@edge-ffmpeg/avfilter';
import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import {compileExpression} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {addroiExpressionRange,addroiOperator,addroiRegion,parseAddroiOptions,parseAddroiQoffset} from '../../packages/avfilter/src/video-ops/addroi.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {negotiationOrder} from '../../packages/avfilter/src/video-ops/formats.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {executeTimedGraph} from '../../packages/avformat/src/actor-video/execute.js';
import type {Store} from '../../packages/avformat/src/actor-video/spool/index.js';
const time={num:1n,den:25n},rate={num:25n,den:1n},EOF=-541478725;
const gray=(n:number,width=5,height=3,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[Uint8Array.from({length:stride*height},(_,i)=>(i*29+n*71+7)&255)],linesizes:[stride],pts:{value:9007199254740993n+BigInt(n),timeBase:time},metadata:{colorRange:2}});
const snapshot=(frame:VideoFrameData)=>({...frame,planes:frame.planes.map(plane=>[...plane])});
const memoryStore=():Store<TimedVideoOutputEvent>=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,value);},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return value;},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const step=(options:string|null)=>parseAddroiOptions(options);
it('parses addroi options in native shorthand order with the declared defaults as a frozen identity step on every path',()=>{
 expect(videoOperator('addroi')).toBe(addroiOperator);expect(addroiOperator.role).toBe('identity');expect(addroiOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
 for(const member of ['frame','formats','geometry','timedGeometry','validate','bypass','timeline','geometryCommands','actorFrame'] as const)expect(addroiOperator[member],member).toBeUndefined();
 for(const options of [null,''])expect(step(options)).toEqual({name:'addroi',x:'0',y:'0',w:'0',h:'0',qoffset:{num:-1,den:10},clear:false});
 const pads=addroiOperator.parse!({name:'addroi',options:'0:0:iw/2:ih/2:-1/5'} as never);expect(pads).toEqual({inputs:1,outputs:1,configuration:{name:'addroi',x:'0',y:'0',w:'iw/2',h:'ih/2',qoffset:{num:-1,den:5},clear:false}});expect(Object.isFrozen(pads.configuration)).toBe(true);
 expect(step('x=iw/4:w=iw*2:qoffset=1')).toMatchObject({x:'iw/4',w:'iw*2',qoffset:{num:1,den:1}});expect(step('1:2:3:4:0:1')).toMatchObject({x:'1',y:'2',w:'3',h:'4',qoffset:{num:0,den:1},clear:true});
 expect(step('x=1:x=2:clear=1:clear=0')).toMatchObject({x:'2',clear:false});
 for(const [value,clear]of [['true',true],['on',true],['YES',true],['0',false],['1',true],['off',false],['disabled',false]] as const)expect(step(`clear=${value}`).clear,value).toBe(clear);
 // Every table format negotiates without a conversion stage: no query_formats, metadata only.
 for(const format of negotiationOrder){const plan=compileVideoFilterChain('addroi=0:0:iw/2:ih/2').plan(format,5,3);expect(plan.stages,format).toEqual([]);expect(plan.pixelFormat).toBe(format);expect(compileVideoFilterGraph('[0:v]addroi[o]').plan({format,width:5,height:3},[null]).negotiated.nodes[0]!.inputs[0]!.format,format).toBe(format);}
 expect(compileVideoFilterChain('addroi,hflip,addroi=clear=1').plan('nv21',5,3).stages.map(stage=>[stage.operation,stage.pixelFormat])).toEqual([['hflip','nv21']]);
});
it('parses qoffset as opt.c does: the integer ratio first, then the option expression, with write_number range checks',()=>{
 const cases:readonly (readonly [string,number,number])[]=[['-1/10',-1,10],['-1/5',-1,5],['1',1,1],['-1',-1,1],['0',0,1],['1:2',1,2],[' +3/4',3,4],['1/ 2',1,2],['-0',0,1],['2/4',2,4],['0/5',0,5],
  // Ratios outside the range fall through to the expression: 1/-2 and -1/-2 are refused by write_number, then accepted as expressions.
  ['1/-2',-1,2],['-1/-2',1,2],['0.5',1,2],['-0.1',-1,10],['default',-1,10],['max',1,1],['min',-1,1],['none',0,1],['all',-1,1],['1/3',1,3],['0.25*2',1,2],['(1+1)/4',1,2],['-(1/4)',-1,4],['1e-1',1,10],['.5',1,2]];
 for(const [value,num,den]of cases)expect(parseAddroiQoffset(value),value).toEqual({num,den});
 expect(parseAddroiQoffset('1/7')).toEqual({num:1,den:7});expect(parseAddroiQoffset('0.3')).toEqual({num:3,den:10});expect(parseAddroiQoffset('0.1234567891')).toEqual({num:1489229,den:12062755});
 for(const value of ['2','-3/2','3/2','1/0','-1/0','1.0001','-1.5','2/1','2147483648/1','1/2147483648'])expect(()=>parseAddroiQoffset(value),value).toThrow(/outside|ratio terms/);
 expect(()=>parseAddroiQoffset('0/0')).toThrow('Invalid addroi qoffset: NaN');expect(()=>parseAddroiQoffset('sin(1)')).toThrow('Unsupported addroi expression');
 // NaN is EINVAL in av_expr_parse_and_eval; malformed text fails to parse; unported functions and constants are outside the subset.
 for(const value of ['0/0','nan','','abc','1/','sin(1)','PI','0x1','1k','2^-1','ld(0)','1;0.5','1e400'])expect(()=>parseAddroiQoffset(value),value).toThrow(VideoFilterParseError);
});
it('bounds region expressions over every link size and refuses those that could evaluate to NaN or leave the subset',()=>{
 const sizes={iw:[1,2147483647],ih:[1,2147483647]} as const;
 expect(addroiExpressionRange('iw/2',sizes)).toEqual([0.5,1073741823.5]);expect(addroiExpressionRange('-iw+ih',sizes)).toEqual([-2147483646,2147483646]);expect(addroiExpressionRange(' 2 * ( iw - 1 ) ',sizes)).toEqual([0,4294967292]);
 expect(addroiExpressionRange('iw/(ih+0.5)',sizes)).toEqual([1/2147483647.5,2147483647/1.5]);expect(addroiExpressionRange('1-2-3',sizes)).toEqual([-4,-4]);expect(addroiExpressionRange('--1',sizes)).toEqual([1,1]);expect(addroiExpressionRange('iw*-1',sizes)).toEqual([-2147483647,-1]);
 for(const text of ['0/0','iw/(iw-iw)','iw/(ih-1)','1/(iw-2)','sin(1)','PI','1e400','iw*1e300*1e300','0x10','2k','2^3','ld(0)','1;2','st(0,1)','if(1,2,3)','iw iw','nan','inf','random(0)','hypot(3,4)','log(iw)','x','w','IW'])expect(()=>addroiExpressionRange(text,sizes),text).toThrow(VideoFilterParseError);
 // Sampled soundness: every native evaluation lies within the computed range.
 let seed=7;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 for(const text of ['iw/2','ih/2','iw/4','iw*2','iw-ih','(iw+3)/(ih+0.25)*-7','iw*ih/3','1/iw','-ih/(iw*2+1)']){
  const range=addroiExpressionRange(text,sizes),evaluate=compileExpression(text,{numericProfile:'linux-x64',constants:['iw','ih']});
  for(let n=0;n<200;n++){const width=n<4?[1,2147483647][n&1]!:1+next()%(n<100?64:2147483647),height=n<4?[1,2147483647][n>>1]!:1+next()%(n<100?64:2147483647),value=evaluate([width,height]);expect(value>=range[0]&&value<=range[1],`${text} ${width}x${height}`).toBe(true);}
 }
});
it('computes config_input regions with zero and maximum clamps and truncation, as native does',()=>{
 expect(addroiRegion(step('0:0:iw/2:ih/2:-1/5'),8,8)).toEqual({x:0,y:0,w:4,h:4});expect(addroiRegion(step('0:0:iw/2:ih/2'),5,3)).toEqual({x:0,y:0,w:2,h:1});
 expect(addroiRegion(step('x=iw/4:w=iw*2:qoffset=1'),8,6)).toEqual({x:2,y:0,w:6,h:0});expect(addroiRegion(step('x=iw/4:w=iw*2'),1,1)).toEqual({x:0,y:0,w:1,h:0});
 expect(addroiRegion(step('x=-5:y=ih*3:w=iw:h=-ih'),7,5)).toEqual({x:0,y:5,w:7,h:0});expect(addroiRegion(step('x=iw-0.5:y=0.999:w=9:h=ih'),17,9)).toEqual({x:16,y:0,w:1,h:9});
 expect(addroiRegion(step('clear=1'),2,2)).toEqual({x:0,y:0,w:0,h:0});expect(Object.isFrozen(addroiRegion(step(null),1,1))).toBe(true);
 for(const [width,height]of [[0,1],[1,0],[1.5,2],[2147483648,1]])expect(()=>addroiRegion(step(null),width!,height!)).toThrow('Invalid addroi input size');
});
it('refuses malformed, out-of-range and unimplemented addroi options with VideoFilterParseError before planning on every path',()=>{
 const source={geometry:{format:'gray',width:8,height:8},timeBase:time,frameRate:rate};
 const refused=['qoffset=2','qoffset=-3/2','qoffset=1/0','qoffset=0/0','qoffset=nan','qoffset=','qoffset=abc','x=iw/','x=','y=bogus','w=sin(1)','h=0/0','x=iw/(ih-1)','x='+'1+'.repeat(130)+'1','clear=auto','clear=2','clear=yes please','enable=1','enable=gte(t\\,1)','threads=1','foo=1','0:0:0:0:0:0:extra'];
 for(const options of refused)expect(()=>addroiOperator.parse!({name:'addroi',options} as never),options).toThrow();
 for(const options of refused.filter(options=>options!=='0:0:0:0:0:0:extra'))expect(()=>step(options),options).toThrow(VideoFilterParseError);
 for(const options of refused){
  const description=`addroi=${options}`;expect(()=>compileVideoFilterChain(description),description).toThrow(VideoFilterError);
  for(const check of [()=>compileVideoFilterGraph(`[0:v]${description}[o]`),()=>planTimedVideoGraph(description,[source],[null]),()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})])expect(check,description).toThrow();
 }
 expect(()=>compileVideoFilterChain('addroi=qoffset=2')).toThrow('value outside [-1,1]');expect(()=>compileVideoFilterChain('addroi=enable=1')).toThrow('Addroi has no timeline support');
 expect(()=>createReplayVideoExecution('[0:v]addroi=w=0/0[o]',[{geometry:source.geometry,timeBase:time,open:()=>{throw new Error('Unexpected open');}}],[null],{maxFrameBytes:256,maxStateBytes:256,maxResidentBytes:4096,maxSourceTraversals:2})).toThrow(VideoFilterParseError);
});
it('forwards the frame unchanged on the linear, graph and replay paths within budgets, strides and signals',async()=>{
 const frame=gray(0),before=snapshot(frame),plan=compileVideoFilterChain('addroi=0:0:iw/2:ih/2:-1/5').plan('gray',5,3);
 const output=plan.apply(frame,{maxFrameBytes:15,maxStateBytes:0});expect(snapshot(output)).toEqual(before);expect(snapshot(frame)).toEqual(before);
 expect(()=>plan.apply(frame,{maxFrameBytes:0,maxStateBytes:0})).toThrow('budget');expect(()=>plan.apply(gray(0,4,3),{maxFrameBytes:15,maxStateBytes:0})).toThrow('does not match configured graph input');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>plan.apply(frame,{maxFrameBytes:15,signal:controller.signal})).toThrow('stop');
 // Padded rows pass through addroi; hflip then reads them through the stride into owned tight planes.
 const padded=gray(1,5,3,8),paddedBefore=snapshot(padded),flipped=compileVideoFilterChain('addroi,hflip').plan('gray',5,3).apply(padded,{maxFrameBytes:64,maxStateBytes:0});
 expect([...flipped.planes[0]!]).toEqual([0,1,2].flatMap(row=>[...padded.planes[0]!.subarray(row*8,row*8+5)].reverse()));expect(flipped.planes[0]!.buffer).not.toBe(padded.planes[0]!.buffer);expect(snapshot(padded)).toEqual(paddedBefore);
 expect(()=>compileVideoFilterChain('addroi,hflip').plan('gray',5,3).apply(gray(1,5,3,4),{maxFrameBytes:64,maxStateBytes:0})).toThrow();
 const graph=compileVideoFilterGraph('[0:v]split[a][b];[a]addroi=clear=1[x];[b]addroi,addroi=1:1:1:1[y]').plan({format:'gray',width:5,height:3},[null,null]),outputs=graph.apply(frame,{maxFrameBytes:64,maxStateBytes:1<<16,maxResidentBytes:1<<16});
 expect(outputs.map(snapshot)).toEqual([before,before]);expect(snapshot(frame)).toEqual(before);
 const execution=createReplayVideoExecution('[0:v]addroi=x=iw/4:w=iw*2:qoffset=1[o]',[{geometry:{format:'gray',width:5,height:3},timeBase:time,async *open(signal){for(let n=0;n<3;n++){signal.throwIfAborted();yield gray(n);}}}],[null],{maxFrameBytes:64,maxStateBytes:64,maxResidentBytes:1<<16,maxSourceTraversals:2}),replayed:VideoFrameData[]=[];
 try{for await(const value of execution.outputs[0]!.frames)replayed.push(value);}finally{await execution.close();}
 expect(replayed.map(value=>[...value.planes[0]!])).toEqual([0,1,2].map(n=>[...gray(n).planes[0]!]));expect(replayed.map(value=>value.pts!.value)).toEqual([0,1,2].map(n=>gray(n).pts!.value));
});
it('forwards the frame unchanged through activation actors and the timed executor and refuses runtime commands',async()=>{
 const shape={format:'gray',width:5,height:3},frames=[0,1,2].map(n=>gray(n)),before=frames.map(snapshot);
 const actors=createFrameActors('addroi=0:0:iw/2:ih/2,addroi=clear=1',{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<16,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:rate,geometry:shape}]}),received:VideoFrameData[]=[];
 try{
  // vf_addroi.c has no process_command and no timeline flag: enable answers AVERROR_PATCHWELCOME and every other command ENOSYS.
  expect(actors.sendFilterCommand('addroi','enable','0').code).toBe(-1163346256);
  for(const [command,argument]of [['x','1'],['w','2'],['qoffset','0'],['clear','1'],['bogus','1']] as const)expect(actors.sendFilterCommand('addroi',command,argument).code,command).toBe(-38);
  for(const frame of frames)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame});actors.endInput(0,EOF,3n);
  for(let attempt=0;attempt<16;attempt++){const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);break;}received.push(result.event!.frame);}
 }finally{actors.dispose();}
 expect(received.map(snapshot)).toEqual(before);expect(frames.map(snapshot)).toEqual(before);
 const timed:VideoFrameData[]=[],source=()=>({async *[Symbol.asyncIterator]():AsyncGenerator<TimedVideoOutputEvent>{for(const frame of frames)yield {kind:'frame',frame,duration:1n};yield {kind:'end',status:'eof',pts:3n,rawPts:3n,inputPts:null,secondaryErrors:[]};}});
 await executeTimedGraph(planTimedVideoGraph('addroi=x=iw/4:w=iw*2:qoffset=1',[{geometry:shape,timeBase:time,frameRate:rate}],[null]),[source],memoryStore,{numericProfile:'linux-x64',maxFrameBytes:64,maxStateBytes:1<<16,arithmetic:'scalar',maxEvents:64,maxSyncResidentBytes:1<<16,maxOperatorSteps:4096,async frame(_output,event){timed.push(event.frame);}});
 expect(timed.map(value=>[...value.planes[0]!])).toEqual(before.map(value=>value.planes[0]));expect(frames.map(snapshot)).toEqual(before);
});
