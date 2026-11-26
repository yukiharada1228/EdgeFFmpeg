import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution,planTimedVideoGraph,VideoFilterError,videoOperator} from '@edge-ffmpeg/avfilter';
import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {noformatOperator} from '../../packages/avfilter/src/video-ops/noformat.js';
import type {NoformatStep} from '../../packages/avfilter/src/video-ops/noformat.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {negotiableFormats,negotiationOrder} from '../../packages/avfilter/src/video-ops/formats.js';
import {FormatPixelFormatError} from '../../packages/avfilter/src/format-pixel-format.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {executeTimedGraph} from '../../packages/avformat/src/actor-video/execute.js';
import type {Store} from '../../packages/avformat/src/actor-video/spool/index.js';
const time={num:1n,den:25n},rate={num:25n,den:1n},EOF=-541478725;
const gray=(n:number,width=5,height=3,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[Uint8Array.from({length:stride*height},(_,i)=>(i*29+n*71+7)&255)],linesizes:[stride],pts:{value:9007199254740993n+BigInt(n),timeBase:time},metadata:{colorRange:2}});
const snapshot=(frame:VideoFrameData)=>({...frame,planes:frame.planes.map(plane=>[...plane])});
const memoryStore=():Store<TimedVideoOutputEvent>=>{const values=new Map<number,TimedVideoOutputEvent>();return {async append(index,value){values.set(index,value);},async read(index){const value=values.get(index);if(!value)throw new Error('Missing spool event');return value;},async discardBefore(index){for(const key of values.keys())if(key<index)values.delete(key);},async close(){values.clear();}};};
const parse=(options:string|null)=>noformatOperator.parse!({name:'noformat',options} as never).configuration as NoformatStep;
it('parses shorthand, named and numeric pixel format lists and inverts them over every negotiable format in AVPixelFormat order',()=>{
 expect(videoOperator('noformat')).toBe(noformatOperator);expect(noformatOperator.role).toBe('identity');expect(noformatOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
 for(const member of ['frame','geometry','validate','bypass','timeline','geometryCommands','jpegSiblings'] as const)expect((noformatOperator as unknown as Record<string,unknown>)[member],member).toBeUndefined();
 const pads=noformatOperator.parse!({name:'noformat',options:'yuv420p|rgb24'} as never);expect(pads.inputs).toBe(1);expect(pads.outputs).toBe(1);expect(Object.isFrozen(pads.configuration)).toBe(true);
 for(const [options,excluded]of [['yuv420p',['yuv420p']],['pix_fmts=yuv420p|rgb24',['yuv420p','rgb24']],['gray8|y8x',null],['0|2|71',['yuv420p','rgb24','gbrp']],['0x8',['gray']],['rgb32|bgr32',['bgra','rgba']],['nv21|pal8|monob|rgb0',['nv21','pal8','monob','rgb0']]] as const){
  if(excluded===null){expect(()=>parse(options),options).toThrow(FormatPixelFormatError);continue;}
  const step=parse(options);expect(step.excluded,options).toEqual(excluded);expect(Object.isFrozen(step.excluded)).toBe(true);
  const formats=noformatOperator.formats!(step);expect(formats,options).toEqual(negotiableFormats.filter(format=>!(excluded as readonly string[]).includes(format)));expect(formats.length).toBe(negotiableFormats.length-excluded.length);
 }
 // A bare noformat, an empty option string and pix_fmts= with an empty value: native invert_formats leaves NULL unrestricted, and strtol("") is yuv420p.
 for(const options of [null,''])expect(noformatOperator.formats!(parse(options))).toBe(negotiableFormats);
 expect(parse('pix_fmts=').excluded).toEqual(['yuv420p']);
 // The inverted list keeps the yuvj siblings, so a yuv420p source picks yuvj420p as native does.
 expect(noformatOperator.formats!(parse('yuv420p')).slice(0,14)).toEqual(['yuyv422','rgb24','bgr24','yuv422p','yuv444p','yuv410p','yuv411p','gray','monow','monob','pal8','yuvj420p','yuvj422p','yuvj444p']);
});
it('refuses duplicates, color options, enable=, unknown options and formats outside the declared layouts with explicit errors on every path',()=>{
 for(const options of ['gray|gray','yuv420p|0','rgb32|bgra'])expect(()=>parse(options),options).toThrow('Duplicated pixel format');
 for(const options of ['gray:color_spaces=bt709','color_ranges=pc','alpha_modes=straight','pix_fmts=gray:color_spaces=bt709','yuv420p:bt709','enable=1','threads=1','foo=1'])expect(()=>parse(options),options).toThrow(VideoFilterParseError);
 for(const options of ['yuvj420p','yuv420p10le','bogus','-1','999','yuv420p|bogus'])expect(()=>parse(options),options).toThrow(FormatPixelFormatError);
 const source={geometry:{format:'gray',width:8,height:8},timeBase:time,frameRate:rate};
 for(const description of ['noformat=gray|gray','noformat=color_ranges=pc','noformat=enable=1','null,noformat=yuvj420p']){
  expect(()=>compileVideoFilterChain(description),description).toThrow(VideoFilterError);
  for(const check of [()=>compileVideoFilterGraph(`[0:v]${description}[o]`),()=>planTimedVideoGraph(description,[source],[null]),()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})])expect(check,description).toThrow();
 }
 expect(()=>createReplayVideoExecution('[0:v]noformat=enable=1[o]',[{geometry:source.geometry,timeBase:time,open:()=>{throw new Error('Unexpected open');}}],[null],{maxFrameBytes:256,maxStateBytes:256,maxResidentBytes:4096,maxSourceTraversals:2})).toThrow(VideoFilterParseError);
});
it('negotiates as native does: an unlisted source passes, a listed one converts or is refused by name when the pick has no storage',()=>{
 // Every storage format passes through unchanged when it is not listed.
 for(const format of negotiationOrder){const other=format==='gray'?'yuv420p':'gray',plan=compileVideoFilterChain(`noformat=${other}`).plan(format,5,3);expect(plan.stages,format).toEqual([]);expect(plan.pixelFormat).toBe(format);
  expect(compileVideoFilterGraph(`[0:v]noformat=${other}[o]`).plan({format,width:5,height:3},[null]).negotiated.nodes[0]!.inputs[0]!.format,format).toBe(format);}
 // rgb24 listed: av_find_best_pix_fmt_of_2 picks bgr24, which converts here.
 expect(compileVideoFilterChain('noformat=rgb24').plan('rgb24',5,3).pixelFormat).toBe('bgr24');
 expect(compileVideoFilterGraph('[0:v]noformat=rgb24[o]').plan({format:'rgb24',width:5,height:3},[null]).negotiated.nodes[0]!.inputs[0]!.format).toBe('bgr24');
 // yuv420p listed: the pick is yuvj420p, a conversion into a legacy range format, refused on every path.
 expect(()=>compileVideoFilterChain('noformat=yuv420p').plan('yuv420p',5,3)).toThrow('negotiates yuvj420p, which is not implemented');
 expect(()=>compileVideoFilterGraph('[0:v]noformat=yuv420p[o]').plan({format:'yuv420p',width:5,height:3},[null])).toThrow('negotiates yuvj420p, which is not implemented');
 expect(()=>planTimedVideoGraph('noformat=yuv420p',[{geometry:{format:'yuv420p',width:5,height:3},timeBase:time,frameRate:rate}],[null])).toThrow('negotiates yuvj420p, which is not implemented');
 // gray listed: the pick is pal8, which has no storage here.
 expect(()=>compileVideoFilterChain('noformat=gray').plan('gray',5,3)).toThrow('negotiates pal8, which is not implemented');
 // Explicit format before noformat: the two lists meet in a converter.
 expect(compileVideoFilterChain('format=rgb24,noformat=rgb24').plan('gray',5,3).pixelFormat).toBe('bgr24');
});
it('forwards the frame unchanged on the linear, graph and replay paths within budgets, strides and signals',async()=>{
 const frame=gray(0),before=snapshot(frame),plan=compileVideoFilterChain('noformat=yuv420p').plan('gray',5,3);
 const output=plan.apply(frame,{maxFrameBytes:15,maxStateBytes:0});expect(snapshot(output)).toEqual(before);expect(snapshot(frame)).toEqual(before);
 expect(()=>plan.apply(frame,{maxFrameBytes:0,maxStateBytes:0})).toThrow('budget');expect(()=>plan.apply(gray(0,4,3),{maxFrameBytes:15,maxStateBytes:0})).toThrow('does not match configured graph input');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>plan.apply(frame,{maxFrameBytes:15,signal:controller.signal})).toThrow('stop');
 // Padded rows pass through; the next materializing operator reads them through the stride and returns owned tight planes.
 const padded=gray(1,5,3,8),paddedBefore=snapshot(padded),flipped=compileVideoFilterChain('noformat=rgb24,hflip').plan('gray',5,3).apply(padded,{maxFrameBytes:64,maxStateBytes:0});
 expect([...flipped.planes[0]!]).toEqual([0,1,2].flatMap(row=>[...padded.planes[0]!.subarray(row*8,row*8+5)].reverse()));expect(flipped.planes[0]!.buffer).not.toBe(padded.planes[0]!.buffer);expect(snapshot(padded)).toEqual(paddedBefore);
 expect(()=>compileVideoFilterChain('noformat=rgb24,hflip').plan('gray',5,3).apply(gray(1,5,3,4),{maxFrameBytes:64,maxStateBytes:0})).toThrow();
 const graph=compileVideoFilterGraph('[0:v]split[a][b];[a]noformat=nv12[x];[b]noformat=yuv420p|rgb24,noformat[y]').plan({format:'gray',width:5,height:3},[null,null]),outputs=graph.apply(frame,{maxFrameBytes:64,maxStateBytes:1<<16,maxResidentBytes:1<<16});
 expect(outputs.map(snapshot)).toEqual([before,before]);expect(snapshot(frame)).toEqual(before);
 const execution=createReplayVideoExecution('[0:v]noformat=yuv420p[o]',[{geometry:{format:'gray',width:5,height:3},timeBase:time,async *open(signal){for(let n=0;n<3;n++){signal.throwIfAborted();yield gray(n);}}}],[null],{maxFrameBytes:64,maxStateBytes:64,maxResidentBytes:1<<16,maxSourceTraversals:2}),replayed:VideoFrameData[]=[];
 try{for await(const value of execution.outputs[0]!.frames)replayed.push(value);}finally{await execution.close();}
 expect(replayed.map(value=>[...value.planes[0]!])).toEqual([0,1,2].map(n=>[...gray(n).planes[0]!]));expect(replayed.map(value=>value.pts!.value)).toEqual([0,1,2].map(n=>gray(n).pts!.value));
});
it('forwards the frame unchanged through activation actors and the timed executor and refuses runtime commands',async()=>{
 const shape={format:'gray',width:5,height:3},frames=[0,1,2].map(n=>gray(n)),before=frames.map(snapshot);
 const actors=createFrameActors('noformat=yuv420p,noformat=rgb24',{maxSteps:4096,maxQueuedFrames:8,maxQueuedBytes:1<<16,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:rate,geometry:shape}]}),received:VideoFrameData[]=[];
 try{
  // vf_format.c has no process_command and no timeline flag: enable answers AVERROR_PATCHWELCOME and every other command ENOSYS.
  expect(actors.sendFilterCommand('noformat','enable','0').code).toBe(-1163346256);
  for(const [command,argument]of [['w','2'],['pix_fmts','gray'],['bogus','1']] as const)expect(actors.sendFilterCommand('noformat',command,argument).code,command).toBe(-38);
  for(const frame of frames)actors.sendFrameInput(0,{kind:'frame',duration:1n,frame});actors.endInput(0,EOF,3n);
  for(let attempt=0;attempt<16;attempt++){const result=await actors.readFrame(0);if(result.code!==0){expect(result.code).toBe(EOF);break;}received.push(result.event!.frame);}
 }finally{actors.dispose();}
 expect(received.map(snapshot)).toEqual(before);expect(frames.map(snapshot)).toEqual(before);
 const timed:VideoFrameData[]=[],source=()=>({async *[Symbol.asyncIterator]():AsyncGenerator<TimedVideoOutputEvent>{for(const frame of frames)yield {kind:'frame',frame,duration:1n};yield {kind:'end',status:'eof',pts:3n,rawPts:3n,inputPts:null,secondaryErrors:[]};}});
 await executeTimedGraph(planTimedVideoGraph('noformat=yuv420p',[{geometry:shape,timeBase:time,frameRate:rate}],[null]),[source],memoryStore,{numericProfile:'linux-x64',maxFrameBytes:64,maxStateBytes:1<<16,arithmetic:'scalar',maxEvents:64,maxSyncResidentBytes:1<<16,maxOperatorSteps:4096,async frame(_output,event){timed.push(event.frame);}});
 expect(timed.map(value=>[...value.planes[0]!])).toEqual(before.map(value=>value.planes[0]));expect(frames.map(snapshot)).toEqual(before);
});
