import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph,VideoFilterError} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {deflateOperator,deflatePixelFormats,deflateVideoFrame,parseDeflateOptions,VideoDeflateError} from '../../packages/avfilter/src/video-ops/deflate.js';
import type {DeflateStep} from '../../packages/avfilter/src/video-ops/deflate.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const step=(options:string|null)=>parseDeflateOptions(options);
it('parses the deflate_inflate thresholds with native defaults, shorthand order, integer expressions and last-wins keys',()=>{
 expect(step(null)).toEqual({name:'deflate',thresholds:[65535,65535,65535,65535]});expect(Object.isFrozen(step(''))).toBe(true);expect(Object.isFrozen(step('').thresholds)).toBe(true);
 expect(step('1:2').thresholds).toEqual([1,2,65535,65535]);expect(step('1:2:3:4').thresholds).toEqual([1,2,3,4]);expect(step('9:threshold3=0').thresholds).toEqual([9,65535,65535,0]);
 expect(step('threshold2=7:threshold2=8').thresholds).toEqual([65535,65535,8,65535]);
 // AV_OPT_TYPE_INT: expressions, the default/min/max constants and llrint half-to-even rounding.
 expect(step('threshold0=2.5:threshold1=3.5:threshold2=max/2:threshold3=min').thresholds).toEqual([2,4,32768,0]);expect(step('threshold0=default').thresholds[0]).toBe(65535);expect(step('threshold0=0x10').thresholds[0]).toBe(16);
 for(const options of ['coordinates=1','coordinates=255:threshold0=1','enable=1','threads=1','foo=1','threshold4=1','threshold0=65536','threshold0=-1','threshold0=65535.6','threshold0=','threshold0=abc','1:2:3:4:5','threshold0=1:2'])expect(()=>step(options),options).toThrow();
 expect(()=>step('coordinates=1')).toThrow(VideoFilterParseError);expect(()=>step('coordinates=1')).toThrow('Unsupported deflate option');expect(()=>step('enable=1')).toThrow('timeline');expect(()=>step('threshold1=70000')).toThrow('Invalid deflate threshold');
 expect(deflateOperator.parse!({name:'deflate',options:'3'} as never).configuration.thresholds).toEqual([3,65535,65535,65535]);
});
it('declares the native pix_fmts in declared order and keeps geometry',()=>{
 // The pinned vf_neighbor.c pix_fmts in declared order.
 expect(deflatePixelFormats).toEqual('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));expect(Object.isFrozen(deflatePixelFormats)).toBe(true);expect(deflateOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
 expect(deflateOperator.geometry!(step(null),[{format:'yuv420p',width:9,height:7}])).toEqual({width:9,height:7});
 for(const [format,width,options]of [['gray',1,null],['yuv420p',2,null],['yuv422p',1,'0:0:1'],['yuva420p',1,'0:0:0']] as const)expect(()=>deflateOperator.geometry!(step(options),[{format,width,height:3}]),format).toThrow('narrower than two samples');
 expect(deflateOperator.geometry!(step('5:0:0'),[{format:'yuv420p',width:2,height:3}])).toEqual({width:2,height:3});expect(deflateOperator.geometry!(step('0'),[{format:'gray',width:1,height:3}])).toEqual({width:1,height:3});
 expect(()=>deflateOperator.geometry!(step(null),[{format:'rgb24',width:4,height:3}])).toThrow('not supported');
});
it('applies the neighbour average with mirrored borders, per-plane thresholds and zero-threshold copies into owned tight planes',()=>{
 // Row-major 3x3: centre neighbours sum to 8*10; the corners mirror their missing column and row.
 const input=Uint8Array.of(10,10,10,99,10,200,10,99,10,10,10,99),frame=gray(input,3,3,4);
 const out=deflateVideoFrame(frame,step(null),{maxFrameBytes:12});
 // (0,0): up=row, left mirrors x=1: 10+10+10+10+10+200+10+200 -> 57 >= 10, min keeps 10. (1,1): sum 80 -> 10.
 expect([...out.planes[0]!]).toEqual([10,10,10,10,10,10,10,10,10]);expect(out.linesizes).toEqual([3]);expect(out.pts).toEqual(frame.pts);expect(out.pts).not.toBe(frame.pts);expect(out.metadata).toEqual({colorRange:2});
 expect([...input]).toEqual([10,10,10,99,10,200,10,99,10,10,10,99]);expect(out.planes[0]!.buffer).not.toBe(input.buffer);
 expect([...deflateVideoFrame(frame,step('5'),{maxFrameBytes:12}).planes[0]!]).toEqual([10,10,10,10,195,10,10,10,10]);
 expect([...deflateVideoFrame(frame,step('0'),{maxFrameBytes:12}).planes[0]!]).toEqual([10,10,10,10,200,10,10,10,10]);
 // Width 2: both columns mirror onto each other; height 1 mirrors rows onto themselves.
 expect([...deflateVideoFrame(gray(Uint8Array.of(200,40),2,1),step(null),{maxFrameBytes:2}).planes[0]!]).toEqual([80,40]);
 const yuva:VideoFrameData={width:2,height:1,pixelFormat:'yuva420p',planes:[Uint8Array.of(200,40),Uint8Array.of(7),Uint8Array.of(8),Uint8Array.of(90,10)],linesizes:[2,1,1,2],pts:null,metadata:{}};
 const planes=deflateVideoFrame(yuva,step('1:0:0:0'),{maxFrameBytes:6}).planes.map(plane=>[...plane]);expect(planes).toEqual([[199,40],[7],[8],[90,10]]);
});
it('rejects unsupported layouts, budgets, malformed storage, invalid settings and cancellation explicitly',()=>{
 const settings=step(null);
 for(const pixelFormat of ['nv12','nv21','rgb24','rgba','pal8'])expect(()=>deflateVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},settings,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>deflateVideoFrame(gray(new Uint8Array(3),1,3),settings,{maxFrameBytes:64})).toThrow(VideoDeflateError);
 expect(()=>deflateVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>deflateVideoFrame(gray(new Uint8Array(8),3,2,4),settings,{maxFrameBytes:7})).toThrow('storage exceeds');
 expect(()=>deflateVideoFrame(gray(new Uint8Array(5),3,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>deflateVideoFrame(gray(new Uint8Array(6),3,2,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>deflateVideoFrame(gray(new Uint8Array(6),3,2,2.5),settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>deflateVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},settings,{maxFrameBytes:64})).toThrow('plane count');
 expect(()=>deflateVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},settings,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{name:'deflate',thresholds:[1,2,3]},{name:'deflate',thresholds:[1,2,3,65536]},{name:'deflate',thresholds:[0.5,0,0,0]},{name:'inflate',thresholds:[1,1,1,1]}])expect(()=>deflateVideoFrame(gray(new Uint8Array(6),3,2),bad as unknown as DeflateStep,{maxFrameBytes:64})).toThrow('Invalid deflate settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>deflateVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 let calls=0;const late={get aborted(){return false;},throwIfAborted(){if(++calls>2)throw new Error('late stop');}} as unknown as AbortSignal;expect(()=>deflateVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64,signal:late})).toThrow('late stop');
});
it('plans deflate on every path with width-1 refusals and runtime commands refused',()=>{
 const plan=compileVideoFilterChain('deflate,hflip,deflate=0').plan('gray',5,3);expect(plan.stages.map(stage=>stage.operation)).toEqual(['deflate','hflip','deflate']);expect(plan.stateBytes).toBe(0);
 const frame=gray(Uint8Array.from({length:15},(_,i)=>i*17),5,3);expect(()=>plan.apply(frame,{maxFrameBytes:14,maxStateBytes:0})).toThrow('budget');
 expect(compileVideoFilterChain('deflate').plan('nv12',4,4).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv420p'],['deflate','yuv420p']]);
 // Native converts packed RGB with alpha to gbrap (tests/differential/video-deflate.test.ts), which has no frame storage here.
 for(const source of ['rgba','abgr'])expect(()=>compileVideoFilterChain('deflate').plan(source,5,3),source).toThrow('Video filter deflate input negotiates gbrap, which is not implemented');
 expect(()=>compileVideoFilterChain('deflate').plan('gray',1,4)).toThrow(VideoFilterError);expect(()=>compileVideoFilterChain('deflate').plan('yuv420p',2,4)).toThrow('narrower than two samples');
 expect(()=>compileVideoFilterGraph('[0:v]deflate[o]').plan({format:'gray',width:1,height:4},[null])).toThrow('narrower than two samples');
 expect(()=>planTimedVideoGraph('deflate',[{geometry:{format:'gray',width:1,height:4},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}],[null])).toThrow('narrower than two samples');
 expect(planTimedVideoGraph('deflate=3',[{geometry:{format:'gray',width:4,height:4},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}],[null]).nodes.length).toBeGreaterThan(0);
 for(const description of ['deflate=enable=1','deflate=coordinates=1'])expect(()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64}),description).toThrow();
 expect(deflateOperator.timeline).toBeUndefined();expect(deflateOperator.geometryCommands).toBeUndefined();
});
