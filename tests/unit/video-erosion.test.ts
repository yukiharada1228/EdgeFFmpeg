import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {erodeVideoFrame,erosionOperator,erosionPixelFormats,parseErosionOptions,VideoErosionError} from '../../packages/avfilter/src/video-ops/erosion.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const defaults=parseErosionOptions(null),time={num:1n,den:25n};
it('parses native defaults, shorthand order, ranges and integer expressions into frozen steps',()=>{
 expect(defaults).toEqual({name:'erosion',coordinates:255,thresholds:[65535,65535,65535,65535]});expect(Object.isFrozen(defaults)&&Object.isFrozen(defaults.thresholds)).toBe(true);expect(parseErosionOptions('')).toEqual(defaults);
 expect(parseErosionOptions('85:1:2:3:4')).toEqual({name:'erosion',coordinates:85,thresholds:[1,2,3,4]});expect(parseErosionOptions('0:10')).toEqual({name:'erosion',coordinates:0,thresholds:[10,65535,65535,65535]});
 expect(parseErosionOptions('threshold3=0:coordinates=1+2:threshold1=1.5:threshold2=2.5')).toEqual({name:'erosion',coordinates:3,thresholds:[65535,2,2,0]});
 expect(parseErosionOptions('coordinates=max:threshold0=min:threshold1=default').coordinates).toBe(255);expect(parseErosionOptions('coordinates=max:threshold0=min:threshold1=default').thresholds).toEqual([0,65535,65535,65535]);
 for(const options of ['coordinates=256','coordinates=-1','threshold0=65536','threshold2=-1','coordinates=','coordinates=abc','threshold0=1/0','enable=1','threads=1','foo=1','threshold4=1','0:1:2:3:4:5','threshold0=1:7'])expect(()=>parseErosionOptions(options),options).toThrow();
 expect(()=>parseErosionOptions('enable=gte(t,1)')).toThrow(VideoFilterParseError);expect(()=>parseErosionOptions('enable=1')).toThrow('timeline');expect(()=>parseErosionOptions('coordinates=256')).toThrow('Invalid erosion coordinates');
 expect(videoOperator('erosion')).toBe(erosionOperator);expect(erosionOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(erosionOperator.timeline).toBeUndefined();expect(erosionOperator.geometryCommands).toBeUndefined();
 expect(erosionPixelFormats).toEqual(['yuv420p','yuv422p','yuv444p','gray','yuva420p','gbrp']);expect(Object.isFrozen(erosionPixelFormats)).toBe(true);expect(erosionOperator.formats!(defaults)).toBe(erosionPixelFormats);
});
it('erodes with mirrored borders, clamped rows, coordinate masks and thresholds into owned tight planes',()=>{
 // 3x3 padded to stride 4; column 0 mirrors column 1 and the last column mirrors width-2.
 const input=Uint8Array.of(9,8,7,99,6,50,4,99,3,2,1,99),frame=gray(input,3,3,4),actual=erodeVideoFrame(frame,defaults,{maxFrameBytes:12});
 expect([...actual.planes[0]!]).toEqual([6,4,4,2,1,1,2,1,1]);expect(actual.linesizes).toEqual([3]);expect(actual.pts).toEqual(frame.pts);expect(actual.pts).not.toBe(frame.pts);expect(actual.metadata).toEqual({colorRange:2});expect([...input]).toEqual([9,8,7,99,6,50,4,99,3,2,1,99]);
 expect([...erodeVideoFrame(frame,parseErosionOptions('coordinates=0'),{maxFrameBytes:12}).planes[0]!]).toEqual([9,8,7,6,50,4,3,2,1]);
 expect([...erodeVideoFrame(frame,parseErosionOptions('coordinates=16'),{maxFrameBytes:12}).planes[0]!]).toEqual([8,7,7,6,4,4,2,1,1]);
 expect([...erodeVideoFrame(frame,parseErosionOptions('coordinates=8'),{maxFrameBytes:12}).planes[0]!]).toEqual([8,8,7,6,6,4,2,2,1]);
 expect([...erodeVideoFrame(frame,parseErosionOptions('threshold0=10'),{maxFrameBytes:12}).planes[0]!]).toEqual([6,4,4,2,40,1,2,1,1]);
 const copy=erodeVideoFrame(frame,parseErosionOptions('threshold0=0'),{maxFrameBytes:12});expect([...copy.planes[0]!]).toEqual([9,8,7,6,50,4,3,2,1]);expect(copy.planes[0]!.buffer).not.toBe(input.buffer);
 // One row: nh and ph both clamp to the current row.
 expect([...erodeVideoFrame(gray(Uint8Array.of(5,9,3),3,1),parseErosionOptions('coordinates=2'),{maxFrameBytes:3}).planes[0]!]).toEqual([5,9,3]);
 const yuva:VideoFrameData={width:2,height:2,pixelFormat:'yuva420p',planes:[Uint8Array.of(1,2,3,4),Uint8Array.of(7),Uint8Array.of(8),Uint8Array.of(9,1,5,6)],linesizes:[2,1,1,2],pts:null,metadata:{}};
 expect(()=>erodeVideoFrame(yuva,defaults,{maxFrameBytes:64})).toThrow('one pixel wide');
 const planar:VideoFrameData={width:2,height:2,pixelFormat:'gbrp',planes:[Uint8Array.of(4,3,2,1),Uint8Array.of(5,6,7,8),Uint8Array.of(9,9,1,9)],linesizes:[2,2,2],pts:null,metadata:{}},out=erodeVideoFrame(planar,parseErosionOptions('threshold0=1:threshold1=0'),{maxFrameBytes:12});
 expect(out.planes.map(plane=>[...plane])).toEqual([[3,2,1,1],[5,6,7,8],[1,1,1,1]]);expect(out.pts).toBeNull();
});
it('refuses one pixel wide planes, unsupported layouts, budgets, malformed storage, settings and cancellation explicitly',()=>{
 for(const [format,width,height]of [['gray',1,3],['yuv420p',2,2],['yuv420p',1,2],['yuv422p',2,3],['yuva420p',2,4],['yuv444p',1,1],['gbrp',1,4]] as const){
  expect(()=>erosionOperator.geometry!(defaults,[{format,width,height}]),format).toThrow(VideoErosionError);expect(()=>compileVideoFilterChain('erosion').plan(format,width,height),format).toThrow('one pixel wide');
 }
 expect(erosionOperator.geometry!(defaults,[{format:'yuv420p',width:3,height:1}])).toEqual({width:3,height:1});expect(()=>erosionOperator.geometry!(defaults,[])).toThrow('one input');
 for(const pixelFormat of ['nv12','rgb24','rgba','pal8'])expect(()=>erodeVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},defaults,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>erodeVideoFrame(gray(new Uint8Array(6),3,2),defaults,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>erodeVideoFrame(gray(new Uint8Array(8),3,2,4),defaults,{maxFrameBytes:7})).toThrow('storage exceeds');expect(()=>erodeVideoFrame(gray(new Uint8Array(6),3,2),defaults,{maxFrameBytes:0})).toThrow('allocation limit');
 expect(()=>erodeVideoFrame(gray(new Uint8Array(5),3,2),defaults,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>erodeVideoFrame(gray(new Uint8Array(6),3,2,2),defaults,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>erodeVideoFrame(gray(new Uint8Array(6),3,2,1.5),defaults,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>erodeVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},defaults,{maxFrameBytes:64})).toThrow('plane count');expect(()=>erodeVideoFrame({...gray(new Uint8Array(6),3,2),planes:[[0,0,0,0,0,0] as unknown as Uint8Array]},defaults,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>erodeVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},defaults,{maxFrameBytes:64})).toThrow('time base');
 for(const step of [{...defaults,coordinates:256},{...defaults,coordinates:0.5},{...defaults,thresholds:[1,2,3]},{...defaults,thresholds:[1,2,3,65536]}])expect(()=>erodeVideoFrame(gray(new Uint8Array(6),3,2),step as typeof defaults,{maxFrameBytes:64})).toThrow('Invalid erosion settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>erodeVideoFrame(gray(new Uint8Array(6),3,2),defaults,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 let rows=0;const late=new AbortController(),signal={throwIfAborted(){if(++rows===3)late.abort(new Error('late'));late.signal.throwIfAborted();}} as AbortSignal;expect(()=>erodeVideoFrame(gray(new Uint8Array(12),3,4),defaults,{maxFrameBytes:64,signal})).toThrow('late');
});
it('budgets linear and graph plans, negotiates native formats and refuses timeline and runtime commands',async()=>{
 const plan=compileVideoFilterChain('erosion,hflip,erosion=coordinates=0').plan('gray',5,3);expect(plan.stages.map(stage=>stage.operation)).toEqual(['erosion','hflip','erosion']);expect(plan.stateBytes).toBe(0);expect(plan.intermediateBytes).toBe(45);
 const frame=gray(Uint8Array.from({length:15},(_,i)=>i),5,3);expect([...plan.apply(frame,{maxFrameBytes:15,maxStateBytes:0}).planes[0]!]).toEqual([3,2,1,0,0,3,2,1,0,0,8,7,6,5,5]);expect(()=>plan.apply(frame,{maxFrameBytes:14,maxStateBytes:0})).toThrow('budget');
 const graph=compileVideoFilterGraph('[0:v]split[a][b];[a]erosion[x];[b]null[y]').plan({format:'nv12',width:5,height:3},['nv12','gray']);expect(graph.negotiated.nodes[1]!.inputs[0]!.format).toBe('yuv420p');
 expect(()=>compileVideoFilterGraph('[0:v]erosion[o]').plan({format:'rgb24',width:1,height:3},[null])).toThrow('one pixel wide');expect(()=>compileVideoFilterChain('erosion=enable=1')).toThrow();
 const actors=createFrameActors('erosion',{maxSteps:64,maxQueuedFrames:2,maxQueuedBytes:1<<12,maxFrameBytes:1<<12,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:{num:25n,den:1n},geometry:{format:'gray',width:3,height:3}}]});
 // Option commands are ENOSYS; the disabled timeline answers enable with AVERROR_PATCHWELCOME.
 try{for(const [command,argument]of [['threshold0','0'],['coordinates','0'],['w','2'],['x','1']] as const)expect(actors.sendFilterCommand('erosion',command,argument).code,command).toBe(-38);expect(actors.sendFilterCommand('erosion','enable','0').code).toBe(-1163346256);}finally{actors.dispose();}
 expect(()=>createFrameActors('erosion=enable=1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
});
