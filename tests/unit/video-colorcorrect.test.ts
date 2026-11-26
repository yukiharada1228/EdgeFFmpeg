import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {colorcorrectOperator,colorcorrectPixelFormats,colorcorrectVideoFrame,parseColorcorrectOptions} from '../../packages/avfilter/src/video-ops/colorcorrect.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
const f=Math.fround;
/** Planar 8-bit YUV(A) with every plane padded to `stride` and filled with 0xee past each row. */
function yuv(format:'yuv420p'|'yuv422p'|'yuv444p'|'yuva420p',width:number,height:number,luma:readonly number[],u:readonly number[],v:readonly number[],stride=width):VideoFrameData{
 const cw=format==='yuv444p'?width:(width+1)>>1,ch=format==='yuv420p'||format==='yuva420p'?(height+1)>>1:height;
 const pad=(values:readonly number[],w:number,h:number)=>{const out=new Uint8Array(stride*(h-1)+w).fill(0xee);for(let y=0;y<h;y++)for(let x=0;x<w;x++)out[y*stride+x]=values[y*w+x]!;return out;};
 const planes=[pad(luma,width,height),pad(u,cw,ch),pad(v,cw,ch)];if(format==='yuva420p')planes.push(pad(luma.map(value=>255-value),width,height));
 return {width,height,pixelFormat:format,planes,linesizes:planes.map(()=>stride),pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:1}};
}
it('parses declared defaults, shorthand, named options, constants, float storage, ranges and refusals',()=>{
 expect(parseColorcorrectOptions(null)).toEqual({name:'colorcorrect',rl:0,bl:0,rh:0,bh:0,saturation:1,analyze:'manual'});expect(Object.isFrozen(parseColorcorrectOptions(''))).toBe(true);
 expect(parseColorcorrectOptions('0.5:-0.25:0.75:-1:2.5:median')).toEqual({name:'colorcorrect',rl:0.5,bl:-0.25,rh:0.75,bh:-1,saturation:2.5,analyze:'median'});
 // AV_OPT_TYPE_FLOAT stores the double rounded to single precision.
 const step=parseColorcorrectOptions('rl=0.1:bl=-0.2:saturation=1.1');expect(step.rl).toBe(f(0.1));expect(step.rl).not.toBe(0.1);expect(step.bl).toBe(f(-0.2));expect(step.saturation).toBe(f(1.1));
 expect(parseColorcorrectOptions('rl=max:bl=min:rh=all:bh=none:saturation=min')).toMatchObject({rl:1,bl:-1,rh:-1,bh:0,saturation:-3});expect(parseColorcorrectOptions('saturation=0:saturation=default').saturation).toBe(1);
 expect(parseColorcorrectOptions('saturation=max').saturation).toBe(3);expect(parseColorcorrectOptions('rl=5e-1:bh=.5:rh=+1.').rl).toBe(0.5);expect(Object.is(parseColorcorrectOptions('bl=-0').bl,-0)).toBe(true);
 for(const [text,mode]of [['manual','manual'],['minmax','minmax'],['median','median'],['0','manual'],['2','minmax'],['3','median'],['2.4','minmax'],['2.5','minmax'],['0.5','manual'],['default','manual'],['max','median'],['min','manual'],['none','manual']] as const)expect(parseColorcorrectOptions(`analyze=${text}`).analyze,text).toBe(mode);
 for(const [options,message]of [['rl=1.01','Invalid colorcorrect rl'],['bl=-2','Invalid colorcorrect bl'],['rh=1e9','Invalid colorcorrect rh'],['bh=-1.5','Invalid colorcorrect bh'],['saturation=3.01','Invalid colorcorrect saturation'],['saturation=-4','Invalid colorcorrect saturation'],
  ['analyze=4','Invalid colorcorrect analyze'],['analyze=-1','Invalid colorcorrect analyze'],['analyze=3.6','Invalid colorcorrect analyze'],['analyze=3.4','Invalid colorcorrect analyze'],['analyze=all','Invalid colorcorrect analyze'],['analyze=average','analyze=average is not implemented'],['analyze=1','analyze=average'],['analyze=1.4','analyze=average'],['analyze=0.6','analyze=average'],['analyze=bogus','Only constant colorcorrect analyze'],
  ['rl=1/3','Only constant decimal colorcorrect rl'],['saturation=0x1','Only constant decimal colorcorrect saturation'],['bh=abc','Only constant decimal'],['rl=','Only constant decimal'],['bl=1e','Only constant decimal'],['rl=bl','Only constant decimal'],['rl=nan','Only constant decimal'],
  ['enable=1','timeline'],['enable=between(t,0,1)','timeline'],['threads=1','Unsupported colorcorrect option'],['foo=1','Unsupported colorcorrect option'],['0:0:0:0:1:0:0','']] as const)expect(()=>parseColorcorrectOptions(options),options).toThrow(message);
 expect(()=>parseColorcorrectOptions('rl=2')).toThrow(VideoFilterParseError);expect(()=>parseColorcorrectOptions('analyze=average')).toThrow(VideoFilterParseError);
 // The pinned vf_colorcorrect.c pixel_fmts in declared order.
 expect(colorcorrectPixelFormats).toEqual('yuv420p yuv422p yuv440p yuv411p yuv444p yuva420p yuva422p yuva444p yuvj444p yuvj440p yuvj422p yuvj420p yuvj411p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv440p10le yuv444p10le yuv444p12le yuv422p12le yuv440p12le yuv420p12le yuv444p14le yuv422p14le yuv420p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le'.split(' '));
 expect(colorcorrectOperator.formats!(parseColorcorrectOptions(null))).toBe(colorcorrectPixelFormats);expect(Object.isFrozen(colorcorrectPixelFormats)).toBe(true);
 expect(videoOperator('colorcorrect')).toBe(colorcorrectOperator);expect(colorcorrectOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(colorcorrectOperator.timeline).toBeUndefined();expect(colorcorrectOperator.geometryCommands).toBeUndefined();
});
it('scales chroma in unfused single precision, copies luma and alpha, and keeps padded input unchanged',()=>{
 // Defaults are not an identity: (c / 255 - 0.5 + 0.5) * 255 truncates to c - 1 for c = 1..47.
 const ramp=Array.from({length:256},(_,i)=>i),frame=yuv('yuv444p',16,16,ramp.map(i=>(i*7)&255),ramp,ramp.map(i=>255-i),20),before=frame.planes.map(plane=>[...plane]);
 const actual=colorcorrectVideoFrame(frame,parseColorcorrectOptions(null),{maxFrameBytes:1024});
 expect([...actual.planes[1]!]).toEqual(ramp.map(c=>c>=1&&c<=47?c-1:c));expect([...actual.planes[2]!]).toEqual(ramp.map(c=>255-c).map(c=>c>=1&&c<=47?c-1:c));expect([...actual.planes[0]!]).toEqual(ramp.map(i=>(i*7)&255));
 expect(actual.linesizes).toEqual([16,16,16]);expect(actual.pts).toEqual(frame.pts);expect(actual.pts).not.toBe(frame.pts);expect(actual.metadata).toEqual({colorRange:1});expect(actual.pixelFormat).toBe('yuv444p');
 expect(frame.planes.map(plane=>[...plane])).toEqual(before);for(const plane of actual.planes)expect(frame.planes.some(input=>input.buffer===plane.buffer)).toBe(false);
 // A fused multiply-subtract for u (as an arm64 contraction gives) changes 15 of the default outputs, so native comparisons are gated to linux-x64.
 const imax=f(1/255),fused=ramp.filter(c=>Math.trunc(f(f(f(c*imax-0.5)+0.5)*255))!==Math.trunc(f(f(f(f(c*imax)-0.5)+0.5)*255)));expect(fused.length).toBe(15);
 // rl=0.1:bl=-0.2:rh=0.3:bh=-0.05:saturation=1.5 from (Y, U, V); the luma sample at x * chroma_w of row y * chroma_h.
 const typical=parseColorcorrectOptions('0.1:-0.2:0.3:-0.05:1.5');
 expect([...colorcorrectVideoFrame(yuv('yuv444p',4,1,[0,255,128,16],[0,255,128,200],[0,255,128,40]),typical,{maxFrameBytes:12}).planes.slice(1).flatMap(plane=>[...plane])]).toEqual([0,255,80,163,0,255,204,39]);
 const sub=colorcorrectVideoFrame(yuv('yuv420p',3,3,[128,0,16,0,0,0,255,0,0],[128,200,255,255],[128,40,255,255]),typical,{maxFrameBytes:19});
 expect([...sub.planes[1]!,...sub.planes[2]!]).toEqual([80,163,255,242,204,39,255,255]);expect([...sub.planes[0]!]).toEqual([128,0,16,0,0,0,255,0,0]);
 const alpha=colorcorrectVideoFrame(yuv('yuva420p',2,2,[1,2,3,4],[128],[128]),typical,{maxFrameBytes:10});expect([...alpha.planes[3]!]).toEqual([254,253,252,251]);expect(alpha.planes.length).toBe(4);
 // saturation=0 maps every chroma sample to 127.
 expect([...colorcorrectVideoFrame(yuv('yuv422p',4,1,[0,9,99,255],[0,255],[17,200]),parseColorcorrectOptions('rl=1:bh=-1:saturation=0'),{maxFrameBytes:8}).planes.slice(1).flatMap(plane=>[...plane])]).toEqual([127,127,127,127]);
});
it('analyzes medians over the whole chroma plane and minmax over one-row chroma planes',()=>{
 // A constant chroma plane is its own median and extreme: every sample moves to 127 whatever the luma.
 for(const analyze of ['median','minmax'])expect([...colorcorrectVideoFrame(yuv('yuv444p',3,1,[0,100,255],[90,90,90],[30,30,30]),parseColorcorrectOptions(`analyze=${analyze}:rl=1:bl=1`),{maxFrameBytes:9}).planes.slice(1).flatMap(plane=>[...plane])],analyze).toEqual([127,127,127,127,127,127]);
 // half_size = w * h / 2 (integer): the first value whose running count reaches it; 0 for a one-sample plane.
 const median=(u:readonly number[])=>{const out=colorcorrectVideoFrame(yuv('yuv444p',u.length,1,u.map(()=>0),u,u),parseColorcorrectOptions('analyze=median'),{maxFrameBytes:3*u.length}).planes[1]!;return [...out];};
 expect(median([40,10,200,90])).toEqual([127,97,255,177]);expect(median([40,10,200])).toEqual([157,127,255]);expect(median([77])).toEqual([204]);
 // minmax: bl from the minimum, bh from the maximum; at luma 0 only bl applies.
 expect([...colorcorrectVideoFrame(yuv('yuv444p',3,1,[0,0,0],[20,60,220],[20,60,220]),parseColorcorrectOptions('analyze=minmax'),{maxFrameBytes:9}).planes[1]!]).toEqual([127,167,255]);
 // The analysis replaces the manual spots; a one-sample plane has half_size 0, so its median is 0.
 const step=parseColorcorrectOptions('analyze=median:rl=1:bl=-1:rh=1:bh=-1');expect(step.rl).toBe(1);
 expect([...colorcorrectVideoFrame(yuv('yuv444p',1,1,[255],[3],[250]),step,{maxFrameBytes:3}).planes.slice(1).flatMap(plane=>[...plane])]).toEqual([130,255]);
 // Native averages per-slice extremes over FFMIN(chroma rows, threads) slices: two chroma rows are refused here.
 const minmax=parseColorcorrectOptions('analyze=minmax');
 expect(colorcorrectVideoFrame(yuv('yuv420p',4,2,[0,0,0,0,0,0,0,0],[5,6],[7,8]),minmax,{maxFrameBytes:12}).planes[1]!.length).toBe(2);
 for(const [format,width,height]of [['yuv420p',4,3],['yuv444p',2,2],['yuv422p',2,2],['yuva420p',2,4]] as const){
  const cw=format==='yuv444p'?width:(width+1)>>1,ch=format==='yuv444p'||format==='yuv422p'?height:(height+1)>>1;
  expect(()=>colorcorrectVideoFrame(yuv(format,width,height,Array(width*height).fill(0),Array(cw*ch).fill(0),Array(cw*ch).fill(0)),minmax,{maxFrameBytes:64}),format).toThrow('one-row chroma planes');
 }
});
it('rejects unsupported layouts, budgets, malformed storage, settings and cancellation explicitly',()=>{
 const step=parseColorcorrectOptions(null),good=()=>yuv('yuv420p',2,2,[0,0,0,0],[0],[0]);
 for(const pixelFormat of ['yuv440p','yuva444p','yuvj420p','gray','rgb24','gbrp','nv12'])expect(()=>colorcorrectVideoFrame({...good(),pixelFormat},step,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>colorcorrectVideoFrame(good(),step,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>colorcorrectVideoFrame(good(),step,{maxFrameBytes:0})).toThrow('allocation limit');expect(()=>colorcorrectVideoFrame(yuv('yuv420p',2,2,[0,0,0,0],[0],[0],3),step,{maxFrameBytes:6})).toThrow('storage exceeds');
 expect(()=>colorcorrectVideoFrame({...good(),linesizes:[1,1,1]},step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>colorcorrectVideoFrame({...good(),linesizes:[2.5,1,1]},step,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>colorcorrectVideoFrame({...good(),planes:[new Uint8Array(3),new Uint8Array(1),new Uint8Array(1)]},step,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>colorcorrectVideoFrame({...good(),planes:good().planes.slice(0,2)},step,{maxFrameBytes:64})).toThrow('plane count');expect(()=>colorcorrectVideoFrame({...good(),pts:{value:0n,timeBase:{num:1n,den:0n}}},step,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{rl:1.5},{bl:Number.NaN},{bh:0.1},{saturation:4},{analyze:'average'},{analyze:'bogus'}])expect(()=>colorcorrectVideoFrame(good(),{...step,...bad} as never,{maxFrameBytes:64}),JSON.stringify(bad)).toThrow('Invalid colorcorrect settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>colorcorrectVideoFrame(good(),step,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans colorcorrect on every path, refuses picks without storage and multi-row minmax before frames, and refuses runtime commands',async()=>{
 const plan=compileVideoFilterChain('colorcorrect=saturation=0,hflip').plan('yuv420p',4,2);expect(plan.stages.map(stage=>stage.operation)).toEqual(['colorcorrect','hflip']);expect(plan.stateBytes).toBe(0);
 const frame=yuv('yuv420p',4,2,[1,2,3,4,5,6,7,8],[0,255],[9,99]),output=plan.apply(frame,{maxFrameBytes:12,maxStateBytes:0});expect([...output.planes[0]!]).toEqual([4,3,2,1,8,7,6,5]);expect([...output.planes[1]!,...output.planes[2]!]).toEqual([127,127,127,127]);
 expect(()=>plan.apply(frame,{maxFrameBytes:11,maxStateBytes:0})).toThrow();
 // Native picks yuvj444p from gray and yuva444p from packed RGBA (tests/differential/video-colorcorrect.test.ts).
 expect(()=>compileVideoFilterChain('colorcorrect').plan('gray',4,2)).toThrow('Video filter colorcorrect input negotiates yuvj444p, which is not implemented');
 for(const source of ['rgba','argb'])expect(()=>compileVideoFilterChain('colorcorrect').plan(source,4,2),source).toThrow('negotiates yuva444p, which is not implemented');
 expect(compileVideoFilterChain('colorcorrect').plan('rgb24',4,2).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv444p'],['colorcorrect','yuv444p']]);
 // minmax over more than one chroma row is refused in geometry on every planner; one chroma row plans.
 expect(()=>compileVideoFilterChain('colorcorrect=analyze=minmax').plan('yuv420p',4,4)).toThrow('one-row chroma planes');expect(compileVideoFilterChain('colorcorrect=analyze=minmax').plan('yuv420p',4,2).stages.length).toBe(1);
 expect(()=>compileVideoFilterGraph('[0:v]colorcorrect=analyze=minmax[o]').plan({format:'yuv444p',width:3,height:2},[null])).toThrow('one-row chroma planes');
 const source={geometry:{format:'yuv422p',width:4,height:3},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}};expect(()=>planTimedVideoGraph('colorcorrect=analyze=minmax',[source],[null])).toThrow('one-row chroma planes');
 expect(()=>compileVideoFilterGraph('[0:v]colorcorrect=rl=3[o]')).toThrow('Invalid colorcorrect rl');expect(()=>createFrameActors('colorcorrect=analyze=average',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('analyze=average');
 expect(()=>compileVideoFilterChain('colorcorrect=enable=1')).toThrow('timeline');expect(()=>createFrameActors('colorcorrect=enable=gte(t\\,1)',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
 const actors=createFrameActors('colorcorrect=saturation=0',{maxSteps:64,maxQueuedFrames:2,maxQueuedBytes:1<<12,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry:{format:'yuv420p',width:4,height:2}}]});
 try{for(const [command,argument]of [['rl','0.5'],['saturation','2'],['analyze','median'],['enable','0']] as const)expect(actors.sendFilterCommand('colorcorrect',command,argument).code,command).toBe(command==='enable'?-1163346256:-38);
  actors.sendFrameInput(0,{kind:'frame',duration:1n,frame});actors.endInput(0,-541478725,1n);const result=await actors.readFrame(0);expect(result.code).toBe(0);expect([...result.event!.frame.planes[1]!]).toEqual([127,127]);}finally{actors.dispose();}
});
