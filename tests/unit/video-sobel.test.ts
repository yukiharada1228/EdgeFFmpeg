import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph,VideoFilterError} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {gradientNames,gradientPixelFormats,gradientVideoFrame,parseGradientOptions,VideoGradientError} from '../../packages/avfilter/src/video-sobel.js';
import type {GradientName,GradientStep} from '../../packages/avfilter/src/video-sobel.js';
import {sobelOperator} from '../../packages/avfilter/src/video-ops/sobel.js';
import {prewittOperator} from '../../packages/avfilter/src/video-ops/prewitt.js';
import {scharrOperator} from '../../packages/avfilter/src/video-ops/scharr.js';
import {robertsOperator} from '../../packages/avfilter/src/video-ops/roberts.js';
import {videoOperator} from '../../packages/avfilter/src/video-ops/registry.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const operators={sobel:sobelOperator,prewitt:prewittOperator,scharr:scharrOperator,roberts:robertsOperator} as const;
const run=(name:GradientName,options:string|null,frame:VideoFrameData,maxFrameBytes=1<<16)=>gradientVideoFrame(frame,parseGradientOptions(name,options),{maxFrameBytes});
it('parses the common class planes, scale and delta with native defaults, shorthand order, expressions, float storage and last-wins keys',()=>{
 for(const name of gradientNames){
  expect(parseGradientOptions(name,null)).toEqual({name,planes:15,scale:1,delta:0});expect(Object.isFrozen(parseGradientOptions(name,''))).toBe(true);
  expect(parseGradientOptions(name,'3:0.3:-20')).toEqual({name,planes:3,scale:Math.fround(0.3),delta:-20});
  expect(parseGradientOptions(name,'planes=2:planes=5:delta=30:scale=4')).toEqual({name,planes:5,scale:4,delta:30});
  // AV_OPT_TYPE_INT rounds half to even; AV_OPT_TYPE_FLOAT evaluates expressions and constants, then stores the double as float.
  expect(parseGradientOptions(name,'planes=2.5:scale=max/2:delta=min')).toEqual({name,planes:2,scale:32767.5,delta:-65535});
  expect(parseGradientOptions(name,'planes=default:scale=default:delta=default')).toEqual({name,planes:15,scale:1,delta:0});
  expect(parseGradientOptions(name,'scale=0.1:delta=1e-3')).toEqual({name,planes:15,scale:Math.fround(0.1),delta:Math.fround(0.001)});
  for(const options of ['enable=1','threads=1','foo=1','planes=16','planes=-1','scale=-0.5','scale=65536','delta=65536','delta=-65536','scale=0/0','scale=','planes=abc','0m=1'])expect(()=>parseGradientOptions(name,options),`${name} ${options}`).toThrow(VideoFilterParseError);
  for(const options of ['1:2:3:4','planes=1:2'])expect(()=>parseGradientOptions(name,options),`${name} ${options}`).toThrow();
  expect(()=>parseGradientOptions(name,'foo=1')).toThrow(`Unsupported ${name} option`);expect(()=>parseGradientOptions(name,'enable=1')).toThrow('timeline expressions are not implemented');expect(()=>parseGradientOptions(name,'scale=70000')).toThrow(`Invalid ${name} scale`);
  expect(operators[name].parse!({name,options:'1:2'} as never).configuration).toEqual({name,planes:1,scale:2,delta:0});expect(videoOperator(name)).toBe(operators[name]);
 }
 expect(()=>parseGradientOptions('kirsch' as GradientName,null)).toThrow(VideoGradientError);
});
it('declares the native pix_fmts in declared order, five paths and no runtime commands',()=>{
 expect(gradientPixelFormats).toEqual('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));expect(Object.isFrozen(gradientPixelFormats)).toBe(true);
 for(const op of Object.values(operators)){expect(op.paths).toEqual(['linear','graph','stream','actor','timed']);expect(op.role).toBe('frame');expect(op.formats!(op.parse!({name:op.name,options:null} as never).configuration as never)).toBe(gradientPixelFormats);expect(op.timeline).toBeUndefined();expect(op.geometryCommands).toBeUndefined();expect(op.geometry).toBeUndefined();}
});
it('computes each operator on a ramp with avpriv_mirror borders, truncation, clipping and owned tight planes',()=>{
 // Rows 0 10 20 in a stride-4 buffer: the mirrored border columns see equal neighbours on both sides.
 const input=Uint8Array.of(0,10,20,99,0,10,20,99,0,10,20,99),frame=gray(input,3,3,4);
 const rows=(name:GradientName,options:string|null)=>[...run(name,options,frame).planes[0]!];
 expect(rows('sobel',null)).toEqual([0,80,0,0,80,0,0,80,0]);expect(rows('prewitt',null)).toEqual([0,60,0,0,60,0,0,60,0]);expect(rows('scharr',null)).toEqual([0,20,0,0,20,0,0,20,0]);
 // roberts: |(-10,10)| = 14.14 everywhere, since x=0 mirrors its left neighbour onto x=1.
 expect(rows('roberts',null)).toEqual(Array(9).fill(14));expect(rows('roberts','delta=0.85')).toEqual(Array(9).fill(14));expect(rows('roberts','delta=0.86')).toEqual(Array(9).fill(15));
 expect(rows('sobel','scale=0.3:delta=-20')).toEqual([0,4,0,0,4,0,0,4,0]);expect(rows('sobel','scale=4')).toEqual([0,255,0,0,255,0,0,255,0]);expect(rows('prewitt','delta=30')).toEqual([30,90,30,30,90,30,30,90,30]);
 // Negative results truncate toward zero and clip to 0; planes=0 copies.
 expect(rows('scharr','scale=0:delta=-0.5')).toEqual(Array(9).fill(0));expect(rows('sobel','planes=0')).toEqual([0,10,20,0,10,20,0,10,20]);expect(rows('sobel','planes=14')).toEqual([0,10,20,0,10,20,0,10,20]);
 const out=run('sobel',null,frame);expect(out.linesizes).toEqual([3]);expect(out.pts).toEqual(frame.pts);expect(out.pts).not.toBe(frame.pts);expect(out.metadata).toEqual({colorRange:2});expect(out.planes[0]!.buffer).not.toBe(input.buffer);
 expect([...input]).toEqual([0,10,20,99,0,10,20,99,0,10,20,99]);
 // A vertical edge: height 2 mirrors y-1 onto y+1, so sobel's suma vanishes; a single sample has zero gradient.
 expect([...run('sobel',null,gray(Uint8Array.of(0,0,100,100),2,2)).planes[0]!]).toEqual([0,0,0,0]);expect([...run('roberts',null,gray(Uint8Array.of(0,0,100,100),2,2)).planes[0]!]).toEqual([0,0,0,0]);
 // roberts differences only columns (c0-c1 on the row above, c4-c3 on this row); sobel's mirrored 3-tap columns cancel at width 2.
 expect([...run('roberts',null,gray(Uint8Array.of(0,100,0,100),2,2)).planes[0]!]).toEqual([141,141,141,141]);expect([...run('sobel',null,gray(Uint8Array.of(0,100,0,100),2,2)).planes[0]!]).toEqual([0,0,0,0]);
 for(const name of gradientNames)expect([...run(name,'delta=7',gray(Uint8Array.of(200),1,1)).planes[0]!],name).toEqual([7]);
});
it('applies the planes mask per plane index and copies the others',()=>{
 const yuva:VideoFrameData={width:2,height:2,pixelFormat:'yuva420p',planes:[Uint8Array.of(0,90,0,90),Uint8Array.of(7),Uint8Array.of(8),Uint8Array.of(90,0,90,0)],linesizes:[2,1,1,2],pts:null,metadata:{}};
 // Width 2: x=0 mirrors x-1 onto x=1, so prewitt sees -c0+c2 = 0 on both columns; roberts sees the horizontal step.
 expect(run('roberts','planes=9',yuva).planes.map(plane=>[...plane])).toEqual([[127,127,127,127],[7],[8],[127,127,127,127]]);
 expect(run('roberts','planes=6:delta=1',yuva).planes.map(plane=>[...plane])).toEqual([[0,90,0,90],[1],[1],[90,0,90,0]]);
 const gbrp:VideoFrameData={width:2,height:1,pixelFormat:'gbrp',planes:[Uint8Array.of(0,40),Uint8Array.of(5,5),Uint8Array.of(9,9)],linesizes:[2,2,2],pts:null,metadata:{}};
 expect(run('sobel','planes=1',gbrp).planes.map(plane=>[...plane])).toEqual([[0,0],[5,5],[9,9]]);expect(run('roberts','planes=1',gbrp).planes.map(plane=>[...plane])).toEqual([[56,56],[5,5],[9,9]]);
});
it('rejects unsupported layouts, budgets, malformed storage, invalid settings and cancellation explicitly',()=>{
 const settings=parseGradientOptions('sobel',null);
 for(const pixelFormat of ['nv12','nv21','rgb24','rgba','pal8'])expect(()=>gradientVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},settings,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>gradientVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>gradientVideoFrame(gray(new Uint8Array(8),3,2,4),settings,{maxFrameBytes:7})).toThrow('storage exceeds');expect(()=>gradientVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:0.5})).toThrow(VideoGradientError);
 for(const [length,stride]of [[5,3],[6,2],[6,2.5],[6,-3]] as const)expect(()=>gradientVideoFrame(gray(new Uint8Array(length),3,2,stride),settings,{maxFrameBytes:64}),`${length}/${stride}`).toThrow('stride or storage');
 expect(()=>gradientVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},settings,{maxFrameBytes:64})).toThrow('plane count');
 expect(()=>gradientVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},settings,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{name:'kirsch',planes:15,scale:1,delta:0},{name:'sobel',planes:16,scale:1,delta:0},{name:'sobel',planes:1.5,scale:1,delta:0},{name:'sobel',planes:15,scale:0.3,delta:0},{name:'sobel',planes:15,scale:-1,delta:0},{name:'sobel',planes:15,scale:1,delta:Number.NaN},{name:'sobel',planes:15,scale:1,delta:70000}])expect(()=>gradientVideoFrame(gray(new Uint8Array(6),3,2),bad as unknown as GradientStep,{maxFrameBytes:64}),JSON.stringify(bad)).toThrow('Invalid gradient settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>gradientVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 let calls=0;const late={get aborted(){return false;},throwIfAborted(){if(++calls>2)throw new Error('late stop');}} as unknown as AbortSignal;expect(()=>gradientVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64,signal:late})).toThrow('late stop');
});
it('plans every operator on every path, refuses picks without storage by name and refuses timelines and commands',()=>{
 const plan=compileVideoFilterChain('sobel,hflip,prewitt=1,scharr=delta=3,roberts').plan('gray',5,3);expect(plan.stages.map(stage=>stage.operation)).toEqual(['sobel','hflip','prewitt','scharr','roberts']);expect(plan.stateBytes).toBe(0);
 const frame=gray(Uint8Array.from({length:15},(_,i)=>i*17),5,3);expect(()=>plan.apply(frame,{maxFrameBytes:14,maxStateBytes:0})).toThrow('budget');
 expect(compileVideoFilterChain('sobel').plan('nv12',4,4).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv420p'],['sobel','yuv420p']]);
 for(const name of gradientNames){
  for(const source of ['rgba','abgr'])expect(()=>compileVideoFilterChain(name).plan(source,5,3),`${name} ${source}`).toThrow(`Video filter ${name} input negotiates gbrap, which is not implemented`);
  expect(compileVideoFilterChain(name).plan('gray',1,1).stages.at(-1)!.operation).toBe(name);expect(()=>compileVideoFilterChain(`${name}=foo=1`).plan('gray',4,4)).toThrow(VideoFilterError);
  expect(()=>compileVideoFilterGraph(`[0:v]${name}=planes=1[o]`).plan({format:'yuv420p',width:1,height:1},[null])).not.toThrow();
  expect(planTimedVideoGraph(`${name}=scale=0.3`,[{geometry:{format:'gray',width:4,height:4},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}],[null]).nodes.length).toBeGreaterThan(0);
  for(const description of [`${name}=enable=1`,`${name}=planes=1:enable='gte(t,1)'`,`${name}=foo=1`])expect(()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64}),description).toThrow();
 }
});
