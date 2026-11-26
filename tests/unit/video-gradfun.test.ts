import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph,VideoFilterError} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {gradfunOperator,gradfunPixelFormats,gradfunVideoFrame,parseGradfunOptions,VideoGradfunError} from '../../packages/avfilter/src/video-ops/gradfun.js';
import type {GradfunStep} from '../../packages/avfilter/src/video-ops/gradfun.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const step=(options:string|null)=>parseGradfunOptions(options);
const ramp=(width:number,height:number,stride=width)=>Uint8Array.from({length:stride*(height-1)+width},(_,i)=>i%stride<width?(40+((i%stride)>>2)+(Math.floor(i/stride)>>3))&255:7);
it('parses strength as a range-checked float32 and radius with init rounding, shorthand order and last-wins keys',()=>{
 expect(step(null)).toEqual({name:'gradfun',strength:Math.fround(1.2),radius:16,thresh:27306});expect(Object.isFrozen(step(''))).toBe(true);
 // thresh = (int)(32768.f / strength): 32768/0.51f truncates to 64250, 32768/64 is exact.
 expect(step('0.51')).toEqual({name:'gradfun',strength:Math.fround(0.51),radius:16,thresh:64250});expect(step('64').thresh).toBe(512);expect(step('strength=3').thresh).toBe(10922);
 expect(step('2:5').radius).toBe(6);expect(step('radius=4').radius).toBe(4);expect(step('radius=31').radius).toBe(32);expect(step('radius=32').radius).toBe(32);expect(step('radius=7').radius).toBe(8);
 expect(step('radius=2.5*2').radius).toBe(6);expect(step('radius=max').radius).toBe(32);expect(step('radius=default').radius).toBe(16);expect(step('strength=1:strength=2').strength).toBe(2);expect(step('1e1').strength).toBe(10);expect(step('.75').strength).toBe(0.75);
 for(const options of ['strength=0.5','strength=64.01','strength=-1','strength=1+1','strength=max','strength=1k','strength=','radius=3','radius=33','radius=abc','radius=','enable=1','threads=1','threshold=1','1:16:3','strength=1:4'])expect(()=>step(options),options).toThrow();
 expect(()=>step('threshold=1')).toThrow(VideoFilterParseError);expect(()=>step('threshold=1')).toThrow('Unsupported gradfun option');expect(()=>step('enable=1')).toThrow('timeline');
 expect(()=>step('strength=0.5')).toThrow('outside [0.51 - 64]');expect(()=>step('strength=1+1')).toThrow('constant decimal');expect(()=>step('radius=40')).toThrow('Invalid gradfun radius');
 expect(gradfunOperator.parse!({name:'gradfun',options:'3'} as never).configuration.thresh).toBe(10922);
});
it('declares the native pix_fmts in declared order, keeps geometry and refuses 2*radius+1-row filtered planes',()=>{
 expect(gradfunPixelFormats).toEqual(['yuv410p','yuv420p','gray','yuv444p','yuv422p','yuv411p','yuv440p','gbrp']);expect(Object.isFrozen(gradfunPixelFormats)).toBe(true);expect(gradfunOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
 expect(gradfunOperator.geometry!(step(null),[{format:'yuv420p',width:40,height:36}])).toEqual({width:40,height:36});expect(()=>gradfunOperator.geometry!(step(null),[{format:'yuv420p',width:40,height:34}])).toThrow('2*radius+1 rows');
 // Tiny frames are copied like native (min(w,h) <= 2r), so they are accepted.
 for(const [w,h]of [[1,1],[2,2],[5,3],[8,6],[33,32]] as const)expect(gradfunOperator.geometry!(step(null),[{format:'gray',width:w,height:h}])).toEqual({width:w,height:h});
 for(const [format,width,height,options]of [['gray',9,9,'radius=4'],['gray',40,33,null],['yuv420p',20,18,'radius=4'],['yuv422p',17,9,'radius=6'],['gbrp',70,65,'radius=32']] as const)expect(()=>gradfunOperator.geometry!(step(options),[{format,width,height}]),format).toThrow('2*radius+1 rows');
 // Only filtered planes are refused: width 8 keeps a 9-row radius-4 plane a copy.
 expect(gradfunOperator.geometry!(step('radius=4'),[{format:'gray',width:8,height:9}])).toEqual({width:8,height:9});
 for(const format of ['rgb24','nv12','yuva420p'])expect(()=>gradfunOperator.geometry!(step(null),[{format,width:4,height:3}]),format).toThrow('not supported');expect(()=>gradfunOperator.geometry!(step(null),[{format:'yuv410p',width:4,height:3}])).toThrow('yuv410p');
});
it('debands ramps with the ordered dither, copies small planes and writes owned tight planes without mutating the input',()=>{
 const input=ramp(20,12,24),frame=gray(input,20,12,24),copy=Uint8Array.from(input);
 const out=gradfunVideoFrame(frame,step('strength=4:radius=4'),{maxFrameBytes:300});
 expect(out.linesizes).toEqual([20]);expect(out.planes[0]!.length).toBe(240);expect(out.pts).toEqual(frame.pts);expect(out.pts).not.toBe(frame.pts);expect(out.metadata).toEqual({colorRange:2});
 expect([...input]).toEqual([...copy]);expect(out.planes[0]!.buffer).not.toBe(input.buffer);
 const source=Array.from({length:12},(_,y)=>[...input.subarray(y*24,y*24+20)]).flat();expect([...out.planes[0]!]).not.toEqual(source);
 // Every output stays within one step of the smooth ramp: the threshold keeps the correction small.
 expect([...out.planes[0]!].every((value,i)=>Math.abs(value-source[i]!)<=2)).toBe(true);
 // A flat plane gets no correction and dithers below the rounding step, so it stays flat.
 expect([...gradfunVideoFrame(gray(new Uint8Array(240).fill(90),20,12),step('radius=4'),{maxFrameBytes:240}).planes[0]!].every(value=>value===90)).toBe(true);
 // 16x16 yuv420p at radius 4: luma filters, 8x8 chroma (r=4) is copied.
 const yuv:VideoFrameData={width:16,height:16,pixelFormat:'yuv420p',planes:[ramp(16,16),Uint8Array.from({length:64},(_,i)=>i),Uint8Array.from({length:64},(_,i)=>200-i)],linesizes:[16,8,8],pts:null,metadata:{}};
 const planes=gradfunVideoFrame(yuv,step('radius=4'),{maxFrameBytes:384}).planes;expect([...planes[1]!]).toEqual([...yuv.planes[1]!]);expect([...planes[2]!]).toEqual([...yuv.planes[2]!]);
 expect([...gradfunVideoFrame(gray(Uint8Array.of(1,2,3,4),2,2),step(null),{maxFrameBytes:4}).planes[0]!]).toEqual([1,2,3,4]);
});
it('rejects unsupported layouts, budgets, malformed storage, invalid settings and cancellation explicitly',()=>{
 const settings=step('radius=4');
 for(const pixelFormat of ['nv12','rgb24','rgba','yuva420p','pal8'])expect(()=>gradfunVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},settings,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>gradfunVideoFrame(gray(new Uint8Array(81),9,9),settings,{maxFrameBytes:1024})).toThrow(VideoGradfunError);
 expect(()=>gradfunVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>gradfunVideoFrame(gray(new Uint8Array(8),3,2,4),settings,{maxFrameBytes:7})).toThrow('storage exceeds');
 expect(()=>gradfunVideoFrame(gray(new Uint8Array(400),20,20),step('radius=4'),{maxFrameBytes:400})).not.toThrow();expect(()=>gradfunVideoFrame(gray(new Uint8Array(4900),70,70),step('radius=32'),{maxFrameBytes:4900})).not.toThrow();
 expect(()=>gradfunVideoFrame(gray(new Uint8Array(5),3,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>gradfunVideoFrame(gray(new Uint8Array(6),3,2,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>gradfunVideoFrame(gray(new Uint8Array(6),3,2,2.5),settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>gradfunVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},settings,{maxFrameBytes:64})).toThrow('plane count');
 expect(()=>gradfunVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},settings,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{name:'gradfun',strength:1.2,radius:16,thresh:27306},{name:'gradfun',strength:0.5,radius:16,thresh:65536},{name:'gradfun',strength:2,radius:5,thresh:16384},{name:'gradfun',strength:2,radius:34,thresh:16384},{name:'gradfun',strength:2,radius:16,thresh:1},{name:'deflate',strength:2,radius:16,thresh:16384}])expect(()=>gradfunVideoFrame(gray(new Uint8Array(6),3,2),bad as unknown as GradfunStep,{maxFrameBytes:64}),JSON.stringify(bad)).toThrow('Invalid gradfun settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>gradfunVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 let calls=0;const late={get aborted(){return false;},throwIfAborted(){if(++calls>3)throw new Error('late stop');}} as unknown as AbortSignal;expect(()=>gradfunVideoFrame(gray(ramp(20,12),20,12),settings,{maxFrameBytes:240,signal:late})).toThrow('late stop');
});
it('plans gradfun on every path with the 2*radius+1 refusal and runtime commands refused',()=>{
 const plan=compileVideoFilterChain('gradfun=radius=4,hflip,gradfun').plan('gray',20,12);expect(plan.stages.map(stage=>stage.operation)).toEqual(['gradfun','hflip','gradfun']);expect(plan.stateBytes).toBe(0);
 expect(()=>plan.apply(gray(ramp(20,12),20,12),{maxFrameBytes:200,maxStateBytes:0})).toThrow();
 expect(compileVideoFilterChain('gradfun').plan('nv12',4,4).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv420p'],['gradfun','yuv420p']]);
 expect(compileVideoFilterChain('gradfun').plan('rgba',4,4).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','gbrp'],['gradfun','gbrp']]);
 expect(()=>compileVideoFilterChain('gradfun=radius=4').plan('gray',9,9)).toThrow(VideoFilterError);expect(()=>compileVideoFilterChain('gradfun=radius=4').plan('gray',9,9)).toThrow('2*radius+1 rows');
 expect(()=>compileVideoFilterGraph('[0:v]gradfun[o]').plan({format:'gray',width:40,height:33},[null])).toThrow('2*radius+1 rows');
 expect(()=>planTimedVideoGraph('gradfun=radius=4',[{geometry:{format:'gray',width:9,height:9},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}],[null])).toThrow('2*radius+1 rows');
 expect(planTimedVideoGraph('gradfun=3',[{geometry:{format:'gray',width:16,height:16},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}],[null]).nodes.length).toBeGreaterThan(0);
 for(const description of ['gradfun=enable=1','gradfun=threshold=1'])expect(()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64}),description).toThrow();
 expect(gradfunOperator.timeline).toBeUndefined();expect(gradfunOperator.geometryCommands).toBeUndefined();
});
