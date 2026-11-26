import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {removeGrainVideoFrame,parseRemoveGrainOptions,removeGrainPixelFormats,removegrainOperator,VideoRemoveGrainError} from '../../packages/avfilter/src/video-ops/removegrain.js';
import {removeGrainModes,removeGrainSkips} from '../../packages/avfilter/src/video-removegrain.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const defaults=parseRemoveGrainOptions(null);
it('parses native defaults, shorthand order, ranges and integer expressions into frozen steps',()=>{
 expect(defaults).toEqual({name:'removegrain',modes:[0,0,0,0]});expect(Object.isFrozen(defaults)&&Object.isFrozen(defaults.modes)).toBe(true);expect(parseRemoveGrainOptions('')).toEqual(defaults);
 expect(parseRemoveGrainOptions('1:2:3:4').modes).toEqual([1,2,3,4]);expect(parseRemoveGrainOptions('17').modes).toEqual([17,0,0,0]);expect(parseRemoveGrainOptions('m3=24:m1=13').modes).toEqual([0,13,0,24]);
 expect(parseRemoveGrainOptions('m0=max:m1=min:m2=default:m3=10+2').modes).toEqual([24,0,0,12]);expect(parseRemoveGrainOptions('m0=2.5:m1=3.5:m2=0x10').modes).toEqual([2,4,16,0]);
 for(const options of ['m0=25','m0=-1','m3=100','m0=','m0=abc','m0=1/0','enable=1','threads=1','M0=1','m4=1','foo=1','1:2:3:4:5','m0=1:7'])expect(()=>parseRemoveGrainOptions(options),options).toThrow();
 expect(()=>parseRemoveGrainOptions('enable=gte(t,1)')).toThrow(VideoFilterParseError);expect(()=>parseRemoveGrainOptions('enable=1')).toThrow('timeline');expect(()=>parseRemoveGrainOptions('m2=25')).toThrow('Invalid removegrain m2');expect(()=>parseRemoveGrainOptions('mode=1')).toThrow('Unsupported removegrain option');
 expect(videoOperator('removegrain')).toBe(removegrainOperator);expect(removegrainOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(removegrainOperator.timeline).toBeUndefined();expect(removegrainOperator.geometryCommands).toBeUndefined();
 // The pinned vf_removegrain.c pix_fmts in declared order.
 expect(removeGrainPixelFormats).toEqual(['gray','yuv420p','yuv422p','yuv444p','yuva420p','yuva422p','yuva444p','yuv440p','yuv411p','yuv410p','yuvj411p','yuvj420p','yuvj422p','yuvj440p','yuvj444p','gbrp','gbrap']);
 expect(Object.isFrozen(removeGrainPixelFormats)).toBe(true);expect(removegrainOperator.formats!(defaults)).toBe(removeGrainPixelFormats);
});
it('ports every mode kernel exactly, with the native tie order and uint8 store',()=>{
 // Neighbours 10 20 30 / 40 c 50 / 60 70 80: c=200 sits above every axis, c=0 below every axis.
 const high=[200,10,20,30,40,50,60,70,80] as const,low=[0,10,20,30,40,50,60,70,80] as const;
 expect(removeGrainModes).toHaveLength(25);expect(removeGrainModes[0]).toBeNull();expect(removeGrainModes[11]).toBe(removeGrainModes[12]);expect(removeGrainModes[13]).toBe(removeGrainModes[14]);expect(removeGrainModes[15]).toBe(removeGrainModes[16]);
 expect(removeGrainModes.slice(1).map(mode=>mode!(...high))).toEqual([80,70,60,50,80,50,50,50,50,80,84,84,45,45,45,45,50,50,45,62,45,45,130,200]);
 expect(removeGrainModes.slice(1).map(mode=>mode!(...low))).toEqual([10,20,30,40,10,40,40,40,40,10,34,34,45,45,45,45,40,40,45,40,45,45,30,20]);
 // mode10 prefers a7, then a8, a6, a2, a3, a1, a5 and a4 on equal distances; mode05 prefers axis 4, then 2, 3 and 1.
 expect(removeGrainModes[10]!(100,90,90,90,90,90,90,110,90)).toBe(110);expect(removeGrainModes[10]!(100,110,90,110,110,110,110,90,90)).toBe(90);expect(removeGrainModes[10]!(100,110,120,120,120,90,120,120,120)).toBe(110);
 expect(removeGrainModes[5]!(100,0,40,0,90,90,0,40,0)).toBe(90);expect(removeGrainModes[5]!(100,0,90,10,0,0,10,90,0)).toBe(90);
 expect(removeGrainModes[20]!(255,255,255,255,255,255,255,255,255)).toBe(255);expect(removeGrainModes[19]!(0,255,255,255,255,255,255,255,255)).toBe(255);
});
it('copies borders, applies frame-wide skip rows across planes and returns owned tight planes without mutating input',()=>{
 // 3x3 padded to stride 4 with 99 padding that must never reach the output.
 const input=Uint8Array.of(10,20,30,99,40,200,50,99,60,70,80,99),frame=gray(input,3,3,4),actual=removeGrainVideoFrame(frame,parseRemoveGrainOptions('1'),{maxFrameBytes:12});
 expect([...actual.planes[0]!]).toEqual([10,20,30,40,80,50,60,70,80]);expect(actual.linesizes).toEqual([3]);expect(actual.pts).toEqual(frame.pts);expect(actual.pts).not.toBe(frame.pts);expect(actual.metadata).toEqual({colorRange:2});expect([...input]).toEqual([10,20,30,99,40,200,50,99,60,70,80,99]);
 const copy=removeGrainVideoFrame(frame,defaults,{maxFrameBytes:12});expect([...copy.planes[0]!]).toEqual([10,20,30,40,200,50,60,70,80]);expect(copy.planes[0]!.buffer).not.toBe(input.buffer);
 // Mode 13 skips odd rows (row 1 is copied), mode 14 skips even rows (row 1 is filtered).
 expect(removeGrainVideoFrame(frame,parseRemoveGrainOptions('13'),{maxFrameBytes:12}).planes[0]![4]).toBe(200);expect(removeGrainVideoFrame(frame,parseRemoveGrainOptions('14'),{maxFrameBytes:12}).planes[0]![4]).toBe(45);
 expect(removeGrainVideoFrame(frame,parseRemoveGrainOptions('15'),{maxFrameBytes:12}).planes[0]![4]).toBe(200);expect(removeGrainVideoFrame(frame,parseRemoveGrainOptions('16'),{maxFrameBytes:12}).planes[0]![4]).toBe(45);
 // gray has one plane: m1..m3 never set a skip flag.
 expect(removeGrainVideoFrame(frame,parseRemoveGrainOptions('1:13:15:13'),{maxFrameBytes:12}).planes[0]![4]).toBe(80);
 expect(removeGrainSkips([1,13,0,0],3)).toEqual({odd:true,even:false});expect(removeGrainSkips([1,0,0,14],3)).toEqual({odd:false,even:false});expect(removeGrainSkips([16,15,0,0],1)).toEqual({odd:false,even:true});expect(removeGrainSkips([0,0,0,16],4)).toEqual({odd:false,even:true});
 // A mode-13 chroma plane copies the filtered rows of luma too; mode-0 planes are always copied.
 const planes=[Uint8Array.of(10,20,30,40,200,50,60,70,80),Uint8Array.of(10,20,30,40,0,50,60,70,80),Uint8Array.of(1,2,3,4,250,6,7,8,9)];
 const yuv=(modes:string)=>removeGrainVideoFrame({width:3,height:3,pixelFormat:'yuv444p',planes,linesizes:[3,3,3],pts:null,metadata:{}},parseRemoveGrainOptions(modes),{maxFrameBytes:27}).planes.map(plane=>plane[4]);
 expect(yuv('1:1:1')).toEqual([80,10,9]);expect(yuv('1:13:1')).toEqual([200,0,250]);expect(yuv('1:14:0')).toEqual([80,45,250]);expect(yuv('1:1:1:13')).toEqual([80,10,9]);
 // One and two sample wide or tall planes are copies.
 for(const [width,height]of [[1,1],[1,3],[3,1],[2,2],[2,5],[5,2]] as const){const data=Uint8Array.from({length:width*height},(_,i)=>i*37&255);expect([...removeGrainVideoFrame(gray(data,width,height),parseRemoveGrainOptions('24'),{maxFrameBytes:64}).planes[0]!],`${width}x${height}`).toEqual([...data]);}
 // Interior columns of a 3-wide plane only: column 0 and 2 copied.
 expect([...removeGrainVideoFrame(gray(Uint8Array.of(0,0,0,9,255,9,0,0,0,7,7,7),3,4),parseRemoveGrainOptions('4'),{maxFrameBytes:12}).planes[0]!]).toEqual([0,0,0,9,0,9,0,7,0,7,7,7]);
 const yuva:VideoFrameData={width:3,height:3,pixelFormat:'yuva420p',planes:[Uint8Array.of(10,20,30,40,200,50,60,70,80),Uint8Array.of(7,8,9,1),Uint8Array.of(8,7,6,5),Uint8Array.of(10,20,30,40,0,50,60,70,80)],linesizes:[3,2,2,3],pts:null,metadata:{}};
 const out=removeGrainVideoFrame(yuva,parseRemoveGrainOptions('1:1:1:23'),{maxFrameBytes:64});expect(out.planes.map(plane=>[...plane])).toEqual([[10,20,30,40,80,50,60,70,80],[7,8,9,1],[8,7,6,5],[10,20,30,40,30,50,60,70,80]]);expect(out.pts).toBeNull();
});
it('refuses unsupported layouts, budgets, malformed storage, settings and cancellation explicitly',()=>{
 for(const pixelFormat of ['nv12','nv21','rgb24','rgba','pal8'])expect(()=>removeGrainVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},defaults,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>removeGrainVideoFrame(gray(new Uint8Array(6),3,2),defaults,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>removeGrainVideoFrame(gray(new Uint8Array(8),3,2,4),defaults,{maxFrameBytes:7})).toThrow('storage exceeds');expect(()=>removeGrainVideoFrame(gray(new Uint8Array(6),3,2),defaults,{maxFrameBytes:0})).toThrow('allocation limit');
 expect(()=>removeGrainVideoFrame(gray(new Uint8Array(5),3,2),defaults,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>removeGrainVideoFrame(gray(new Uint8Array(6),3,2,2),defaults,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>removeGrainVideoFrame(gray(new Uint8Array(6),3,2,1.5),defaults,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>removeGrainVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},defaults,{maxFrameBytes:64})).toThrow('plane count');expect(()=>removeGrainVideoFrame({...gray(new Uint8Array(6),3,2),planes:[[0,0,0,0,0,0] as unknown as Uint8Array]},defaults,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>removeGrainVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},defaults,{maxFrameBytes:64})).toThrow('time base');
 for(const modes of [[25,0,0,0],[0,-1,0,0],[1.5,0,0,0],[1,2,3]])expect(()=>removeGrainVideoFrame(gray(new Uint8Array(6),3,2),{name:'removegrain',modes} as unknown as typeof defaults,{maxFrameBytes:64}),JSON.stringify(modes)).toThrow(VideoRemoveGrainError);
 expect(()=>removegrainOperator.geometry!({name:'removegrain',modes:[30,0,0,0]} as unknown as typeof defaults,[{format:'gray',width:3,height:3}])).toThrow('Invalid removegrain settings');expect(()=>removegrainOperator.geometry!(defaults,[])).toThrow('one input');
 expect(removegrainOperator.geometry!(defaults,[{format:'yuv420p',width:1,height:1}])).toEqual({width:1,height:1});expect(()=>removegrainOperator.geometry!(defaults,[{format:'gbrap',width:3,height:3}])).toThrow();
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>removeGrainVideoFrame(gray(new Uint8Array(6),3,2),defaults,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 let rows=0;const late=new AbortController(),signal={throwIfAborted(){if(++rows===3)late.abort(new Error('late'));late.signal.throwIfAborted();}} as AbortSignal;expect(()=>removeGrainVideoFrame(gray(new Uint8Array(12),3,4),parseRemoveGrainOptions('1'),{maxFrameBytes:64,signal})).toThrow('late');
});
it('plans removegrain as a size-preserving stage and refuses gbrap picks, enable= and runtime commands',()=>{
 const plan=compileVideoFilterChain('removegrain=1,hflip,removegrain').plan('gray',5,3);expect(plan.stages.map(stage=>stage.operation)).toEqual(['removegrain','hflip','removegrain']);expect(plan.stateBytes).toBe(0);expect(plan.pixelFormat).toBe('gray');expect(plan.intermediateBytes).toBe(45);
 const frame=gray(Uint8Array.from({length:15},(_,i)=>i*10),5,3),output=plan.apply(frame,{maxFrameBytes:15,maxStateBytes:0});expect(output.planes[0]!).toHaveLength(15);expect(()=>plan.apply(frame,{maxFrameBytes:14,maxStateBytes:0})).toThrow('budget');
 expect(compileVideoFilterChain('removegrain').plan('nv12',5,3).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv420p'],['removegrain','yuv420p']]);
 const graph=compileVideoFilterGraph('[0:v]split[a][b];[a]removegrain=4[x];[b]null[y]').plan({format:'nv12',width:5,height:3},['nv12','gray']);expect(graph.negotiated.nodes[1]!.inputs[0]!.format).toBe('yuv420p');
 // Native converts packed RGB with alpha to gbrap (tests/differential/video-removegrain.test.ts), which has no frame storage here.
 for(const source of ['rgba','abgr'])expect(()=>compileVideoFilterChain('removegrain').plan(source,5,3),source).toThrow('Video filter removegrain input negotiates gbrap, which is not implemented');
 expect(()=>compileVideoFilterChain('removegrain=enable=1')).toThrow();expect(()=>createFrameActors('removegrain=enable=1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
 const live=createFrameActors('removegrain',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64,maxFrameBytes:64,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry:{format:'gray',width:3,height:3}}]});
 // Option commands are ENOSYS, as natively (no process_command); the disabled timeline answers enable with AVERROR_PATCHWELCOME.
 try{for(const [command,argument,code]of [['m0','1',-38],['m3','24',-38],['w','4',-38],['enable','0',-1163346256]] as const)expect(live.sendFilterCommand('removegrain',command,argument).code,command).toBe(code);}finally{live.dispose();}
});
