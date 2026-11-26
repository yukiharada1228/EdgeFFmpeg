import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph,videoOperator,VideoFilterError} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {chromakeyUV,chromakeyVideoFrame,chromaholdVideoFrame,parseChromakeyOptions} from '../../packages/avfilter/src/video-chromakey.js';
import type {ChromakeySettings} from '../../packages/avfilter/src/video-chromakey.js';
import {chromakeyOperator} from '../../packages/avfilter/src/video-ops/chromakey.js';
import {chromaholdOperator} from '../../packages/avfilter/src/video-ops/chromahold.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
const key=(options:string|null)=>parseChromakeyOptions('chromakey',options),hold=(options:string|null)=>parseChromakeyOptions('chromahold',options);
const time={num:1n,den:25n};
/** yuva420p with padded strides: luma/alpha w x h, chroma ceil(w/2) x ceil(h/2). */
function yuva(width:number,height:number,u:readonly number[],v:readonly number[],pad=0):VideoFrameData{
 const cw=(width+1)>>1,ch=(height+1)>>1,plane=(w:number,h:number,values:(i:number)=>number)=>{const data=new Uint8Array((w+pad)*h).fill(211);for(let y=0;y<h;y++)for(let x=0;x<w;x++)data[y*(w+pad)+x]=values(y*w+x);return data;};
 return {width,height,pixelFormat:'yuva420p',planes:[plane(width,height,i=>i*7&255),plane(cw,ch,i=>u[i]!),plane(cw,ch,i=>v[i]!),plane(width,height,()=>77)],linesizes:[width+pad,cw+pad,cw+pad,width+pad],pts:{value:9007199254740993n,timeBase:time},metadata:{colorRange:1}};
}
it('parses defaults, shorthand order, colors, float ranges, booleans and threads=1 into frozen steps',()=>{
 expect(key(null)).toEqual({name:'chromakey',color:[0,0,0,255],similarity:Math.fround(0.01),blend:0,yuv:false,threads:0});expect(Object.isFrozen(key(''))).toBe(true);
 expect(key('green:0.1:0.2:1')).toEqual({name:'chromakey',color:[0,128,0,255],similarity:Math.fround(0.1),blend:Math.fround(0.2),yuv:true,threads:0});
 expect(hold('color=#11223344:similarity=1:blend=1:yuv=false:threads=1')).toEqual({name:'chromahold',color:[0x11,0x22,0x33,0x44],similarity:1,blend:1,yuv:false,threads:1});
 expect(key('similarity=0.00001').similarity).toBe(Math.fround(0.00001));expect(key('blend=0').blend).toBe(0);expect(key('blend=-0').blend).toBe(0);expect(Object.is(key('blend=-0').blend,0)).toBe(true);
 expect(key('red@0.5:yuv=yes').yuv).toBe(true);expect(key('yuv=on:yuv=0').yuv).toBe(false);expect(key('threads=001').threads).toBe(1);expect(key('color=0x00ff00:color=blue').color).toEqual([0,0,255,255]);
 expect(chromakeyOperator.parse!({name:'chromakey',options:'green',inputs:[],outputs:[]} as never).configuration).toEqual(key('green'));expect(videoOperator('chromakey')).toBe(chromakeyOperator);expect(videoOperator('chromahold')).toBe(chromaholdOperator);
});
it('converts the key with the native integer RGB_TO_U/RGB_TO_V macros or takes it as YUV',()=>{
 expect(chromakeyUV(key('green'))).toEqual([86,74]);expect(chromakeyUV(key('blue'))).toEqual([255,107]);expect(chromakeyUV(key('red'))).toEqual([85,255]);expect(chromakeyUV(key('white'))).toEqual([128,128]);expect(chromakeyUV(key('black'))).toEqual([128,128]);
 expect(chromakeyUV(key('0x00ff00'))).toEqual([44,21]);expect(chromakeyUV(key('0x123456:yuv=1'))).toEqual([0x34,0x56]);
});
it('refuses invalid and unsupported colors, out-of-range and expression floats, timeline, threads and unknown options explicitly',()=>{
 for(const options of ['nosuchcolor','#ff00','red@1.5','random','bikeshed','red@nan','similarity=0','similarity=0.000009','similarity=1.1','similarity=-1','blend=-0.1','blend=2','similarity=1/2','similarity=0.1+0.1','similarity=PI','blend=1k','similarity=','blend=0x1','yuv=2','yuv=maybe','yuv=auto','threads=0','threads=2','threads=auto','enable=1','foo=1','sim=0.5'])for(const parse of [key,hold])expect(()=>parse(options),options).toThrow(VideoFilterParseError);
 expect(()=>key('nosuchcolor')).toThrow("Cannot find color 'nosuchcolor'");expect(()=>key('random')).toThrow('not supported');expect(()=>key('similarity=0')).toThrow('out of range');expect(()=>key('enable=1')).toThrow('timeline');expect(()=>key('threads=2')).toThrow('threads=1');
 expect(()=>key('green:0.1:0.2:1:5')).toThrow();
 expect(()=>compileVideoFilterChain('chromakey=enable=1')).toThrow(VideoFilterError);expect(()=>compileVideoFilterGraph('[0:v]chromahold=similarity=2[o]')).toThrow();
});
it('declares the native pix_fmts in declared order and refuses picks without storage and tall default-thread chromakey before output',()=>{
 expect(chromakeyOperator.formats!(key(null))).toEqual('yuva420p yuva422p yuva444p yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le'.split(' '));
 expect(chromaholdOperator.formats!(hold(null))).toEqual('yuv420p yuv422p yuv444p yuva420p yuva422p yuva444p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv444p12le yuv422p12le yuv420p12le yuv444p14le yuv422p14le yuv420p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le'.split(' '));
 for(const op of [chromakeyOperator,chromaholdOperator])expect(op.paths).toEqual(['linear','graph','stream','actor','timed']);
 const plan=compileVideoFilterChain('chromakey=threads=1').plan('yuva420p',5,3);expect(plan.stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['chromakey','yuva420p']]);
 expect(compileVideoFilterChain('chromakey').plan('yuva420p',17,1).stages.map(stage=>stage.operation)).toEqual(['chromakey']);
 // Native picks yuva444p from packed RGB with alpha (tests/differential/video-chromakey.test.ts), which has no frame storage here.
 expect(()=>compileVideoFilterChain('chromakey=threads=1').plan('rgba',5,3)).toThrow('Video filter chromakey input negotiates yuva444p, which is not implemented');
 const tall='Chromakey frames taller than one row need threads=1';
 expect(()=>compileVideoFilterChain('chromakey=green').plan('yuva420p',5,2)).toThrow(tall);expect(()=>compileVideoFilterGraph('[0:v]chromakey[o]').plan({format:'yuva420p',width:2,height:2},[null])).toThrow(tall);
 expect(()=>planTimedVideoGraph('chromakey=red',[{geometry:{format:'yuva420p',width:4,height:4},timeBase:time,frameRate:{num:25n,den:1n}}],[null])).toThrow(tall);
 expect(compileVideoFilterChain('chromahold').plan('yuv422p',5,3).stages.map(stage=>[stage.operation,stage.pixelFormat])).toEqual([['chromahold','yuv422p']]);
});
it('keys alpha over the 3x3 luma-coordinate neighbourhood with stale out-of-frame window slots',()=>{
 // 3x1 yuva420p: chroma 2x1. Key green = (86,74). Window slots outside the frame keep the key or the slot's last value.
 const frame=yuva(3,1,[86,86+30],[74,74]),out=chromakeyVideoFrame(frame,key('green:0.01'),{maxFrameBytes:64});
 const d=Math.sqrt(900/130050);
 // x=0: slots (1,0)=key, (1,1)=(1,2)=col0>>1=0 => diff 0; x=1: (1,2)=col 2>>1=1 => diff d/9; x=2: (1,1),(1,2)=col1 (stale slot 2 keeps col 2).
 expect([...out.planes[3]!]).toEqual([0,d/9>Math.fround(0.01)?255:0,2*d/9>Math.fround(0.01)?255:0]);
 const ramp=chromakeyVideoFrame(frame,key('green:0.001:0.1'),{maxFrameBytes:64});expect([...ramp.planes[3]!]).toEqual([0,Math.trunc(Math.min(1,(d/9-Math.fround(0.001))/Math.fround(0.1))*255),Math.trunc(Math.min(1,(2*d/9-Math.fround(0.001))/Math.fround(0.1))*255)]);
 expect([...out.planes[0]!]).toEqual([0,7,14]);expect([...out.planes[1]!]).toEqual([86,116]);expect(out.linesizes).toEqual([3,2,2,3]);expect(out.pts).toEqual(frame.pts);expect(out.pts).not.toBe(frame.pts);expect(out.metadata).toEqual({colorRange:1});
 // Padded input strides; input not mutated; output planes owned.
 const padded=yuva(4,3,[86,86,10,200],[74,74,250,74],3),before=padded.planes.map(plane=>[...plane]),tall=chromakeyVideoFrame(padded,key('green:0.2:0:threads=1'),{maxFrameBytes:64});
 expect(padded.planes.map(plane=>[...plane])).toEqual(before);for(const [index,plane]of tall.planes.entries())expect(plane.buffer).not.toBe(padded.planes[index]!.buffer);expect(tall.planes[3]!.length).toBe(12);
});
it('moves held chroma toward 128 over (w>>hsub) x (h>>vsub) samples and keeps the trailing odd column',()=>{
 const frame:VideoFrameData={width:3,height:1,pixelFormat:'yuv422p',planes:[Uint8Array.of(1,2,3),Uint8Array.of(86,200),Uint8Array.of(74,30)],linesizes:[3,2,2],pts:null,metadata:{}};
 expect(chromaholdVideoFrame(frame,hold('green:0.01'),{maxFrameBytes:64}).planes.map(plane=>[...plane])).toEqual([[1,2,3],[86,200],[74,30]]);
 const even={...frame,width:4,planes:[Uint8Array.of(1,2,3,4),Uint8Array.of(86,200),Uint8Array.of(74,30)],linesizes:[4,2,2]};
 expect(chromaholdVideoFrame(even,hold('green:0.01'),{maxFrameBytes:64}).planes.map(plane=>[...plane])).toEqual([[1,2,3,4],[86,128],[74,128]]);
 const du=200-86,dv=30-74,diff=Math.sqrt((du*du+dv*dv)/130050),f=1-Math.min(1,Math.max(0,(diff-Math.fround(0.3))/Math.fround(0.2)));
 expect(chromaholdVideoFrame(even,hold('green:0.3:0.2'),{maxFrameBytes:64}).planes.map(plane=>[...plane])).toEqual([[1,2,3,4],[86,Math.trunc(128+72*f)],[74,Math.trunc(128-98*f)]]);
 expect([...frame.planes[1]!]).toEqual([86,200]);
});
it('rejects unsupported layouts, budgets, malformed storage, bad settings and cancellation explicitly',()=>{
 const settings=key('threads=1'),frame=yuva(2,2,[1],[2]);
 for(const pixelFormat of ['yuv420p','yuva444p','rgba','gray'])expect(()=>chromakeyVideoFrame({...frame,pixelFormat},settings,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 for(const pixelFormat of ['yuva444p','nv12','gray','yuv420p10le'])expect(()=>chromaholdVideoFrame({...frame,pixelFormat},hold(null),{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>chromakeyVideoFrame(frame,settings,{maxFrameBytes:9})).toThrow('allocation limit');expect(()=>chromakeyVideoFrame(frame,settings,{maxFrameBytes:0})).toThrow('allocation limit');expect(()=>chromakeyVideoFrame(yuva(2,2,[1],[2],20),settings,{maxFrameBytes:64})).toThrow('storage exceeds');
 expect(()=>chromakeyVideoFrame({...frame,linesizes:[1,1,1,2]},settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>chromakeyVideoFrame({...frame,linesizes:[2.5,1,1,2]},settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>chromakeyVideoFrame({...frame,planes:[frame.planes[0]!,new Uint8Array(0),frame.planes[2]!,frame.planes[3]!]},settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>chromakeyVideoFrame({...frame,planes:frame.planes.slice(0,3)},settings,{maxFrameBytes:64})).toThrow('plane count');
 expect(()=>chromakeyVideoFrame({...frame,planes:[[0,0,0,0] as unknown as Uint8Array,...frame.planes.slice(1)]},settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>chromakeyVideoFrame({...frame,pts:{value:0n,timeBase:{num:0n,den:1n}}},settings,{maxFrameBytes:64})).toThrow('time base');
 expect(()=>chromakeyVideoFrame(frame,key(null),{maxFrameBytes:64})).toThrow('taller than one row');
 for(const bad of [{...settings,similarity:0},{...settings,similarity:0.1},{...settings,blend:2},{...settings,color:[256,0,0,0]},{...settings,yuv:1},{...settings,threads:2},{...settings,name:'chromahold'}])expect(()=>chromakeyVideoFrame(frame,bad as unknown as ChromakeySettings,{maxFrameBytes:64}),JSON.stringify(bad)).toThrow('Invalid');
 expect(()=>chromaholdVideoFrame(frame,settings,{maxFrameBytes:64})).toThrow('Invalid chromahold settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>chromakeyVideoFrame(frame,settings,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');expect(()=>chromaholdVideoFrame(frame,hold(null),{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 const plan=compileVideoFilterChain('chromahold').plan('yuva420p',2,2);expect(()=>plan.apply(frame,{maxFrameBytes:9,maxStateBytes:0})).toThrow();
});
