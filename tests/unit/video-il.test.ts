import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {parseIlOptions,ilVideoFrame,ilPlaneSettings,ilOperator,VideoIlError} from '../../packages/avfilter/src/video-ops/il.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {negotiationOrder} from '../../packages/avfilter/src/video-ops/formats.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const rows=(frame:VideoFrameData,plane=0)=>Array.from({length:frame.planes[plane]!.length/frame.linesizes[plane]!},(_,y)=>frame.planes[plane]![y*frame.linesizes[plane]!]);
const budget={maxFrameBytes:4096};
it('parses declared names, aliases, shorthand order, numeric modes and booleans into frozen steps',()=>{
 const none={mode:'none',swap:false};expect(parseIlOptions(null)).toEqual({name:'il',luma:none,chroma:none,alpha:none});expect(Object.isFrozen(parseIlOptions('')))
  .toBe(true);expect(Object.isFrozen(parseIlOptions('l=d').luma)).toBe(true);
 expect(parseIlOptions('luma_mode=interleave:chroma_mode=deinterleave:alpha_mode=none:luma_swap=1:chroma_swap=true:alpha_swap=on')).toEqual({name:'il',luma:{mode:'interleave',swap:true},chroma:{mode:'deinterleave',swap:true},alpha:{mode:'none',swap:true}});
 expect(parseIlOptions('l=i:c=d:a=i:ls=yes:cs=0:as=1')).toEqual(parseIlOptions('i:d:i:1:0:1'));expect(parseIlOptions('d:c=1').chroma.mode).toBe('interleave');
 expect(parseIlOptions('l=0').luma.mode).toBe('none');expect(parseIlOptions('l=1').luma.mode).toBe('interleave');expect(parseIlOptions('l=2').luma.mode).toBe('deinterleave');expect(parseIlOptions('l=i:luma_mode=d').luma.mode).toBe('deinterleave');
 expect(parseIlOptions('ls=4294967297').luma.swap).toBe(true);expect(parseIlOptions('ls=').luma.swap).toBe(false);
 for(const options of ['l=3','l=-1','l=x','l=','l=interleaved','l=1.5','l=i+d','ls=2','ls=auto','enable=1','threads=1','foo=1','mode=i','i:d:i:1:0:1:1','l=i:d'])expect(()=>parseIlOptions(options),options).toThrow();
 expect(()=>parseIlOptions('enable=1')).toThrow(VideoFilterParseError);expect(()=>parseIlOptions('enable=1')).toThrow('timeline');expect(()=>parseIlOptions('l=3')).toThrow('integers 0 to 2');expect(()=>parseIlOptions('ls=2')).toThrow('Invalid il swap boolean');
 expect(()=>compileVideoFilterChain('il=enable=1')).toThrow();expect(()=>compileVideoFilterChain('il=foo=1')).toThrow('Unsupported il option');expect(()=>createFrameActors('il=enable=1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
 expect(ilOperator.timeline).toBeUndefined();expect(ilOperator.geometryCommands).toBeUndefined();expect(ilOperator.formats).toBeUndefined();expect(ilOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
});
it('deinterleaves, interleaves and swaps rows into owned tight planes from padded input without mutating it',()=>{
 const input=Uint8Array.from({length:24},(_,i)=>i%4===3?99:(i>>2)*10+i%4),frame=gray(input,3,6,4),snapshot=[...input];
 const run=(options:string)=>ilVideoFrame(frame,parseIlOptions(options),budget);
 expect(rows(run(''))).toEqual([0,10,20,30,40,50]);expect(rows(run('ls=1'))).toEqual([10,0,30,20,50,40]);
 expect(rows(run('l=d'))).toEqual([0,20,40,10,30,50]);expect(rows(run('l=d:ls=1'))).toEqual([10,30,50,0,20,40]);
 expect(rows(run('l=i'))).toEqual([0,30,10,40,20,50]);expect(rows(run('l=i:ls=1'))).toEqual([30,0,40,10,50,20]);
 const output=run('l=d');expect([...output.planes[0]!.subarray(0,3)]).toEqual([0,1,2]);expect(output.linesizes).toEqual([3]);expect(output.pts).toEqual(frame.pts);expect(output.pts).not.toBe(frame.pts);expect(output.metadata).toEqual({colorRange:2});expect(output.metadata).not.toBe(frame.metadata);expect(output.planes[0]!.buffer).not.toBe(input.buffer);expect([...input]).toEqual(snapshot);
 // Luma, chroma and alpha settings reach their own planes; nv12 chroma rows carry 2*ceil(w/2) bytes.
 const layout=pixelLayout('yuva420p',3,4),yuva:VideoFrameData={width:3,height:4,pixelFormat:'yuva420p',planes:layout.planes.map((plane,p)=>Uint8Array.from({length:plane.bytes},(_,i)=>p*64+Math.floor(i/plane.rowBytes))),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:null,metadata:{}};
 const mixed=ilVideoFrame(yuva,parseIlOptions('l=d:c=none:cs=1:a=i'),budget);expect([0,1,2,3].map(p=>rows(mixed,p))).toEqual([[0,2,1,3],[65,64],[129,128],[192,194,193,195]]);expect(mixed.pts).toBeNull();
 const nv=pixelLayout('nv12',3,4);expect(nv.planes[1]!.rowBytes).toBe(4);const nv12:VideoFrameData={width:3,height:4,pixelFormat:'nv12',planes:nv.planes.map((plane,p)=>Uint8Array.from({length:plane.bytes},(_,i)=>p*64+Math.floor(i/plane.rowBytes)*8+i%plane.rowBytes)),linesizes:nv.planes.map(plane=>plane.rowBytes),pts:null,metadata:{}};
 expect([...ilVideoFrame(nv12,parseIlOptions('cs=1'),budget).planes[1]!]).toEqual([72,73,74,75,64,65,66,67]);
});
it('keeps the native packed-alpha quirk: one packed plane runs as luma then alpha, so alpha settings win',()=>{
 for(const format of ['rgba','bgra','argb','abgr']){
  const frame:VideoFrameData={width:1,height:4,pixelFormat:format,planes:[Uint8Array.of(0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3)],linesizes:[4],pts:null,metadata:{}},run=(options:string)=>rows(ilVideoFrame(frame,parseIlOptions(options),budget));
  expect(run('l=d:ls=1'),format).toEqual([0,1,2,3]);expect(run('a=d'),format).toEqual([0,2,1,3]);expect(run('l=i:a=d:as=1'),format).toEqual([1,3,0,2]);expect(ilPlaneSettings(format,parseIlOptions('l=i:a=d'))).toEqual([{mode:'deinterleave',swap:false}]);
 }
 for(const format of ['rgb24','bgr24'])expect(ilPlaneSettings(format,parseIlOptions('l=i:a=d'))).toEqual([{mode:'interleave',swap:false}]);
 expect(ilPlaneSettings('gbrp',parseIlOptions('l=i:c=d:a=i')).map(plane=>plane.mode)).toEqual(['interleave','deinterleave','deinterleave']);expect(ilPlaneSettings('gray',parseIlOptions('a=d'))).toEqual([{mode:'none',swap:false}]);
 for(const format of negotiationOrder)expect(()=>ilPlaneSettings(format,parseIlOptions(null)),format).not.toThrow();for(const format of ['pal8','monob','rgb0','rgb565le'])expect(()=>ilPlaneSettings(format,parseIlOptions(null)),format).toThrow();
});
it('refuses odd processed plane heights on every path before any output',()=>{
 const step=parseIlOptions(null);
 for(const [format,height]of [['gray',7],['rgba',5],['yuv420p',6],['yuva420p',2],['nv12',10],['nv21',3],['yuv422p',3],['gbrp',1]] as const){
  expect(()=>ilOperator.geometry!(step,[{format,width:8,height}]),`${format}/${height}`).toThrow('even heights');
  expect(()=>ilVideoFrame({width:8,height,pixelFormat:format,planes:pixelLayout(format,8,height).planes.map(plane=>new Uint8Array(plane.bytes)),linesizes:pixelLayout(format,8,height).planes.map(plane=>plane.rowBytes),pts:null,metadata:{}},step,budget),`${format}/${height}`).toThrow('even heights');
  expect(()=>compileVideoFilterChain('il').plan(format,8,height),`${format}/${height}`).toThrow('even heights');
  expect(()=>compileVideoFilterGraph('[0:v]il[out]').plan({format,width:8,height},[null]),`${format}/${height}`).toThrow('even heights');
 }
 for(const [format,height]of [['gray',2],['yuv420p',4],['yuva420p',8],['nv12',12],['yuv422p',6],['rgba',2]] as const)expect(ilOperator.geometry!(step,[{format,width:5,height}])).toEqual({width:5,height});
 // A vertical half-size scale before il negotiates an odd luma height.
 expect(()=>compileVideoFilterChain('scale=8:3,il').plan('gray',8,8)).toThrow('even heights');expect(()=>planTimedVideoGraph('scale=8:3,il',[{geometry:{format:'gray',width:8,height:8},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}],[null])).toThrow('even heights');
});
it('rejects budgets, malformed strides, plane counts, time bases and cancellation explicitly',()=>{
 const step=parseIlOptions('l=d');
 expect(()=>ilVideoFrame(gray(new Uint8Array(6),3,2),step,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>ilVideoFrame(gray(new Uint8Array(8),3,2,4),step,{maxFrameBytes:7})).toThrow('storage exceeds');expect(()=>ilVideoFrame(gray(new Uint8Array(6),3,2),step,{maxFrameBytes:0})).toThrow('allocation limit');
 expect(()=>ilVideoFrame(gray(new Uint8Array(5),3,2),step,budget)).toThrow('stride or storage');expect(()=>ilVideoFrame(gray(new Uint8Array(6),3,2,2),step,budget)).toThrow('stride or storage');expect(()=>ilVideoFrame(gray(new Uint8Array(6),3,2,1.5),step,budget)).toThrow('stride or storage');
 expect(()=>ilVideoFrame({...gray(new Uint8Array(6),3,2),planes:[new Uint8Array(6),new Uint8Array(6)]},step,budget)).toThrow('plane count');expect(()=>ilVideoFrame({...gray(new Uint8Array(6),3,2),planes:[[0,0,0,0,0,0] as unknown as Uint8Array]},step,budget)).toThrow('stride or storage');
 expect(()=>ilVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},step,budget)).toThrow('time base');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>ilVideoFrame(gray(new Uint8Array(6),3,2),step,{...budget,signal:controller.signal})).toThrow('stop');
 const plan=compileVideoFilterChain('il=l=d,hflip,il=l=i').plan('gray',5,4),frame=gray(Uint8Array.from({length:20},(_,i)=>i),5,4);expect(plan.stages.map(stage=>stage.operation)).toEqual(['il','hflip','il']);expect(plan.stateBytes).toBe(0);
 expect([...plan.apply(frame,{maxFrameBytes:20,maxStateBytes:0}).planes[0]!]).toEqual([4,3,2,1,0,9,8,7,6,5,14,13,12,11,10,19,18,17,16,15]);expect(()=>plan.apply(frame,{maxFrameBytes:19,maxStateBytes:0})).toThrow();
 expect(VideoIlError.prototype).toBeInstanceOf(Error);
});
