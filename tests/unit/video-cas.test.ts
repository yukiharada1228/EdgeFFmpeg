import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph,VideoFilterError} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {casOperator,casPixelFormats,casSample,casStrength,casVideoFrame,parseCasOptions,VideoCasError} from '../../packages/avfilter/src/video-ops/cas.js';
import type {CasStep} from '../../packages/avfilter/src/video-ops/cas.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const step=(options:string|null)=>parseCasOptions(options);
it('parses strength and planes in AVOption order with native defaults, float storage and flag arithmetic',()=>{
 expect(step(null)).toEqual({name:'cas',strength:0,planes:7});expect(Object.isFrozen(step(''))).toBe(true);
 expect(step('0.5')).toEqual({name:'cas',strength:0.5,planes:7});expect(step('1:3')).toEqual({name:'cas',strength:1,planes:3});expect(step('planes=0:strength=.25')).toEqual({name:'cas',strength:0.25,planes:0});
 // AV_OPT_TYPE_FLOAT stores the float nearest the double.
 expect(step('0.3').strength).toBe(Math.fround(0.3));expect(step('3e-1').strength).toBe(Math.fround(0.3));expect(step('strength=0.1:strength=1').strength).toBe(1);
 // AV_OPT_TYPE_FLAGS: hexadecimal, +/- terms against the current value and no range check, as write_number skips it for flags.
 expect(step('planes=0x6').planes).toBe(6);expect(step('planes=-1').planes).toBe(6);expect(step('planes=+8').planes).toBe(15);expect(step('planes=0x2+8').planes).toBe(10);expect(step('planes=255').planes).toBe(255);expect(step('planes=4294967295').planes).toBe(-1);
 for(const options of ['strength=1.5','strength=-0.1','strength=1.0000001','strength=1/2','strength=max','strength=default','strength=','strength=abc','strength=nan','planes=0.5','planes=','planes=a','planes=4294967296','threads=2','foo=1','enable=1','strength=0.5:enable=gt(t\\,1)'])expect(()=>step(options),options).toThrow(VideoFilterParseError);
 expect(()=>step('0.5:3:1')).toThrow();expect(()=>step('enable=1')).toThrow('timeline');expect(()=>step('strength=2')).toThrow('outside [0 - 1]');expect(()=>step('strength=1/2')).toThrow('Only decimal');expect(()=>step('foo=1')).toThrow('Unsupported cas option');
 expect(casOperator.parse!({name:'cas',options:'0.5:1'} as never).configuration).toEqual({name:'cas',strength:0.5,planes:1});
});
it('declares the native pixel_fmts in declared order and keeps geometry for every size',()=>{
 expect(casPixelFormats).toEqual('gray gray9le gray10le gray12le gray14le gray16le yuv410p yuv411p yuv420p yuv422p yuv440p yuv444p yuvj420p yuvj422p yuvj440p yuvj444p yuvj411p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv440p10le yuv444p12le yuv422p12le yuv420p12le yuv440p12le yuv444p14le yuv422p14le yuv420p14le yuv420p16le yuv422p16le yuv444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le yuva420p yuva422p yuva444p yuva444p9le yuva444p10le yuva444p12le yuva444p16le yuva422p9le yuva422p10le yuva422p12le yuva422p16le yuva420p9le yuva420p10le yuva420p16le gbrap gbrap10le gbrap12le gbrap16le'.split(' '));
 expect(Object.isFrozen(casPixelFormats)).toBe(true);expect(casOperator.formats!(step(null))).toBe(casPixelFormats);expect(casOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
 for(const format of ['gray','yuv420p','yuv422p','yuv444p','yuva420p','gbrp'])for(const [width,height]of [[1,1],[2,1],[9,7]] as const)expect(casOperator.geometry!(step(null),[{format,width,height}])).toEqual({width,height});
 for(const format of ['rgb24','nv12','rgba'])expect(()=>casOperator.geometry!(step(null),[{format,width:4,height:3}]),format).toThrow('not supported');
 // gbrap is in the native list but has no layout here.
 expect(()=>casOperator.geometry!(step(null),[{format:'gbrap',width:4,height:3}])).toThrow('Unsupported video pixel format');
});
it('computes cas_slice8 in single precision with truncation, clipping and the all-zero neighbourhood',()=>{
 expect(casStrength(0)).toBe(-16);expect(casStrength(1)).toBe(-Math.fround(16+Math.fround(Math.fround(4.01)-16)));expect(casStrength(Math.fround(0.5))).toBe(-Math.fround(16+Math.fround(Math.fround(Math.fround(4.01)-16)*0.5)));
 // A flat neighbourhood is unchanged; an all-zero one gives 0 (FFMIN(FFMAX(NaN,0),1) is 0) instead of NaN.
 expect(casSample(9,9,9,9,9,9,9,9,9,-16)).toBe(9);expect(casSample(0,0,0,0,0,0,0,0,0,-16)).toBe(0);expect(casSample(0,0,0,0,0,0,0,0,0,casStrength(1))).toBe(0);
 // A bright centre is sharpened upward and clipped to 255, a dark one downward to 0.
 expect(casSample(100,100,100,100,200,100,100,100,100,casStrength(1))).toBe(255);expect(casSample(200,200,200,200,10,200,200,200,200,casStrength(1))).toBe(0);
 // mn=30+20, mx=50+50: amp=sqrt(50/100), weight=amp/-16, then (4*50*w+30)/(1+4w)=25.70 truncated toward zero (lrintf would give 26).
 const F=Math.fround,amp=F(Math.sqrt(F(50/100))),w=F(amp/-16),expected=Math.trunc(F(F(F(200*w)+30)/F(1+F(4*w))));
 expect(casSample(20,50,20,50,30,50,20,50,20,-16)).toBe(expected);expect(expected).toBe(25);
});
it('sharpens selected planes with clamped borders and copies the others into owned tight planes',()=>{
 const input=Uint8Array.of(10,10,10,99,10,200,10,99,10,10,10,99),frame=gray(input,3,3,4);
 const out=casVideoFrame(frame,step('1'),{maxFrameBytes:12});
 expect(out.linesizes).toEqual([3]);expect(out.pts).toEqual(frame.pts);expect(out.pts).not.toBe(frame.pts);expect(out.metadata).toEqual({colorRange:2});expect(out.planes[0]![4]).toBe(254);
 expect([...input]).toEqual([10,10,10,99,10,200,10,99,10,10,10,99]);expect(out.planes[0]!.buffer).not.toBe(input.buffer);
 expect([...casVideoFrame(frame,step('planes=0'),{maxFrameBytes:12}).planes[0]!]).toEqual([10,10,10,10,200,10,10,10,10]);
 // 1x1: every neighbour is the sample itself.
 expect([...casVideoFrame(gray(Uint8Array.of(77),1,1),step('1'),{maxFrameBytes:1}).planes[0]!]).toEqual([77]);
 // planes bit p selects data plane p; the default 7 copies alpha.
 const yuva:VideoFrameData={width:2,height:1,pixelFormat:'yuva420p',planes:[Uint8Array.of(200,40),Uint8Array.of(7),Uint8Array.of(8),Uint8Array.of(90,10)],linesizes:[2,1,1,2],pts:null,metadata:{}};
 const sharpened=casVideoFrame(yuva,step(null),{maxFrameBytes:6}).planes.map(plane=>[...plane]);expect(sharpened[0]).not.toEqual([200,40]);expect(sharpened.slice(1)).toEqual([[7],[8],[90,10]]);
 const alpha=casVideoFrame(yuva,step('planes=8'),{maxFrameBytes:6}).planes.map(plane=>[...plane]);expect(alpha.slice(0,3)).toEqual([[200,40],[7],[8]]);expect(alpha[3]).not.toEqual([90,10]);
});
it('rejects unsupported layouts, budgets, malformed storage, invalid settings and cancellation explicitly',()=>{
 const settings=step(null);
 for(const pixelFormat of ['nv12','rgb24','rgba','bgr24'])expect(()=>casVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},settings,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>casVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>casVideoFrame(gray(new Uint8Array(8),3,2,4),settings,{maxFrameBytes:7})).toThrow('storage exceeds');
 expect(()=>casVideoFrame(gray(new Uint8Array(5),3,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>casVideoFrame(gray(new Uint8Array(6),3,2,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>casVideoFrame(gray(new Uint8Array(6),3,2,2.5),settings,{maxFrameBytes:64})).toThrow(VideoCasError);
 expect(()=>casVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},settings,{maxFrameBytes:64})).toThrow('plane count');
 expect(()=>casVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},settings,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{name:'cas',strength:2,planes:7},{name:'cas',strength:0.3,planes:7},{name:'cas',strength:0,planes:0.5},{name:'cas',strength:Number.NaN,planes:7},{name:'deflate',strength:0,planes:7}])expect(()=>casVideoFrame(gray(new Uint8Array(6),3,2),bad as unknown as CasStep,{maxFrameBytes:64})).toThrow('Invalid cas settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>casVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 let calls=0;const late={get aborted(){return false;},throwIfAborted(){if(++calls>2)throw new Error('late stop');}} as unknown as AbortSignal;expect(()=>casVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64,signal:late})).toThrow('late stop');
});
it('plans cas on every path and refuses timelines and runtime commands',()=>{
 const plan=compileVideoFilterChain('cas,hflip,cas=1:1').plan('gray',5,3);expect(plan.stages.map(stage=>stage.operation)).toEqual(['cas','hflip','cas']);expect(plan.stateBytes).toBe(0);
 expect(()=>plan.apply(gray(Uint8Array.from({length:15},(_,i)=>i*17),5,3),{maxFrameBytes:14,maxStateBytes:0})).toThrow('budget');
 expect(compileVideoFilterChain('cas').plan('nv12',4,4).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv420p'],['cas','yuv420p']]);
 // Native converts packed RGB with alpha to gbrap, which has no frame storage here.
 for(const source of ['rgba','abgr'])expect(()=>compileVideoFilterChain('cas').plan(source,5,3),source).toThrow('Video filter cas input negotiates gbrap, which is not implemented');
 expect(()=>compileVideoFilterChain('cas=enable=1')).toThrow(VideoFilterError);
 expect(compileVideoFilterGraph('[0:v]cas=0.5[o]').plan({format:'gray',width:1,height:1},[null]).negotiated.nodes.length).toBeGreaterThan(0);
 expect(planTimedVideoGraph('cas=0.5',[{geometry:{format:'gray',width:4,height:4},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}],[null]).nodes.length).toBeGreaterThan(0);
 for(const description of ['cas=enable=1','cas=strength=1/2','cas=sharpness=1'])expect(()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64}),description).toThrow();
 expect(casOperator.timeline).toBeUndefined();expect(casOperator.geometryCommands).toBeUndefined();
});
