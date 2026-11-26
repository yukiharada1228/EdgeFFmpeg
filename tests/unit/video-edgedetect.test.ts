import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph,VideoFilterError} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {edgedetectOperator,parseEdgedetectOptions} from '../../packages/avfilter/src/video-ops/edgedetect.js';
import {edgedetectPixelFormats,edgedetectVideoFrame,VideoEdgedetectError} from '../../packages/avfilter/src/video-edgedetect.js';
import type {EdgedetectStep} from '../../packages/avfilter/src/video-edgedetect.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const step=(options:string|null)=>parseEdgedetectOptions(options);
it('parses high, low, mode and planes with native defaults, shorthand order, init rounding and last-wins keys',()=>{
 expect(step(null)).toEqual({name:'edgedetect',high:50/255,low:20/255,highU8:50,lowU8:20,mode:'wires',planes:7});expect(Object.isFrozen(step(''))).toBe(true);
 expect(step('0.3:0.1:canny:y')).toMatchObject({highU8:77,lowU8:26,mode:'canny',planes:1});
 // low_u8/high_u8 = (uint8_t)(x*255.+.5): 0.5/255 rounds up to 1, just below it truncates to 0; 1 gives 255.
 expect(step('high=1:low=0')).toMatchObject({highU8:255,lowU8:0});expect(step('low=0.5/255').lowU8).toBe(1);expect(step('low=0.49/255').lowU8).toBe(0);
 expect(step('high=50/255:low=(10+10)/255').highU8).toBe(50);expect(step('high=default*2').highU8).toBe(100);expect(step('low=max').lowU8).toBe(255);expect(step('high=1e-1').highU8).toBe(26);
 expect(step('high=0.1:high=0.2').highU8).toBe(51);
 for(const [value,mode]of [['wires','wires'],['colormix','colormix'],['canny','canny'],['0','wires'],['1','colormix'],['2','canny'],['canny-1','colormix']] as const)expect(step('mode='+value).mode,value).toBe(mode);
 // AV_OPT_TYPE_FLAGS: unit names and integers, +/- relative to the current value; the declared 1..7 range is not enforced.
 for(const [value,planes]of [['y',1],['u+v',6],['r',4],['g+b',3],['-y',6],['+y',7],['y+u-y',2],['0',0],['0x10',16],['8',8],['4294967295',-1]] as const)expect(step('planes='+value).planes,value).toBe(planes);
 expect(step('planes=y:planes=+v').planes).toBe(5);
 for(const options of ['enable=1','threads=1','foo=1','high=1.5','low=-0.1','high=','high=abc','high=sin(1)','high=2^-1','high=PI/4','high=0.5k','mode=3','mode=-1','mode=sobel','planes=','planes=w','planes=y+','planes=4294967296','planes=1.5'])expect(()=>step(options),options).toThrow(VideoFilterParseError);
 expect(()=>step('0.1:0.05:canny:y:9')).toThrow('Missing filter option name');
 expect(()=>step('foo=1')).toThrow('Unsupported edgedetect option');expect(()=>step('enable=1')).toThrow('timeline');expect(()=>step('high=1.5')).toThrow('outside [0 - 1]');expect(()=>step('high=sin(1)')).toThrow('Only arithmetic');expect(()=>step('mode=3')).toThrow('Invalid edgedetect mode');
 expect(edgedetectOperator.parse!({name:'edgedetect',options:'mode=canny'} as never).configuration.mode).toBe('canny');
});
it('declares the per-mode query_formats lists in declared order and keeps geometry',()=>{
 expect(edgedetectPixelFormats).toEqual({wires:['gray'],colormix:['gbrp','gray'],canny:['yuv420p','yuv422p','yuv444p','gbrp','gray']});
 for(const mode of ['wires','colormix','canny'] as const)expect(edgedetectOperator.formats!(step('mode='+mode))).toBe(edgedetectPixelFormats[mode]);
 expect(edgedetectOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(edgedetectOperator.timeline).toBeUndefined();expect(edgedetectOperator.geometryCommands).toBeUndefined();
 expect(edgedetectOperator.geometry!(step('mode=canny'),[{format:'yuv420p',width:1,height:1}])).toEqual({width:1,height:1});
 expect(()=>edgedetectOperator.geometry!(step(null),[{format:'yuv420p',width:4,height:3}])).toThrow('not supported');expect(()=>edgedetectOperator.geometry!(step('mode=colormix'),[{format:'yuv444p',width:4,height:3}])).toThrow('not supported');
});
it('runs blur, sobel, suppression and double threshold into owned tight planes, with colormix and unselected planes copied',()=>{
 // 3x3 step edge: the blur copies every row and column (none lies in [2, n-2)); the centre gradient is |gx|=1020, horizontal,
 // a maximum over its zero border neighbours, clipped to 255 and above high. Borders stay 0.
 const input=Uint8Array.of(0,0,255,9,0,0,255,9,0,0,255,9),frame=gray(input,3,3,4);
 const out=edgedetectVideoFrame(frame,step(null),{maxFrameBytes:12});
 expect([...out.planes[0]!]).toEqual([0,0,0,0,255,0,0,0,0]);expect(out.linesizes).toEqual([3]);expect(out.pts).toEqual(frame.pts);expect(out.pts).not.toBe(frame.pts);expect(out.metadata).toEqual({colorRange:2});
 expect([...input]).toEqual([0,0,255,9,0,0,255,9,0,0,255,9]);expect(out.planes[0]!.buffer).not.toBe(input.buffer);
 expect([...edgedetectVideoFrame(frame,step('mode=colormix'),{maxFrameBytes:12}).planes[0]!]).toEqual([0,0,127,0,127,127,0,0,127]);
 expect([...edgedetectVideoFrame(frame,step('high=1'),{maxFrameBytes:12}).planes[0]!]).toEqual([0,0,0,0,0,0,0,0,0]);
 expect([...edgedetectVideoFrame(frame,step('planes=0'),{maxFrameBytes:12}).planes[0]!]).toEqual([0,0,255,0,0,255,0,0,255]);
 // 1x1 and 2x2 planes have no interior: wires gives 0 and colormix halves the input.
 expect([...edgedetectVideoFrame(gray(Uint8Array.of(201),1,1),step(null),{maxFrameBytes:1}).planes[0]!]).toEqual([0]);
 expect([...edgedetectVideoFrame(gray(Uint8Array.of(201,3,40,255),2,2),step('mode=colormix'),{maxFrameBytes:4}).planes[0]!]).toEqual([100,1,20,127]);
 const yuv:VideoFrameData={width:2,height:2,pixelFormat:'yuv420p',planes:[Uint8Array.of(1,2,3,4),Uint8Array.of(7),Uint8Array.of(8)],linesizes:[2,1,1],pts:null,metadata:{}};
 expect(edgedetectVideoFrame(yuv,step('mode=canny:planes=u'),{maxFrameBytes:6}).planes.map(plane=>[...plane])).toEqual([[1,2,3,4],[0],[8]]);
});
it('rejects unsupported layouts, budgets, malformed storage, invalid settings and cancellation explicitly',()=>{
 const settings=step(null);
 for(const pixelFormat of ['yuv420p','nv12','rgb24','gbrp'])expect(()=>edgedetectVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},settings,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>edgedetectVideoFrame({width:2,height:2,pixelFormat:'yuva420p',planes:[],linesizes:[],pts:null,metadata:{}},step('mode=canny'),{maxFrameBytes:64})).toThrow(VideoEdgedetectError);
 expect(()=>edgedetectVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>edgedetectVideoFrame(gray(new Uint8Array(8),3,2,4),settings,{maxFrameBytes:7})).toThrow('storage exceeds');
 expect(()=>edgedetectVideoFrame(gray(new Uint8Array(5),3,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>edgedetectVideoFrame(gray(new Uint8Array(6),3,2,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>edgedetectVideoFrame(gray(new Uint8Array(6),3,2,2.5),settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>edgedetectVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},settings,{maxFrameBytes:64})).toThrow('plane count');
 expect(()=>edgedetectVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},settings,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{...settings,mode:'sobel'},{...settings,highU8:256},{...settings,lowU8:0.5},{...settings,planes:1.5},{...settings,name:'deflate'}])expect(()=>edgedetectVideoFrame(gray(new Uint8Array(6),3,2),bad as unknown as EdgedetectStep,{maxFrameBytes:64})).toThrow('Invalid edgedetect settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>edgedetectVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 let calls=0;const late={get aborted(){return false;},throwIfAborted(){if(++calls>2)throw new Error('late stop');}} as unknown as AbortSignal;expect(()=>edgedetectVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64,signal:late})).toThrow('late stop');
});
it('plans edgedetect on every path with per-mode negotiation and runtime commands refused',()=>{
 const plan=compileVideoFilterChain('edgedetect,hflip,edgedetect=mode=colormix').plan('gray',5,3);expect(plan.stages.map(stage=>stage.operation)).toEqual(['edgedetect','hflip','edgedetect']);expect(plan.stateBytes).toBe(0);
 const frame=gray(Uint8Array.from({length:15},(_,i)=>i*17),5,3);expect(()=>plan.apply(frame,{maxFrameBytes:14,maxStateBytes:0})).toThrow('budget');
 expect(compileVideoFilterChain('edgedetect').plan('yuv420p',4,4).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','gray'],['edgedetect','gray']]);
 expect(compileVideoFilterChain('edgedetect=mode=canny').plan('nv12',4,4).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv420p'],['edgedetect','yuv420p']]);
 expect(compileVideoFilterChain('edgedetect=mode=colormix').plan('rgb24',4,4).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','gbrp'],['edgedetect','gbrp']]);
 expect(()=>compileVideoFilterChain('edgedetect=mode=9').plan('gray',4,4)).toThrow(VideoFilterError);
 expect(compileVideoFilterGraph('[0:v]edgedetect=mode=canny[o]').plan({format:'yuv444p',width:1,height:1},[null])).toBeTruthy();
 expect(planTimedVideoGraph('edgedetect=mode=canny',[{geometry:{format:'gbrp',width:4,height:4},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}],[null]).nodes.length).toBeGreaterThan(0);
 for(const description of ['edgedetect=enable=1','edgedetect=foo=1'])expect(()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64}),description).toThrow();
});
