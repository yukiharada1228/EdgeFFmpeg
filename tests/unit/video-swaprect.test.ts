import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph,videoOperator,VideoFilterError} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {parseSwaprectOptions,swaprectPlanes,swaprectVideoFrame,swaprectOperator,VideoSwaprectError} from '../../packages/avfilter/src/video-ops/swaprect.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {negotiableFormats} from '../../packages/avfilter/src/video-ops/formats.js';
const time={num:1n,den:25n};
const gray=(data:Uint8Array,width:number,height:number,stride=width,pts:VideoFrameData['pts']={value:1n,timeBase:time}):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts,metadata:{colorRange:2}});
const step=(options:string|null)=>parseSwaprectOptions(options);
const ramp=(length:number)=>Uint8Array.from({length},(_,i)=>i);
it('parses defaults, shorthand order and repeated keys into frozen steps',()=>{
 expect(step(null)).toEqual({name:'swaprect',w:'w/2',h:'h/2',x1:'w/2',y1:'h/2',x2:'0',y2:'0'});expect(Object.isFrozen(step(''))).toBe(true);
 expect(step('1:2:3:4:5:6')).toEqual({name:'swaprect',w:'1',h:'2',x1:'3',y1:'4',x2:'5',y2:'6'});expect(step('4:y2=h-1')).toMatchObject({w:'4',h:'h/2',y2:'h-1'});expect(step('x1=2:x1=3').x1).toBe('3');
 expect(step('w=max(2\\,3)').w).toBe('max(2,3)');expect(step('w=a*2:h=log(4)+hypot(3\\,4):x1=t*25').h).toBe('log(4)+hypot(3,4)');
 expect(swaprectOperator.parse!({name:'swaprect',options:'2:3',inputs:[],outputs:[]} as never).configuration).toEqual(step('2:3'));expect(videoOperator('swaprect')).toBe(swaprectOperator);
});
it('refuses invalid expressions, n, sar, dar, unported functions, the timeline and unknown options explicitly',()=>{
 for(const options of ['w=','w=foo','w=1+','w=(2','x2=)','enable=1','threads=1','foo=1','w=n','h=n*2','x1=if(n\\,1\\,2)','w=sar','y1=dar*2','w=sin(1)','w=cos(0)','w=tan(0)','w=asin(0)','w=acos(1)','w=atan(0)','w=atan2(1\\,1)','w=sinh(0)','w=cosh(0)','w=tanh(0)','w=exp(0)','w=pow(2\\,2)','w=2^2','w=gauss(0)','w=squish(0)','x1=time(0)','w= sin (1)'])expect(()=>step(options),options).toThrow(VideoFilterParseError);
 for(const options of ['1:2:3:4:5:6:7','w=2:3'])expect(()=>step(options),options).toThrow('Missing filter option name');
 expect(()=>step('w=n+1')).toThrow('reading n');expect(()=>step('w=dar')).toThrow('sar or dar');expect(()=>step('w=exp(1)')).toThrow('libm');expect(()=>step('enable=1')).toThrow('timeline');
 // Names are whole identifiers: wn, na and sart are not n or sar and fail to parse; nan is a literal.
 for(const options of ['w=wn','w=na','w=sart'])expect(()=>step(options),options).toThrow('Invalid swaprect w expression');expect(step('w=nan').w).toBe('nan');
 expect(()=>compileVideoFilterChain('swaprect=enable=1')).toThrow(VideoFilterError);expect(()=>compileVideoFilterGraph('[0:v]swaprect=w=n[o]')).toThrow();
});
it('evaluates, clamps and rounds rectangles to the chroma grid as filter_frame does',()=>{
 // Defaults on 5x3 yuv420p: w=2,h=1 at (2,1) and (0,0); chroma aw=ceil(2/2)=1, ah=ceil(1/2)=1, x1>>1=1, y1>>1=0.
 expect(swaprectPlanes(step(null),'yuv420p',5,3,null)).toEqual([{plane:0,x1:2,y1:1,x2:0,y2:0,width:2,height:1,step:1},{plane:1,x1:1,y1:0,x2:0,y2:0,width:1,height:1,step:1},{plane:2,x1:1,y1:0,x2:0,y2:0,width:1,height:1,step:1}]);
 // Clamped widths skip a plane whose rounded size changes: w=3 at x1=3 on width 5 clamps to 2; luma 2!=3 but chroma ceil(2/2)=1 != ceil(3/2)=2, so nothing swaps.
 expect(swaprectPlanes(step('3:1:3:0:0:0'),'yuv420p',5,3,null)).toEqual([]);
 // w=4 at x1=1 on width 4 clamps to 3: luma 3!=4, chroma ceil(3/2)=2==ceil(4/2)=2, so the chroma planes swap alone.
 expect(swaprectPlanes(step('4:2:1:0:0:0'),'yuv420p',4,2,null).map(p=>p.plane)).toEqual([1,2]);
 // Coordinates clamp to the frame, fractions truncate toward zero, packed and semi-planar steps follow the max pixel step.
 expect(swaprectPlanes(step('w=1.9:h=1:x1=-7.5:y1=99:x2=w+5:y2=0.5'),'rgb24',4,3,null)).toEqual([{plane:0,x1:0,y1:2,x2:3,y2:0,width:1,height:1,step:3}]);
 expect(swaprectPlanes(step('2:2:2:2:0:0'),'nv12',4,4,null).map(p=>[p.plane,p.step,p.x1,p.width])).toEqual([[0,1,2,2],[1,2,1,1]]);
 expect(swaprectPlanes(step('2:2:0:0:1:1'),'yuva420p',3,3,null).map(p=>p.plane)).toEqual([0,1,2,3]);
 // a is (float)w/h; t is pts * av_q2d(time_base), NaN without pts.
 expect(swaprectPlanes(step('w=1:h=1:x1=a*1000'),'gray',3,7,null)[0]!.x1).toBe(2);expect(swaprectPlanes(step('w=1:h=1:x1=a*1e7:y1=0'),'gray',7,3,null)[0]!.x1).toBe(6);
 expect(swaprectPlanes(step('w=1:h=1:x1=t*25:y1=0'),'gray',8,1,{value:3n,timeBase:time})[0]!.x1).toBe(3);expect(()=>swaprectPlanes(step('w=t'),'gray',8,1,null)).toThrow('outside int');
 // Zero and negative heights copy no rows; negative widths with positive heights are native memory faults.
 expect(swaprectPlanes(step('w=0:h=2'),'gray',4,4,null)).toEqual([]);expect(swaprectPlanes(step('w=-3:h=0'),'gray',4,4,null)).toEqual([]);expect(swaprectPlanes(step('w=2:h=-1'),'gray',4,4,null)).toEqual([]);
 for(const options of ['w=-1:h=1','w=-3:h=2','w=1/0','w=-1/0','w=3e9','w=nan','x1=2147483648','w=-2147483648:h=0'])expect(()=>swaprectPlanes(step(options),'gray',4,4,null),options).toThrow(VideoSwaprectError);
 expect(swaprectPlanes(step('w=1:h=1:x1=-2147483648'),'gray',4,4,null)[0]!.x1).toBe(0);
});
it('swaps in place row by row with native memmove order, including overlapping rectangles, into owned planes',()=>{
 const input=Uint8Array.of(0,1,2,3,99,10,11,12,13,99,20,21,22,23,99),frame=gray(input,4,3,5);
 expect([...swaprectVideoFrame(frame,step('1:1:0:0:3:2'),{maxFrameBytes:15}).planes[0]!]).toEqual([23,1,2,3,10,11,12,13,20,21,22,0]);
 // Same row overlap: temp=src, memmove(src,dst), memcpy(dst,temp).
 expect([...swaprectVideoFrame(frame,step('3:1:0:0:1:0'),{maxFrameBytes:15}).planes[0]!.subarray(0,4)]).toEqual([1,0,1,2]);
 // Vertical overlap: row 0 swaps with row 1, then row 1 (already holding row 0) swaps with row 2.
 expect([...swaprectVideoFrame(frame,step('2:2:0:0:0:1'),{maxFrameBytes:15}).planes[0]!]).toEqual([10,11,2,3,20,21,12,13,0,1,22,23]);
 const copy=swaprectVideoFrame(frame,step('w=0'),{maxFrameBytes:15});expect([...copy.planes[0]!]).toEqual([0,1,2,3,10,11,12,13,20,21,22,23]);expect(copy.planes[0]!.buffer).not.toBe(input.buffer);
 expect(copy.linesizes).toEqual([4]);expect(copy.pts).toEqual(frame.pts);expect(copy.pts).not.toBe(frame.pts);expect(copy.metadata).toEqual({colorRange:2});expect([...input]).toEqual([0,1,2,3,99,10,11,12,13,99,20,21,22,23,99]);
 const rgb=swaprectVideoFrame({width:2,height:1,pixelFormat:'rgb24',planes:[ramp(6)],linesizes:[6],pts:null,metadata:{}},step('1:1:0:0:1:0'),{maxFrameBytes:6});expect([...rgb.planes[0]!]).toEqual([3,4,5,0,1,2]);expect(rgb.pts).toBeNull();
 const nv=swaprectVideoFrame({width:4,height:2,pixelFormat:'nv12',planes:[ramp(8),Uint8Array.of(50,51,52,53)],linesizes:[4,4],pts:null,metadata:{}},step('2:2:0:0:2:0'),{maxFrameBytes:15});expect(nv.planes.map(p=>[...p])).toEqual([[2,3,0,1,6,7,4,5],[52,53,50,51]]);
});
it('declares the native pixdesc list in AVPixelFormat order and plans one format-preserving stage on every path',()=>{
 const formats=swaprectOperator.formats!(step(null));expect(formats).toEqual(negotiableFormats.filter(f=>!['monow','monob','pal8','bgr4','rgb4','xv30be','v30xbe'].includes(f)));expect(formats).toContain('yuyv422');expect(formats).toContain('xv30le');expect(formats).toHaveLength(244);
 expect(swaprectOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
 const plan=compileVideoFilterChain('swaprect').plan('nv12',5,3);expect(plan.stages.map(stage=>[stage.operation,stage.pixelFormat])).toEqual([['swaprect','nv12']]);expect(plan.stages[0]!.stateBytes).toBe(0);
 expect(compileVideoFilterGraph('[0:v]swaprect[o]').plan({format:'rgb24',width:5,height:3},[null]).negotiated.nodes[0]!.inputs[0]!.format).toBe('rgb24');
 // t reaches the operator with native timestamps only on the actor and timed paths; plan-time refusals elsewhere.
 for(const plan of [()=>compileVideoFilterChain('swaprect=x1=t').plan('gray',4,4),()=>compileVideoFilterGraph('[0:v]swaprect=y2=t*25[o]').plan({format:'gray',width:4,height:4},[null])])expect(plan).toThrow('actor and timed paths only');
 expect(()=>planTimedVideoGraph('swaprect=x1=t*25',[{geometry:{format:'gray',width:4,height:4},timeBase:time,frameRate:{num:25n,den:1n}}],[null])).not.toThrow();
 // Time-independent refusals surface at plan time on every path.
 expect(()=>compileVideoFilterChain('swaprect=w=-1:h=1').plan('gray',4,4)).toThrow(VideoFilterError);expect(()=>compileVideoFilterGraph('[0:v]swaprect=w=1/0[o]').plan({format:'gray',width:4,height:4},[null])).toThrow('outside int');
 expect(()=>planTimedVideoGraph('swaprect=w=-2:h=1',[{geometry:{format:'gray',width:4,height:4},timeBase:time,frameRate:{num:25n,den:1n}}],[null])).toThrow('negative widths');
});
it('rejects unsupported layouts, budgets, malformed storage, bad time bases and cancellation explicitly',()=>{
 const settings=step('1:1'),frame=gray(new Uint8Array(6),3,2);
 for(const pixelFormat of ['yuyv422','yuv420p10le','pal8'])expect(()=>swaprectVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},settings,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>swaprectVideoFrame(frame,settings,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>swaprectVideoFrame(frame,settings,{maxFrameBytes:0})).toThrow('allocation limit');expect(()=>swaprectVideoFrame(gray(new Uint8Array(8),3,2,4),settings,{maxFrameBytes:7})).toThrow('storage exceeds');
 expect(()=>swaprectVideoFrame(gray(new Uint8Array(5),3,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>swaprectVideoFrame(gray(new Uint8Array(6),3,2,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>swaprectVideoFrame(gray(new Uint8Array(6),3,2,1.5),settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>swaprectVideoFrame({...frame,planes:[]},settings,{maxFrameBytes:64})).toThrow('plane count');expect(()=>swaprectVideoFrame({...frame,planes:[[0,0,0,0,0,0] as unknown as Uint8Array]},settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>swaprectVideoFrame({...frame,pts:{value:0n,timeBase:{num:0n,den:1n}}},settings,{maxFrameBytes:64})).toThrow('time base');
 expect(()=>swaprectVideoFrame(frame,step('w=-1:h=1'),{maxFrameBytes:64})).toThrow(VideoSwaprectError);expect(()=>swaprectVideoFrame({...frame,pts:null},step('x1=t'),{maxFrameBytes:64})).toThrow('outside int');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>swaprectVideoFrame(frame,settings,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 const plan=compileVideoFilterChain('swaprect').plan('gray',3,2);expect(()=>plan.apply(frame,{maxFrameBytes:5,maxStateBytes:0})).toThrow();
});
