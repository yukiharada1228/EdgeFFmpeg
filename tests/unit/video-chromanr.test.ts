import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator,VideoFilterError} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {chromanrOperator,chromanrPixelFormats,chromanrVideoFrame,parseChromanrOptions} from '../../packages/avfilter/src/video-ops/chromanr.js';
import type {ChromanrStep} from '../../packages/avfilter/src/video-ops/chromanr.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
const step=(options:string|null)=>parseChromanrOptions(options);
const yuv444=(y:readonly number[],u:readonly number[],v:readonly number[],width:number,height:number):VideoFrameData=>({width,height,pixelFormat:'yuv444p',planes:[Uint8Array.from(y),Uint8Array.from(u),Uint8Array.from(v)],linesizes:[width,width,width],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:1}});
it('parses defaults, shorthand order, float thresholds stored as float, integers and distances into frozen steps',()=>{
 expect(step(null)).toEqual({name:'chromanr',thres:30,sizew:5,sizeh:5,stepw:1,steph:1,threy:200,threu:200,threv:200,distance:0});expect(Object.isFrozen(step(''))).toBe(true);
 expect(step('45:2:3:4:5:100:90:80:euclidean')).toEqual({name:'chromanr',thres:45,sizew:2,sizeh:3,stepw:4,steph:5,threy:100,threu:90,threv:80,distance:1});
 expect(step('thres=30.1').thres).toBe(Math.fround(30.1));expect(step('thres=1e2').thres).toBe(100);expect(step('thres=+77').thres).toBe(77);expect(step('thres=.5e1').thres).toBe(5);
 expect(step('sizew=0x10:sizeh=100:stepw=50:steph=1')).toMatchObject({sizew:16,sizeh:100,stepw:50,steph:1});expect(step('distance=1').distance).toBe(1);expect(step('distance=euclidean:distance=manhattan').distance).toBe(0);
 expect(chromanrOperator.parse!({name:'chromanr',options:'50:1',inputs:[],outputs:[]} as never).configuration).toEqual(step('50:1'));expect(videoOperator('chromanr')).toBe(chromanrOperator);
});
it('refuses out-of-range, non-decimal, expression, named, timeline and unknown options explicitly',()=>{
 for(const options of ['thres=0','thres=0.5','thres=200.5','thres=-1','thres=','thres=20*2','thres=max','thres=1k','thres=nan','sizew=0','sizew=101','sizeh=-1','sizew=2.5','sizew=default','stepw=0','stepw=51','steph=1e1','threy=0','threu=201','threv=x','distance=2','distance=-1','distance=','distance=manhattan+1','distance=EUCLIDEAN','enable=1','threads=1','foo=1'])expect(()=>step(options),options).toThrow(VideoFilterParseError);
 expect(()=>step('1:2:3:4:5:6:7:8:0:9')).toThrow('Missing filter option name');expect(()=>step('sizew=101')).toThrow('outside [1 - 100]');expect(()=>step('thres=0')).toThrow('outside [1 - 200]');expect(()=>step('enable=1')).toThrow('timeline');
 expect(()=>compileVideoFilterChain('chromanr=enable=1')).toThrow(VideoFilterError);expect(()=>compileVideoFilterChain('chromanr=stepw=0')).toThrow();expect(()=>compileVideoFilterGraph('[0:v]chromanr=distance=x[o]')).toThrow();
});
it('copies luma and alpha, averages accepted chroma with native rounding (center counted twice) and applies the per-component thresholds',()=>{
 // 3x1 yuv444p, window covers all three samples. Manhattan distances from x=0: 0 (itself), 0+10+0=10, 0+100+0=100.
 const frame=yuv444([50,50,50],[100,110,200],[7,7,7],3,1);
 const out=chromanrVideoFrame(frame,step(null),{maxFrameBytes:9});
 // x=0: su=100+100+110, cn=3 -> (310+1)/3=103; x=1: (110+100+110)/3 -> (320+1)/3=107; x=2: only itself twice -> 200.
 expect(out.planes.map(p=>[...p])).toEqual([[50,50,50],[103,107,200],[7,7,7]]);expect(out.planes[0]!.buffer).not.toBe(frame.planes[0]!.buffer);
 expect(out.linesizes).toEqual([3,3,3]);expect(out.pts).toEqual(frame.pts);expect(out.pts).not.toBe(frame.pts);expect(out.metadata).toEqual({colorRange:1});expect([...frame.planes[1]!]).toEqual([100,110,200]);
 // thres truncates: 10.9 -> 10, so the distance-10 neighbour is refused (d < thres).
 expect([...chromanrVideoFrame(frame,step('thres=10.9'),{maxFrameBytes:9}).planes[1]!]).toEqual([100,110,200]);expect([...chromanrVideoFrame(frame,step('thres=11'),{maxFrameBytes:9}).planes[1]!]).toEqual([103,107,200]);
 // threu below 200 selects the extra checks on all three components: 10.5 truncates to 10, so du=10 is refused and 11 accepts it.
 expect([...chromanrVideoFrame(frame,step('threu=10.5'),{maxFrameBytes:9}).planes[1]!]).toEqual([100,110,200]);expect([...chromanrVideoFrame(frame,step('threu=11'),{maxFrameBytes:9}).planes[1]!]).toEqual([103,107,200]);
 // Manhattan 160+20=180 passes thres=200; threy=150 then refuses the luma difference of 160.
 const luma=yuv444([0,160,0],[100,120,100],[9,9,9],3,1);expect([...chromanrVideoFrame(luma,step('thres=200'),{maxFrameBytes:9}).planes[1]!]).toEqual([105,110,105]);
 expect([...chromanrVideoFrame(luma,step('thres=200:threy=150'),{maxFrameBytes:9}).planes[1]!]).toEqual([100,120,100]);
 // Euclidean: dy=3, du=4 -> sqrtf(25)=5, refused at thres=5 and accepted at thres=6, where Manhattan's 7 is still refused.
 const pythagoras=yuv444([10,13],[20,24],[0,0],2,1);
 expect([...chromanrVideoFrame(pythagoras,step('thres=5:distance=euclidean'),{maxFrameBytes:6}).planes[1]!]).toEqual([20,24]);expect([...chromanrVideoFrame(pythagoras,step('thres=6:distance=euclidean'),{maxFrameBytes:6}).planes[1]!]).toEqual([21,23]);expect([...chromanrVideoFrame(pythagoras,step('thres=6'),{maxFrameBytes:6}).planes[1]!]).toEqual([20,24]);
 // Steps start at the clipped window start: with sizew=1 and stepw=2, x=0 visits xx=0, x=1 visits 0 and 2, x=2 visits 1.
 expect([...chromanrVideoFrame(yuv444([0,0,0],[10,20,30],[0,0,0],3,1),step('thres=200:sizew=1:stepw=2'),{maxFrameBytes:9}).planes[1]!]).toEqual([10,20,25]);
 // yuva420p: luma sampled at (2x, 2y), alpha copied; 3x3 gives 2x2 chroma.
 const yuva:VideoFrameData={width:3,height:3,pixelFormat:'yuva420p',planes:[Uint8Array.of(0,9,1,9,9,9,2,9,3),Uint8Array.of(10,20,30,40),Uint8Array.of(50,50,50,50),Uint8Array.of(1,2,3,4,5,6,7,8,9)],linesizes:[3,2,2,3],pts:null,metadata:{}};
 const subsampled=chromanrVideoFrame(yuva,step('thres=200'),{maxFrameBytes:26});expect(subsampled.planes.map(p=>[...p])).toEqual([[0,9,1,9,9,9,2,9,3],[22,24,26,28],[50,50,50,50],[1,2,3,4,5,6,7,8,9]]);expect(subsampled.pts).toBeNull();
});
it('declares the native pix_fmts in declared order, plans one format-preserving stage and refuses picks without storage',()=>{
 expect(chromanrOperator.formats!(step(null))).toEqual('yuv420p yuv422p yuv440p yuv411p yuv444p yuva420p yuva422p yuva444p yuvj444p yuvj440p yuvj422p yuvj420p yuvj411p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv440p10le yuv444p10le yuv444p12le yuv422p12le yuv440p12le yuv420p12le yuv444p14le yuv422p14le yuv420p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le'.split(' '));
 expect(chromanrPixelFormats).toHaveLength(41);expect(chromanrOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
 const plan=compileVideoFilterChain('chromanr').plan('nv12',5,3);expect(plan.stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv420p'],['chromanr','yuv420p']]);expect(plan.stages[1]!.stateBytes).toBe(0);
 // Native picks yuvj444p from gray and yuva444p from packed RGB with alpha (tests/differential/video-chromanr.test.ts); neither has storage here.
 expect(()=>compileVideoFilterChain('chromanr').plan('gray',5,3)).toThrow('Video filter chromanr input negotiates yuvj444p, which is not implemented');
 for(const source of ['rgba','bgra'])expect(()=>compileVideoFilterChain('chromanr').plan(source,5,3),source).toThrow('Video filter chromanr input negotiates yuva444p, which is not implemented');
 expect(compileVideoFilterGraph('[0:v]chromanr[o]').plan({format:'rgb24',width:5,height:3},[null]).negotiated.nodes[0]!.inputs[0]!.format).toBe('yuv444p');
});
it('rejects unsupported layouts, budgets, malformed storage, bad settings and cancellation explicitly',()=>{
 const settings=step(null),frame=yuv444([1,2,3,4],[5,6,7,8],[9,10,11,12],2,2);
 for(const pixelFormat of ['gray','gbrp','nv12','rgb24','yuv420p10le'])expect(()=>chromanrVideoFrame({width:2,height:2,pixelFormat,planes:[new Uint8Array(12)],linesizes:[6],pts:null,metadata:{}},settings,{maxFrameBytes:64}),pixelFormat).toThrow();
 expect(()=>chromanrVideoFrame({width:2,height:2,pixelFormat:'gray',planes:[new Uint8Array(4)],linesizes:[2],pts:null,metadata:{}},settings,{maxFrameBytes:64})).toThrow('not supported');
 expect(()=>chromanrVideoFrame(frame,settings,{maxFrameBytes:11})).toThrow('allocation limit');expect(()=>chromanrVideoFrame(frame,settings,{maxFrameBytes:0})).toThrow('allocation limit');
 expect(()=>chromanrVideoFrame({...frame,planes:[new Uint8Array(6),frame.planes[1]!,frame.planes[2]!],linesizes:[3,2,2]},settings,{maxFrameBytes:13})).toThrow('storage exceeds');
 expect(()=>chromanrVideoFrame({...frame,planes:[new Uint8Array(3),frame.planes[1]!,frame.planes[2]!]},settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>chromanrVideoFrame({...frame,linesizes:[1,2,2]},settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>chromanrVideoFrame({...frame,linesizes:[2,2.5,2]},settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>chromanrVideoFrame({...frame,planes:frame.planes.slice(0,2)},settings,{maxFrameBytes:64})).toThrow('plane count');expect(()=>chromanrVideoFrame({...frame,planes:[[1,2,3,4] as unknown as Uint8Array,frame.planes[1]!,frame.planes[2]!]},settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>chromanrVideoFrame({...frame,pts:{value:0n,timeBase:{num:0n,den:1n}}},settings,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{...settings,thres:0},{...settings,thres:30.1},{...settings,threv:201},{...settings,sizew:0},{...settings,sizeh:101},{...settings,stepw:51},{...settings,steph:1.5},{...settings,distance:2}])expect(()=>chromanrVideoFrame(frame,bad as ChromanrStep,{maxFrameBytes:64})).toThrow('Invalid chromanr settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>chromanrVideoFrame(frame,settings,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 const plan=compileVideoFilterChain('chromanr').plan('yuv444p',2,2);expect(()=>plan.apply(frame,{maxFrameBytes:11,maxStateBytes:0})).toThrow();
 expect([...frame.planes[1]!]).toEqual([5,6,7,8]);
});
