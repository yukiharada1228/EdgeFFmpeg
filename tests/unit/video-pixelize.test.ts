import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator,VideoFilterError} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {parsePixelizeOptions,pixelizeVideoFrame,pixelizeOperator} from '../../packages/avfilter/src/video-ops/pixelize.js';
import type {PixelizeStep} from '../../packages/avfilter/src/video-ops/pixelize.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const step=(options:string|null)=>parsePixelizeOptions(options);
it('parses defaults, shorthand order, aliases, modes and folded plane flags into frozen steps',()=>{
 expect(step(null)).toEqual({name:'pixelize',width:16,height:16,mode:0,planes:15});expect(Object.isFrozen(step(''))).toBe(true);
 expect(step('3:2:max:1')).toEqual({name:'pixelize',width:3,height:2,mode:2,planes:1});expect(step('w=1024:h=1:m=min:p=0x6')).toEqual({name:'pixelize',width:1024,height:1,mode:1,planes:6});
 expect(step('width=0x10:height=007:mode=1')).toMatchObject({width:16,height:7,mode:1});expect(step('4:mode=2').mode).toBe(2);expect(step('mode=avg:mode=max').mode).toBe(2);
 expect(step('planes=8+1').planes).toBe(9);expect(step('planes=-1').planes).toBe(14);expect(step('planes=1:planes=+4').planes).toBe(5);expect(step('planes=255').planes).toBe(255);expect(step('planes=4294967295').planes).toBe(-1);expect(step('planes=0').planes).toBe(0);
 expect(pixelizeOperator.parse!({name:'pixelize',options:'2:3',inputs:[],outputs:[]} as never).configuration).toEqual(step('2:3'));expect(videoOperator('pixelize')).toBe(pixelizeOperator);
});
it('refuses out-of-range, non-integer, named, expression, timeline and unknown options explicitly',()=>{
 for(const options of ['w=0','w=1025','h=0','height=2048','w=-1','w=2.5','w=1e1','w=2*3','w=max','w=','mode=3','mode=-1','mode=median','mode=','m=AVG','planes=','planes=y','planes=all','planes=default','planes=1+','planes=4294967296','planes=1*2',`planes=${'1+'.repeat(128)}1`,'enable=1','threads=1','foo=1'])expect(()=>step(options),options).toThrow(VideoFilterParseError);
 for(const options of ['1:2:avg:1:5','w=2:3'])expect(()=>step(options),options).toThrow('Missing filter option name');
 expect(()=>step('w=1025')).toThrow('outside [1 - 1024]');expect(()=>step('enable=1')).toThrow('timeline');
 expect(()=>compileVideoFilterChain('pixelize=enable=1')).toThrow(VideoFilterError);expect(()=>compileVideoFilterChain('pixelize=w=0')).toThrow();expect(()=>compileVideoFilterGraph('[0:v]pixelize=mode=x[o]')).toThrow();
});
it('averages with truncation, keeps partial edge blocks, rounds blocks to the chroma grid and copies unselected planes',()=>{
 const input=Uint8Array.of(0,1,2,99,10,11,13,99,20,21,22,99),frame=gray(input,3,3,4);
 expect([...pixelizeVideoFrame(frame,step('2:2'),{maxFrameBytes:12}).planes[0]!]).toEqual([5,5,7,5,5,7,20,20,22]);
 expect([...pixelizeVideoFrame(frame,step('2:2:min'),{maxFrameBytes:12}).planes[0]!]).toEqual([0,0,2,0,0,2,20,20,22]);
 expect([...pixelizeVideoFrame(frame,step('2:2:max'),{maxFrameBytes:12}).planes[0]!]).toEqual([11,11,13,11,11,13,21,21,22]);
 expect([...pixelizeVideoFrame(frame,step('40:40'),{maxFrameBytes:12}).planes[0]!]).toEqual(Array(9).fill(11));
 const copy=pixelizeVideoFrame(frame,step('planes=0'),{maxFrameBytes:12});expect([...copy.planes[0]!]).toEqual([0,1,2,10,11,13,20,21,22]);expect(copy.planes[0]!.buffer).not.toBe(input.buffer);
 expect(copy.linesizes).toEqual([3]);expect(copy.pts).toEqual(frame.pts);expect(copy.pts).not.toBe(frame.pts);expect(copy.metadata).toEqual({colorRange:2});expect([...input]).toEqual([0,1,2,99,10,11,13,99,20,21,22,99]);
 // yuv420p with w=1: chroma blocks max(1,1>>1)=1, luma blocks 1<<1=2; alpha follows luma.
 const plane=(n:number,length:number)=>Uint8Array.from({length},(_,i)=>n+i*4),yuva:VideoFrameData={width:2,height:2,pixelFormat:'yuva420p',planes:[plane(0,4),plane(100,1),plane(200,1),plane(40,4)],linesizes:[2,1,1,2],pts:null,metadata:{}};
 const out=pixelizeVideoFrame(yuva,step('1:1:avg:0x9'),{maxFrameBytes:10});expect(out.planes.map(p=>[...p])).toEqual([[6,6,6,6],[100],[200],[46,46,46,46]]);expect(out.pts).toBeNull();
 const sub=pixelizeVideoFrame({width:3,height:1,pixelFormat:'yuv422p',planes:[Uint8Array.of(1,2,9),Uint8Array.of(5,7),Uint8Array.of(8,6)],linesizes:[3,2,2],pts:null,metadata:{}},step('3:1:max'),{maxFrameBytes:7});expect(sub.planes.map(p=>[...p])).toEqual([[2,2,9],[5,7],[8,6]]);
});
it('declares the native pix_fmts in declared order, plans one format-preserving stage and refuses picks without storage',()=>{
 // The pinned vf_pixelize.c pix_fmts in declared order.
 expect(pixelizeOperator.formats!(step(null))).toEqual('gray gray9le gray10le gray12le gray14le gray16le yuv410p yuv411p yuv420p yuv422p yuv440p yuv444p yuvj420p yuvj422p yuvj440p yuvj444p yuvj411p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv440p10le yuv444p12le yuv422p12le yuv420p12le yuv440p12le yuv444p14le yuv422p14le yuv420p14le yuv420p16le yuv422p16le yuv444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le yuva420p yuva422p yuva444p yuva444p9le yuva444p10le yuva444p12le yuva444p16le yuva422p9le yuva422p10le yuva422p12le yuva422p16le yuva420p9le yuva420p10le yuva420p16le gbrap gbrap10le gbrap12le gbrap16le'.split(' '));expect(pixelizeOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
 const plan=compileVideoFilterChain('pixelize=2:2').plan('nv12',5,3);expect(plan.stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv420p'],['pixelize','yuv420p']]);expect(plan.stages[1]!.stateBytes).toBe(0);
 // Native converts packed RGB with alpha to gbrap (tests/differential/video-pixelize.test.ts), which has no frame storage here.
 for(const source of ['rgba','bgra'])expect(()=>compileVideoFilterChain('pixelize').plan(source,5,3),source).toThrow('Video filter pixelize input negotiates gbrap, which is not implemented');
 const graph=compileVideoFilterGraph('[0:v]pixelize[o]').plan({format:'rgb24',width:5,height:3},[null]);expect(graph.negotiated.nodes[0]!.inputs[0]!.format).toBe('gbrp');
});
it('rejects unsupported layouts, budgets, malformed storage, bad settings and cancellation explicitly',()=>{
 const settings=step('2:2'),frame=gray(new Uint8Array(6),3,2);
 for(const pixelFormat of ['nv12','rgb24','rgba','yuv420p10le'])expect(()=>pixelizeVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},settings,{maxFrameBytes:64}),pixelFormat).toThrow();
 expect(()=>pixelizeVideoFrame({width:2,height:2,pixelFormat:'rgb24',planes:[new Uint8Array(12)],linesizes:[6],pts:null,metadata:{}},settings,{maxFrameBytes:64})).toThrow('not supported');
 expect(()=>pixelizeVideoFrame(frame,settings,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>pixelizeVideoFrame(frame,settings,{maxFrameBytes:0})).toThrow('allocation limit');expect(()=>pixelizeVideoFrame(gray(new Uint8Array(8),3,2,4),settings,{maxFrameBytes:7})).toThrow('storage exceeds');
 expect(()=>pixelizeVideoFrame(gray(new Uint8Array(5),3,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>pixelizeVideoFrame(gray(new Uint8Array(6),3,2,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>pixelizeVideoFrame(gray(new Uint8Array(6),3,2,1.5),settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>pixelizeVideoFrame({...frame,planes:[]},settings,{maxFrameBytes:64})).toThrow('plane count');expect(()=>pixelizeVideoFrame({...frame,planes:[[0,0,0,0,0,0] as unknown as Uint8Array]},settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>pixelizeVideoFrame({...frame,pts:{value:0n,timeBase:{num:0n,den:1n}}},settings,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{...settings,width:0},{...settings,height:1025},{...settings,mode:3},{...settings,planes:0.5}])expect(()=>pixelizeVideoFrame(frame,bad as PixelizeStep,{maxFrameBytes:64})).toThrow('Invalid pixelize settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>pixelizeVideoFrame(frame,settings,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 const plan=compileVideoFilterChain('pixelize').plan('gray',3,2);expect(()=>plan.apply(frame,{maxFrameBytes:5,maxStateBytes:0})).toThrow();
});
