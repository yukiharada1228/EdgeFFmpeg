import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {fillbordersVideoFrame,parseFillbordersOptions,parseFillbordersColor,fillbordersPlanes,fillbordersPixelFormats,VideoFillbordersError} from '../../packages/avfilter/src/video-fillborders.js';
import {fillbordersOperator} from '../../packages/avfilter/src/video-ops/fillborders.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const settings=(options:string|null)=>parseFillbordersOptions(options);
it('parses declared defaults, shorthand, modes and colours into frozen settings',()=>{
 expect(settings(null)).toEqual({left:0,right:0,top:0,bottom:0,mode:'smear',color:[0,0,0,255]});expect(Object.isFrozen(settings(''))).toBe(true);expect(Object.isFrozen(settings(null).color)).toBe(true);
 expect(settings('1:2:3:4:mirror:0x102030')).toEqual({left:1,right:2,top:3,bottom:4,mode:'mirror',color:[16,32,48,255]});
 expect(settings('left=5:left=6:mode=6:bottom=007').left).toBe(6);expect(settings('mode=6').mode).toBe('margins');expect(settings('mode=2').mode).toBe('fixed');expect(settings('top=2147483647').top).toBe(2147483647);
 for(const [color,rgba]of [['black',[0,0,0,255]],['0xff8000',[255,128,0,255]],['#FF8000',[255,128,0,255]],['0x11223344',[17,34,51,68]],['#11223344',[17,34,51,68]],['0x112233@0x80',[17,34,51,128]],['#112233@0.5',[17,34,51,127]],['black@1',[0,0,0,255]],['0x11223344@0',[17,34,51,0]],['black@.25',[0,0,0,63]]] as const)expect(parseFillbordersColor(color),color).toEqual(rgba);
 for(const options of ['left=-1','left=1.5','left=1e1','left=+1','left=2147483648','left=w','mode=7','mode=Smear','mode=smear+mirror','color=red','color=random','color=bikeshed','color=ff0000','color=0xff00','color=0Xff0000','color=#ff0000@2','color=#ff0000@0x100','color=#ff0000@','color=black@-0','enable=1','threads=1','foo=1','1:2:3:4:smear:black:9'])expect(()=>settings(options),options).toThrow();
 expect(()=>settings('enable=1')).toThrow(VideoFillbordersError);expect(()=>settings('enable=1')).toThrow('timeline');expect(()=>settings('color=red')).toThrow('fillborders colors');
});
it('applies native border checks, chroma shifts and fill colours per negotiated format',()=>{
 for(const [options,width] of [['left=5',9],['right=5',9],['left=5:right=6',10],['left=6',11],['top=4',9],['bottom=4',9],['top=3:bottom=3',6]] as const)expect(()=>fillbordersPlanes('gray',width,7-(options==='top=3:bottom=3'?2:0),settings(options)),options).toThrow('Borders are bigger than input frame size.');
 expect(fillbordersPlanes('gray',9,7,settings('4:4:3:3')).length).toBe(1);
 const planes=fillbordersPlanes('yuv420p',9,7,settings('3:2:3:1:fixed:0xff0000'));expect(planes.map(p=>[p.width,p.height,p.left,p.right,p.top,p.bottom,p.fill])).toEqual([[9,7,3,2,3,1,81],[5,4,1,1,1,0,90],[5,4,1,1,1,0,240]]);
 expect(fillbordersPlanes('yuv422p',9,7,settings('3:3:3:3')).map(p=>[p.width,p.height,p.left,p.top])).toEqual([[9,7,3,3],[5,7,1,3],[5,7,1,3]]);
 expect(fillbordersPlanes('gbrp',4,4,settings('color=0x102030')).map(p=>p.fill)).toEqual([32,48,16]);expect(fillbordersPlanes('yuva420p',4,4,settings('color=0x10203040')).map(p=>p.fill)).toEqual([translateY(16,32,48),fillbordersPlanes('yuv420p',4,4,settings('color=0x102030'))[1]!.fill,fillbordersPlanes('yuv420p',4,4,settings('color=0x102030'))[2]!.fill,64]);
 expect(fillbordersPlanes('yuv444p',4,4,settings(null)).map(p=>p.fill)).toEqual([16,128,128]);
 expect(()=>fillbordersPlanes('gray',8,8,settings('4:0:0:0:reflect'))).toThrow('reflect');expect(()=>fillbordersPlanes('gray',8,8,settings('0:0:0:4:reflect'))).toThrow('reflect');expect(fillbordersPlanes('gray',8,8,settings('3:3:3:3:reflect')).length).toBe(1);
 expect(()=>fillbordersPlanes('yuv420p',14,8,settings('mode=margins'))).toThrow('margins');expect(fillbordersPlanes('yuv420p',16,8,settings('mode=margins')).length).toBe(3);expect(()=>fillbordersPlanes('gray',7,8,settings('mode=margins'))).toThrow('margins');
 for(const format of ['nv12','rgba','rgb24','pal8'])expect(()=>fillbordersPlanes(format,8,8,settings(null)),format).toThrow('not supported');expect(Object.isFrozen(fillbordersPixelFormats)).toBe(true);
 expect(()=>fillbordersPlanes('gray',8,8,{...settings(null),left:0.5})).toThrow('Invalid fillborders settings');
});
function translateY(r:number,g:number,b:number){const fix=(x:number)=>Math.trunc(x*1024+0.5);return fix(0.299*219/255)*r+fix(0.587*219/255)*g+fix(0.114*219/255)*b+(512+(16<<10))>>10;}
it('materializes owned tight planes for every mode from padded input without mutating it',()=>{
 const input=Uint8Array.from({length:4*5},(_,i)=>i%5===4?99:i*7),snapshot=[...input],frame=gray(input,4,4,5);
 const rows=(frame:VideoFrameData)=>Array.from({length:frame.height},(_,y)=>[...frame.planes[0]!.subarray(y*frame.width,(y+1)*frame.width)]);
 expect(rows(fillbordersVideoFrame(frame,settings('1:1:1:1'),{maxFrameBytes:20}))).toEqual([[42,42,49,49],[42,42,49,49],[77,77,84,84],[77,77,84,84]]);
 expect(rows(fillbordersVideoFrame(frame,settings('1:1:1:1:mirror'),{maxFrameBytes:20}))).toEqual([[42,42,49,49],[42,42,49,49],[77,77,84,84],[77,77,84,84]]);
 expect(rows(fillbordersVideoFrame(frame,settings('1:1:1:1:fixed:0xffffff'),{maxFrameBytes:20}))).toEqual([[235,235,235,235],[235,42,49,235],[235,77,84,235],[235,235,235,235]]);
 expect(rows(fillbordersVideoFrame(frame,settings('1:1:1:1:reflect'),{maxFrameBytes:20}))).toEqual([[84,77,84,77],[49,42,49,42],[84,77,84,77],[49,42,49,42]]);
 expect(rows(fillbordersVideoFrame(frame,settings('1:1:1:1:wrap'),{maxFrameBytes:20}))).toEqual([[84,77,84,77],[49,42,49,42],[84,77,84,77],[49,42,49,42]]);
 expect(rows(fillbordersVideoFrame(frame,settings('1:0:0:0:fade:0xffffff'),{maxFrameBytes:20}))).toEqual([[235,7,14,21],[235,42,49,56],[235,77,84,91],[235,112,119,126]]);
 const wide=fillbordersVideoFrame(gray(Uint8Array.from({length:30},(_,i)=>i*8),10,3),settings('1:1:1:0:margins'),{maxFrameBytes:30});expect(rows(wide)[0]).toEqual([88,91,96,104,112,120,128,136,144,144]);
 const none=fillbordersVideoFrame(frame,settings(null),{maxFrameBytes:20});expect(rows(none)).toEqual([[0,7,14,21],[35,42,49,56],[70,77,84,91],[105,112,119,126]]);
 expect(none.linesizes).toEqual([4]);expect(none.pts).toEqual(frame.pts);expect(none.pts).not.toBe(frame.pts);expect(none.metadata).toEqual({colorRange:2});expect(none.planes[0]!.buffer).not.toBe(input.buffer);expect([...input]).toEqual(snapshot);
 const yuva=fillbordersVideoFrame({width:2,height:2,pixelFormat:'yuva420p',planes:[Uint8Array.of(1,2,3,4),Uint8Array.of(5),Uint8Array.of(6),Uint8Array.of(7,8,9,10)],linesizes:[2,1,1,2],pts:null,metadata:{}},settings('1:0:0:0:fixed:0x00000040'),{maxFrameBytes:20});expect(yuva.planes.map(plane=>[...plane])).toEqual([[16,2,16,4],[5],[6],[64,8,64,10]]);expect(yuva.pts).toBeNull();
});
it('rejects unsupported layouts, budgets, malformed storage, time bases and cancellation explicitly',()=>{
 const s=settings('1:1:1:1');
 expect(()=>fillbordersVideoFrame({width:2,height:2,pixelFormat:'nv12',planes:[new Uint8Array(4),new Uint8Array(2)],linesizes:[2,2],pts:null,metadata:{}},s,{maxFrameBytes:64})).toThrow('not supported');
 expect(()=>fillbordersVideoFrame(gray(new Uint8Array(4),2,2),settings('2:0:0:0'),{maxFrameBytes:64})).toThrow('Borders are bigger');
 expect(()=>fillbordersVideoFrame(gray(new Uint8Array(6),3,2),s,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>fillbordersVideoFrame(gray(new Uint8Array(8),3,2,4),s,{maxFrameBytes:7})).toThrow('storage exceeds');
 expect(()=>fillbordersVideoFrame(gray(new Uint8Array(5),3,2),s,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>fillbordersVideoFrame(gray(new Uint8Array(6),3,2,2),s,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>fillbordersVideoFrame(gray(new Uint8Array(6),3,2,1.5),s,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>fillbordersVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},s,{maxFrameBytes:64})).toThrow('plane count');
 expect(()=>fillbordersVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},s,{maxFrameBytes:64})).toThrow('time base');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>fillbordersVideoFrame(gray(new Uint8Array(6),3,2),s,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans fillborders on every flagged path and refuses size-dependent borders before output',async()=>{
 expect(fillbordersOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(fillbordersOperator.formats!({name:'fillborders'} as never)).toEqual(['yuv420p','yuv422p','yuv444p','gray','yuva420p','gbrp'].filter(format=>fillbordersOperator.formats!({name:'fillborders'} as never).includes(format)));
 const plan=compileVideoFilterChain('fillborders=1:1:1:1:fixed:0xffffff').plan('gray',4,4),frame=gray(Uint8Array.from({length:16},(_,i)=>i),4,4);expect(plan.stages.map(stage=>[stage.operation,stage.pixelFormat])).toEqual([['fillborders','gray']]);
 expect([...plan.apply(frame,{maxFrameBytes:16,maxStateBytes:0}).planes[0]!]).toEqual([235,235,235,235,235,5,6,235,235,9,10,235,235,235,235,235]);
 expect(compileVideoFilterChain('fillborders').plan('nv12',4,4).stages[0]!.pixelFormat).toBe('yuv420p');expect(compileVideoFilterChain('fillborders').plan('rgba',4,4).stages[0]!.pixelFormat).toBe('yuva420p');expect(compileVideoFilterChain('fillborders').plan('rgb24',4,4).stages[0]!.pixelFormat).toBe('gbrp');
 expect(()=>compileVideoFilterChain('fillborders=left=3').plan('gray',4,4)).toThrow('Borders are bigger than input frame size.');expect(()=>compileVideoFilterChain('fillborders=mode=margins').plan('gray',4,4)).toThrow('margins');
 expect(()=>compileVideoFilterGraph('[0:v]fillborders=top=3[out]').plan({format:'gray',width:4,height:4},[null])).toThrow('Borders are bigger');
 for(const description of ['fillborders=enable=1','fillborders=color=red','fillborders=mode=bogus'])expect(()=>compileVideoFilterChain(description),description).toThrow();
 const execution=createReplayVideoExecution('[in]fillborders=1:1:1:1:wrap[out]',[{geometry:{format:'gray',width:4,height:4},timeBase:{num:1n,den:25n},async *open(){yield frame;}}],[null],{maxFrameBytes:64,maxStateBytes:1<<16,maxResidentBytes:1<<20,maxSourceTraversals:4},{arithmetic:'scalar'});
 const frames:VideoFrameData[]=[];try{for await(const output of execution.outputs[0]!.frames)frames.push(output);}finally{await execution.close();}expect([...frames[0]!.planes[0]!]).toEqual([10,9,10,9,6,5,6,5,10,9,10,9,6,5,6,5]);
 expect(()=>createFrameActors('fillborders=enable=1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow();
});
