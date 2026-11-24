import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {limiterOperator,limiterPixelFormats,limitVideoFrame,parseLimiterOptions} from '../../packages/avfilter/src/video-ops/limiter.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
it('parses declared defaults, shorthand, integer expressions, ranges and the init min > max refusal',()=>{
 expect(parseLimiterOptions(null)).toEqual({name:'limiter',min:0,max:65535,planes:15});expect(Object.isFrozen(parseLimiterOptions(''))).toBe(true);
 expect(parseLimiterOptions('16:235:1')).toEqual({name:'limiter',min:16,max:235,planes:1});expect(parseLimiterOptions('max=200:min=10:planes=5')).toEqual({name:'limiter',min:10,max:200,planes:5});
 expect(parseLimiterOptions('min=1:min=7').min).toBe(7);expect(parseLimiterOptions('min=0x10:max=2*100').max).toBe(200);expect(parseLimiterOptions('min=0x10').min).toBe(16);expect(parseLimiterOptions('max=max:min=min:planes=default')).toEqual({name:'limiter',min:0,max:65535,planes:15});
 expect(parseLimiterOptions('min=2.5').min).toBe(2);expect(parseLimiterOptions('min=3.5').min).toBe(4);expect(parseLimiterOptions('300:300').min).toBe(300);expect(parseLimiterOptions('min=65535').max).toBe(65535);
 // Out-of-order bounds are refused after every option is applied, as init does.
 expect(parseLimiterOptions('max=10:min=5').max).toBe(10);expect(()=>parseLimiterOptions('min=300:max=100')).toThrow('Limiter min must not exceed max');expect(()=>parseLimiterOptions('11:10')).toThrow(VideoFilterParseError);
 for(const [options,message]of [['min=-1','Invalid limiter min'],['min=65536','Invalid limiter min'],['max=70000','Invalid limiter max'],['planes=16','Invalid limiter planes'],['planes=-1','Invalid limiter planes'],['min=abc','Invalid limiter min'],['min=','Invalid limiter min'],['enable=1','timeline'],['enable=between(t,0,1)','timeline'],['threads=1','Unsupported limiter option'],['foo=1','Unsupported limiter option'],['1:2:3:4',''],['min=1:2','']] as const)expect(()=>parseLimiterOptions(options),options).toThrow(message);
 // The pinned vf_limiter.c pix_fmts in declared order.
 expect(limiterPixelFormats).toEqual('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));expect(limiterOperator.formats!(parseLimiterOptions(null))).toBe(limiterPixelFormats);expect(Object.isFrozen(limiterPixelFormats)).toBe(true);
 expect(videoOperator('limiter')).toBe(limiterOperator);expect(limiterOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(limiterOperator.timeline).toBeUndefined();expect(limiterOperator.geometryCommands).toBeUndefined();
});
it('clamps masked planes with eight-bit bound clamping into owned tight planes without mutating padded input',()=>{
 const input=Uint8Array.of(0,100,255,99,16,235,240,99),frame=gray(input,3,2,4),actual=limitVideoFrame(frame,parseLimiterOptions('16:235'),{maxFrameBytes:8});
 expect([...actual.planes[0]!]).toEqual([16,100,235,16,235,235]);expect(actual.linesizes).toEqual([3]);expect(actual.pts).toEqual(frame.pts);expect(actual.pts).not.toBe(frame.pts);expect(actual.metadata).toEqual({colorRange:2});expect([...input]).toEqual([0,100,255,99,16,235,240,99]);
 expect([...limitVideoFrame(frame,parseLimiterOptions('300:65535'),{maxFrameBytes:8}).planes[0]!]).toEqual([255,255,255,255,255,255]);expect([...limitVideoFrame(frame,parseLimiterOptions('7:7'),{maxFrameBytes:8}).planes[0]!]).toEqual([7,7,7,7,7,7]);
 const copy=limitVideoFrame(frame,parseLimiterOptions('16:235:0'),{maxFrameBytes:8});expect([...copy.planes[0]!]).toEqual([0,100,255,16,235,240]);expect(copy.planes[0]!.buffer).not.toBe(input.buffer);
 const yuva:VideoFrameData={width:1,height:1,pixelFormat:'yuva420p',planes:[Uint8Array.of(1),Uint8Array.of(2),Uint8Array.of(250),Uint8Array.of(251)],linesizes:[1,1,1,1],pts:null,metadata:{}};
 expect(limitVideoFrame(yuva,parseLimiterOptions('10:200:5'),{maxFrameBytes:4}).planes.map(plane=>plane[0])).toEqual([10,2,200,251]);expect(limitVideoFrame(yuva,parseLimiterOptions('10:200:8'),{maxFrameBytes:4}).planes.map(plane=>plane[0])).toEqual([1,2,250,200]);
 const gbrp:VideoFrameData={width:1,height:1,pixelFormat:'gbrp',planes:[Uint8Array.of(0),Uint8Array.of(0),Uint8Array.of(0)],linesizes:[1,1,1],pts:null,metadata:{}};
 // Bits follow plane index: G, B, R; bit 3 has no plane.
 expect(limitVideoFrame(gbrp,parseLimiterOptions('9:9:12'),{maxFrameBytes:3}).planes.map(plane=>plane[0])).toEqual([0,0,9]);expect(limitVideoFrame(gbrp,parseLimiterOptions('9:9:3'),{maxFrameBytes:3}).planes.map(plane=>plane[0])).toEqual([9,9,0]);
});
it('rejects unsupported layouts, budgets, malformed storage, settings and cancellation explicitly',()=>{
 const step=parseLimiterOptions(null);
 for(const pixelFormat of ['nv12','rgb24','rgba','bgr24','pal8'])expect(()=>limitVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},step,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>limitVideoFrame(gray(new Uint8Array(6),3,2),step,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>limitVideoFrame(gray(new Uint8Array(8),3,2,4),step,{maxFrameBytes:7})).toThrow('storage exceeds');expect(()=>limitVideoFrame(gray(new Uint8Array(6),3,2),step,{maxFrameBytes:0})).toThrow('allocation limit');
 expect(()=>limitVideoFrame(gray(new Uint8Array(5),3,2),step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>limitVideoFrame(gray(new Uint8Array(6),3,2,2),step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>limitVideoFrame(gray(new Uint8Array(6),3,2,3.5),step,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>limitVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},step,{maxFrameBytes:64})).toThrow('plane count');expect(()=>limitVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},step,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{min:5,max:4,planes:1},{min:-1,max:4,planes:1},{min:0,max:65536,planes:1},{min:0,max:4,planes:16},{min:0.5,max:4,planes:1}])expect(()=>limitVideoFrame(gray(new Uint8Array(6),3,2),{name:'limiter',...bad},{maxFrameBytes:64}),JSON.stringify(bad)).toThrow('Invalid limiter settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>limitVideoFrame(gray(new Uint8Array(6),3,2),step,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans limiter on linear, graph and actor paths, refuses min > max before frames and refuses runtime commands',async()=>{
 const plan=compileVideoFilterChain('limiter=16:235,hflip,limiter=min=300').plan('gray',5,3);expect(plan.stages.map(stage=>stage.operation)).toEqual(['limiter','hflip','limiter']);expect(plan.stateBytes).toBe(0);
 const frame=gray(Uint8Array.from({length:15},(_,i)=>i*18),5,3),output=plan.apply(frame,{maxFrameBytes:15,maxStateBytes:0});expect([...output.planes[0]!]).toEqual(Array(15).fill(255));expect(()=>plan.apply(frame,{maxFrameBytes:14,maxStateBytes:0})).toThrow();
 expect(compileVideoFilterChain('limiter').plan('nv12',5,3).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv420p'],['limiter','yuv420p']]);
 // Native converts packed RGB with alpha to gbrap (tests/differential/video-limiter.test.ts), which has no frame storage here.
 for(const source of ['rgba','argb'])expect(()=>compileVideoFilterChain('limiter').plan(source,5,3),source).toThrow('Video filter limiter input negotiates gbrap, which is not implemented');
 expect(()=>compileVideoFilterChain('limiter=10:9')).toThrow('Limiter min must not exceed max');expect(()=>compileVideoFilterGraph('[0:v]limiter=min=9:max=8[o]')).toThrow('Limiter min must not exceed max');expect(()=>createFrameActors('limiter=9:8',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('Limiter min must not exceed max');
 expect(()=>compileVideoFilterChain('limiter=enable=1')).toThrow('timeline');expect(()=>createFrameActors('limiter=enable=gte(t\\,1)',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
 const actors=createFrameActors('limiter=16:235',{maxSteps:64,maxQueuedFrames:2,maxQueuedBytes:1<<12,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry:{format:'gray',width:5,height:3}}]});
 try{for(const [command,argument]of [['min','0'],['max','10'],['planes','0'],['enable','0']] as const)expect(actors.sendFilterCommand('limiter',command,argument).code,command).toBe(command==='enable'?-1163346256:-38);
  actors.sendFrameInput(0,{kind:'frame',duration:1n,frame});actors.endInput(0,-541478725,1n);const result=await actors.readFrame(0);expect(result.code).toBe(0);expect([...result.event!.frame.planes[0]!].slice(0,5)).toEqual([16,18,36,54,72]);}finally{actors.dispose();}
});
