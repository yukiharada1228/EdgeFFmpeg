import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {floodfillOperator,floodfillPixelFormats,floodfillVideoFrame,parseFloodfillOptions} from '../../packages/avfilter/src/video-ops/floodfill.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const fill=(frame:VideoFrameData,options:string,maxFrameBytes=1<<16)=>floodfillVideoFrame(frame,parseFloodfillOptions(options),{maxFrameBytes});
it('parses declared defaults, shorthand order, integer expressions, constants and native ranges',()=>{
 expect(parseFloodfillOptions(null)).toEqual({name:'floodfill',x:0,y:0,source:[0,0,0,0],destination:[0,0,0,0]});const step=parseFloodfillOptions('');expect(Object.isFrozen(step)&&Object.isFrozen(step.source)&&Object.isFrozen(step.destination)).toBe(true);
 expect(parseFloodfillOptions('1:2:3:4:5:6:7:8:9:10')).toEqual({name:'floodfill',x:1,y:2,source:[3,4,5,6],destination:[7,8,9,10]});
 expect(parseFloodfillOptions('3:d2=9:x=1:x=4')).toEqual({name:'floodfill',x:4,y:0,source:[0,0,0,0],destination:[0,0,9,0]});
 expect(parseFloodfillOptions('x=2*3:y=0x10:s0=min:s1=max:d0=max:d1=default:d3=2.5').source).toEqual([-1,65535,0,0]);expect(parseFloodfillOptions('x=2*3:y=0x10').x).toBe(6);expect(parseFloodfillOptions('y=0x10').y).toBe(16);
 expect(parseFloodfillOptions('d0=max:d3=2.5:d2=3.5').destination).toEqual([65535,0,4,2]);expect(parseFloodfillOptions('x=65535:y=65535:s3=-1').x).toBe(65535);
 for(const [options,message]of [['x=-1','Invalid floodfill x'],['x=65536','Invalid floodfill x'],['y=-1','Invalid floodfill y'],['s0=-2','Invalid floodfill s0'],['s3=65536','Invalid floodfill s3'],['d0=-1','Invalid floodfill d0'],['d3=65536','Invalid floodfill d3'],['x=abc','Invalid floodfill x'],['x=','Invalid floodfill x'],['enable=1','timeline'],['enable=between(t,0,1)','timeline'],['threads=1','Unsupported floodfill option'],['foo=1','Unsupported floodfill option'],['s=1','Unsupported floodfill option'],['1:2:3:4:5:6:7:8:9:10:11',''],['x=1:2','']] as const)expect(()=>parseFloodfillOptions(options),options).toThrow(message);
 expect(()=>parseFloodfillOptions('x=-1')).toThrow(VideoFilterParseError);
 // The pinned vf_floodfill.c pixel_fmts in declared order.
 expect(floodfillPixelFormats).toEqual('gray gray9le gray10le gray14le gray16le yuv444p yuva444p gbrp gbrp9le gbrp10le gbrap10le gbrp12le gbrap12le gbrp14le gbrp16le gbrap16le gbrap yuv444p9le yuva444p9le yuv444p10le yuva444p10le yuv444p12le yuv444p14le yuv444p16le yuva444p16le'.split(' '));expect(floodfillOperator.formats!(parseFloodfillOptions(null))).toBe(floodfillPixelFormats);expect(Object.isFrozen(floodfillPixelFormats)).toBe(true);
 expect(videoOperator('floodfill')).toBe(floodfillOperator);expect(floodfillOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(floodfillOperator.timeline).toBeUndefined();expect(floodfillOperator.geometryCommands).toBeUndefined();
});
it('fills the 4-connected seed region into owned tight planes without mutating padded input',()=>{
 // 4x3 with a hole (the 9) and a diagonal-only neighbour (bottom-right 0 touches the region only by its corner).
 const input=Uint8Array.of(0,0,5,77,0,9,5,77,5,5,0,77),frame=gray(input,3,3,4),actual=fill(frame,'s0=0:d0=200');
 expect([...actual.planes[0]!]).toEqual([200,200,5,200,9,5,5,5,0]);expect(actual.linesizes).toEqual([3]);expect(actual.pts).toEqual(frame.pts);expect(actual.pts).not.toBe(frame.pts);expect(actual.metadata).toEqual({colorRange:2});expect([...input]).toEqual([0,0,5,77,0,9,5,77,5,5,0,77]);
 expect([...fill(frame,'x=2:y=0:s0=-1:d0=1').planes[0]!]).toEqual([0,0,1,0,9,1,5,5,0]);expect([...fill(frame,'x=1:y=1:s0=-1:d0=3').planes[0]!]).toEqual([0,0,5,0,3,5,5,5,0]);
 // Non-matching seed, seed outside the frame, S == d and s0 > 255 all pass the frame through.
 for(const options of ['s0=5:d0=1','x=3:s0=-1:d0=1','y=3:s0=-1:d0=1','x=65535:y=65535','s0=0:d0=0','x=2:s0=-1:d0=5','s0=256:d0=1'])expect([...fill(frame,options).planes[0]!],options).toEqual([0,0,5,0,9,5,5,5,0]);
 // Eight-bit set_pixel stores d modulo 256; other planes' sources are ignored on gray.
 expect([...fill(frame,'s0=0:d0=257:s1=40:s2=-1:s3=9').planes[0]!]).toEqual([1,1,5,1,9,5,5,5,0]);
 const yuv:VideoFrameData={width:2,height:2,pixelFormat:'yuv444p',planes:[Uint8Array.of(1,1,1,1),Uint8Array.of(2,2,3,2),Uint8Array.of(4,4,4,4)],linesizes:[2,2,2],pts:null,metadata:{}};
 expect(fill(yuv,'s0=1:s1=2:s2=4:s3=99:d0=7:d1=8:d2=9').planes.map(plane=>[...plane])).toEqual([[7,7,1,7],[8,8,3,8],[9,9,4,9]]);
 expect(fill(yuv,'x=0:y=1:s0=-1:s1=-1:s2=-1:d0=7:d1=8:d2=9').planes.map(plane=>[...plane])).toEqual([[1,1,7,1],[2,2,8,2],[4,4,9,4]]);
 // gbrp planes follow plane index (G, B, R); S == d on the three planes passes through.
 const gbrp:VideoFrameData={width:2,height:1,pixelFormat:'gbrp',planes:[Uint8Array.of(5,5),Uint8Array.of(6,6),Uint8Array.of(7,7)],linesizes:[2,2,2],pts:null,metadata:{}};
 expect(fill(gbrp,'s0=-1:s1=-1:s2=-1:d0=5:d1=6:d2=7:d3=100').planes.map(plane=>[...plane])).toEqual([[5,5],[6,6],[7,7]]);expect(fill(gbrp,'s0=-1:s1=-1:s2=-1:d0=5:d1=6:d2=8').planes.map(plane=>[...plane])).toEqual([[5,5],[6,6],[8,8]]);
});
it('refuses the never-terminating truncated destination, unsupported layouts, budgets, malformed storage, settings and cancellation',()=>{
 const zeros=gray(new Uint8Array(6),3,2);
 for(const options of ['d0=256','s0=-1:d0=512','s0=0:d0=256:d1=7'])expect(()=>fill(zeros,options),options).toThrow('native never terminates');
 expect([...fill(gray(Uint8Array.of(1,0,0,0,0,0),3,2),'d0=256').planes[0]!]).toEqual([1,0,0,0,0,0]);
 // A lone matching seed is rewritten with its own values and native terminates (gray 1x1 and an isolated pixel).
 expect([...fill(gray(Uint8Array.of(0),1,1),'d0=256').planes[0]!]).toEqual([0]);expect([...fill(gray(Uint8Array.of(0,1,0,1,1,1),3,2),'d0=256').planes[0]!]).toEqual([0,1,0,1,1,1]);expect(()=>fill(gray(Uint8Array.of(0,1,0,0,1,1),3,2),'d0=256')).toThrow('native never terminates');
 const step=parseFloodfillOptions('s0=-1:d0=1');
 for(const pixelFormat of ['yuv420p','yuv422p','yuva420p','nv12','rgb24','rgba','pal8'])expect(()=>floodfillVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},step,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>floodfillVideoFrame(gray(new Uint8Array(6),3,2),step,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>floodfillVideoFrame(gray(new Uint8Array(8),3,2,4),step,{maxFrameBytes:7})).toThrow('storage exceeds');expect(()=>floodfillVideoFrame(gray(new Uint8Array(6),3,2),step,{maxFrameBytes:0})).toThrow('allocation limit');
 // The point stack holds four-byte indices bounded by maxFrameBytes: a 6-byte budget holds one point.
 expect(()=>floodfillVideoFrame(gray(new Uint8Array(6),3,2),step,{maxFrameBytes:6})).toThrow('point stack exceeds allocation limit');expect([...floodfillVideoFrame(gray(new Uint8Array(6),3,2),step,{maxFrameBytes:12}).planes[0]!]).toEqual([1,1,1,1,1,1]);
 expect(()=>floodfillVideoFrame(gray(new Uint8Array(5),3,2),step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>floodfillVideoFrame(gray(new Uint8Array(6),3,2,2),step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>floodfillVideoFrame(gray(new Uint8Array(6),3,2,3.5),step,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>floodfillVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},step,{maxFrameBytes:64})).toThrow('plane count');expect(()=>floodfillVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},step,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{x:-1},{y:65536},{x:0.5},{source:[-2,0,0,0]},{source:[0,0,0]},{destination:[0,0,0,65536]},{destination:[-1,0,0,0]}])expect(()=>floodfillVideoFrame(gray(new Uint8Array(6),3,2),{...step,...bad} as never,{maxFrameBytes:64}),JSON.stringify(bad)).toThrow('Invalid floodfill settings');
 expect(()=>floodfillVideoFrame({width:65537,height:1,pixelFormat:'gray',planes:[new Uint8Array(65537)],linesizes:[65537],pts:null,metadata:{}},step,{maxFrameBytes:1<<20})).toThrow('wider or taller than 65536');
 expect(()=>floodfillOperator.geometry!(step,[{format:'gray',width:4,height:65537}])).toThrow('wider or taller than 65536');expect(floodfillOperator.geometry!(step,[{format:'gray',width:65536,height:1}])).toEqual({width:65536,height:1});
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>floodfillVideoFrame(gray(new Uint8Array(6),3,2),step,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans floodfill on linear, graph and actor paths, refuses out-of-range options before frames and refuses runtime commands',async()=>{
 const plan=compileVideoFilterChain('floodfill=s0=-1:d0=9,hflip,floodfill=x=4:y=2:s0=-1:d0=200').plan('gray',5,3);expect(plan.stages.map(stage=>stage.operation)).toEqual(['floodfill','hflip','floodfill']);expect(plan.stateBytes).toBe(0);
 const frame=gray(Uint8Array.of(0,0,1,0,0,0,1,1,1,0,0,0,0,0,0),5,3),output=plan.apply(frame,{maxFrameBytes:64,maxStateBytes:0});expect([...output.planes[0]!]).toEqual([200,200,1,200,200,200,1,1,1,200,200,200,200,200,200]);
 expect(compileVideoFilterChain('floodfill').plan('yuv420p',5,3).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv444p'],['floodfill','yuv444p']]);expect(compileVideoFilterChain('floodfill').plan('rgb24',5,3).stages.at(-1)!.pixelFormat).toBe('gbrp');
 // Native converts yuva and packed RGB with alpha to yuva444p and gbrap (tests/differential/video-floodfill.test.ts), which have no frame storage here.
 expect(()=>compileVideoFilterChain('floodfill').plan('yuva420p',5,3)).toThrow('Video filter floodfill input negotiates yuva444p, which is not implemented');expect(()=>compileVideoFilterChain('floodfill').plan('rgba',5,3)).toThrow('Video filter floodfill input negotiates gbrap, which is not implemented');
 expect(()=>compileVideoFilterChain('floodfill').plan('gray',65537,1)).toThrow('wider or taller than 65536');
 expect(()=>compileVideoFilterChain('floodfill=x=65536')).toThrow('Invalid floodfill x');expect(()=>compileVideoFilterGraph('[0:v]floodfill=s0=-2[o]')).toThrow('Invalid floodfill s0');expect(()=>createFrameActors('floodfill=d0=-1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('Invalid floodfill d0');
 expect(()=>compileVideoFilterChain('floodfill=enable=1')).toThrow('timeline');expect(()=>createFrameActors('floodfill=enable=gte(t\\,1)',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
 const actors=createFrameActors('floodfill=s0=-1:d0=9',{maxSteps:64,maxQueuedFrames:2,maxQueuedBytes:1<<12,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry:{format:'gray',width:5,height:3}}]});
 try{for(const [command,argument]of [['x','1'],['d0','10'],['s0','0'],['enable','0']] as const)expect(actors.sendFilterCommand('floodfill',command,argument).code,command).toBe(command==='enable'?-1163346256:-38);
  actors.sendFrameInput(0,{kind:'frame',duration:1n,frame});actors.endInput(0,-541478725,1n);const result=await actors.readFrame(0);expect(result.code).toBe(0);expect([...result.event!.frame.planes[0]!].slice(0,5)).toEqual([9,9,1,9,9]);}finally{actors.dispose();}
});
