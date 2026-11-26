import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {colorkeyPixelFormats,colorkeyVideoFrame,parseColorkeyOptions} from '../../packages/avfilter/src/video-colorkey.js';
import type {VideoColorkeySettings} from '../../packages/avfilter/src/video-colorkey.js';
import {colorkeyOperator} from '../../packages/avfilter/src/video-ops/colorkey.js';
import {colorholdOperator} from '../../packages/avfilter/src/video-ops/colorhold.js';
const packed=(pixelFormat:string,data:Uint8Array,width:number,height:number,stride=width*4):VideoFrameData=>({width,height,pixelFormat,planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
it('parses defaults, shorthand, colours, float ranges and refuses enable=, unknown options and unsupported colours',()=>{
 for(const name of ['colorkey','colorhold'] as const){
  const defaults=parseColorkeyOptions(name,null);expect(defaults).toEqual({name,color:[0,0,0,255],similarity:Math.fround(0.01),blend:0});expect(Object.isFrozen(defaults)).toBe(true);
  expect(parseColorkeyOptions(name,'green:0.3:0.5')).toEqual({name,color:[0,128,0,255],similarity:Math.fround(0.3),blend:0.5});
  expect(parseColorkeyOptions(name,'blend=1:color=0x336699@0.5:similarity=1')).toEqual({name,color:[0x33,0x66,0x99,127],similarity:1,blend:1});
  expect(parseColorkeyOptions(name,'similarity=0.1:similarity=0.2').similarity).toBe(Math.fround(0.2));expect(parseColorkeyOptions(name,'similarity=0.00001').similarity).toBe(Math.fround(0.00001));expect(parseColorkeyOptions(name,'#FF0000').color).toEqual([255,0,0,255]);
  for(const [options,message]of [['similarity=0','out of range [1e-05 - 1]'],['similarity=2',"Value 2.000000 for parameter 'similarity' out of range [1e-05 - 1]"],['blend=-1',"Value -1.000000 for parameter 'blend' out of range [0 - 1]"],['blend=1.5','out of range [0 - 1]'],
   ['similarity=1+1','Only decimal'],['blend=1k','Only decimal'],['blend=default','Only decimal'],['similarity=','Only decimal'],['nocolor',"Cannot find color 'nocolor'"],['color=random','Unsupported'],['enable=1','timeline'],['threads=1','Unsupported'],['foo=1','Unsupported'],['black:0.1:0.1:4','']] as const)
   expect(()=>parseColorkeyOptions(name,options),`${name}/${options}`).toThrow(message);
 }
 expect(colorkeyPixelFormats).toEqual(['argb','rgba','abgr','bgra','rgba64le','bgra64le']);expect(Object.isFrozen(colorkeyPixelFormats)).toBe(true);
 for(const op of [colorkeyOperator,colorholdOperator]){expect(videoOperator(op.name)).toBe(op);expect(op.formats!(parseColorkeyOptions(op.name,null) as never)).toBe(colorkeyPixelFormats);expect(op.paths).toEqual(['linear','graph','stream','actor','timed']);expect(op.timeline).toBeUndefined();expect(op.geometryCommands).toBeUndefined();}
});
it('keys alpha and holds colour per packed order with native rounding into owned tight planes without mutating padded input',()=>{
 const rgba=Uint8Array.of(0,0,0,9,1,1,1,9,200,100,50,9,0xee,0xee,0xee,0xee,10,20,30,9,255,255,255,9,9,9,9,9,7,7,7,7);
 const key=colorkeyVideoFrame(packed('rgba',rgba,3,2,16),parseColorkeyOptions('colorkey',null),{maxFrameBytes:32});
 expect([...key.planes[0]!]).toEqual([0,0,0,0,1,1,1,0,200,100,50,255,10,20,30,255,255,255,255,255,9,9,9,255]);expect(key.linesizes).toEqual([12]);expect(key.pts).toEqual({value:9007199254740993n,timeBase:{num:1n,den:25n}});expect(key.metadata).toEqual({colorRange:2});
 expect(rgba[3]).toBe(9);expect(key.planes[0]!.buffer).not.toBe(rgba.buffer);
 // Soft blend: trunc(clip((diff - similarity) * iblend) * 255); diff of (10,20,30) from black is sqrt(1400/195075).
 const soft=colorkeyVideoFrame(packed('rgba',rgba.slice(16,20),1,1),parseColorkeyOptions('colorkey','black:0.01:0.5'),{maxFrameBytes:4});
 expect(soft.planes[0]![3]).toBe(Math.trunc((Math.sqrt(1400/195075)-Math.fround(0.01))*2*255));
 // Byte offsets follow ff_fill_rgba_map for every order: only the alpha byte changes.
 for(const [format,pixel,alpha]of [['argb',[9,0,0,0],0],['abgr',[9,0,0,0],0],['bgra',[0,0,0,9],3],['rgba',[0,0,0,9],3]] as const){const out=colorkeyVideoFrame(packed(format,Uint8Array.from(pixel),1,1),parseColorkeyOptions('colorkey',null),{maxFrameBytes:4});expect([...out.planes[0]!],format).toEqual(pixel.map((value,index)=>index===alpha?0:value));}
 // colorhold keeps alpha and pulls the kept pixels toward their average: (a*t + c*(255-t) + 127) >> 8.
 const hold=colorkeyVideoFrame(packed('bgra',Uint8Array.of(50,100,200,7,0,0,0,7),2,1),parseColorkeyOptions('colorhold',null),{maxFrameBytes:8});
 const a=Math.trunc(350/3),t=255;expect([...hold.planes[0]!]).toEqual([(a*t+50*0+127)>>8,(a*t+100*0+127)>>8,(a*t+200*0+127)>>8,7,0,0,0,7]);
 const half=colorkeyVideoFrame(packed('argb',Uint8Array.of(1,200,100,50),1,1),parseColorkeyOptions('colorhold','black:0.3:1'),{maxFrameBytes:4}),tt=Math.trunc((Math.sqrt(52500/195075)-Math.fround(0.3))*255);
 expect(tt).toBeGreaterThan(0);expect([...half.planes[0]!]).toEqual([1,...[200,100,50].map(c=>(116*tt+c*(255-tt)+127)>>8)]);
});
it('rejects unsupported layouts, budgets, malformed storage, settings and cancellation explicitly',()=>{
 const step=parseColorkeyOptions('colorkey',null),frame=packed('rgba',new Uint8Array(24),3,2);
 for(const pixelFormat of ['rgb24','gray','yuv420p','rgba64le','gbrp','constructor'])expect(()=>colorkeyVideoFrame({...frame,pixelFormat},step,{maxFrameBytes:64}),pixelFormat).toThrow('pixel format is not supported');
 expect(()=>colorkeyVideoFrame(frame,step,{maxFrameBytes:23})).toThrow('allocation limit');expect(()=>colorkeyVideoFrame(frame,step,{maxFrameBytes:0})).toThrow('allocation limit');expect(()=>colorkeyVideoFrame(packed('rgba',new Uint8Array(32),3,2,16),step,{maxFrameBytes:24})).toThrow('storage exceeds');
 expect(()=>colorkeyVideoFrame(packed('rgba',new Uint8Array(23),3,2),step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>colorkeyVideoFrame(packed('rgba',new Uint8Array(24),3,2,8),step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>colorkeyVideoFrame(packed('rgba',new Uint8Array(24),3,2,12.5),step,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>colorkeyVideoFrame({...frame,planes:[]},step,{maxFrameBytes:64})).toThrow('plane count');expect(()=>colorkeyVideoFrame({...frame,planes:[new Uint8Array(24),new Uint8Array(1)],linesizes:[12,1]},step,{maxFrameBytes:64})).toThrow('plane count');
 expect(()=>colorkeyVideoFrame({...frame,pts:{value:0n,timeBase:{num:0n,den:1n}}},step,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{similarity:0},{similarity:0.1},{similarity:2},{blend:-1},{blend:0.1},{color:[0,0,256,0]},{color:[0,0,0]},{name:'colorkeys'}])expect(()=>colorkeyVideoFrame(frame,{...step,...bad} as VideoColorkeySettings,{maxFrameBytes:64}),JSON.stringify(bad)).toThrow('Invalid colorkey settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>colorkeyVideoFrame(frame,step,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans colorkey and colorhold on linear, graph and actor paths, refuses parse errors before frames and refuses runtime commands',async()=>{
 const plan=compileVideoFilterChain('colorkey=white:0.5,hflip,colorhold').plan('rgba',2,1);expect(plan.stages.map(stage=>stage.operation)).toEqual(['colorkey','hflip','colorhold']);expect(plan.stateBytes).toBe(0);
 const frame=packed('rgba',Uint8Array.of(255,255,255,255,0,0,0,255),2,1),output=plan.apply(frame,{maxFrameBytes:8,maxStateBytes:0});// White is held at (255*255 + 127) >> 8 = 254, as COLORHOLD_SLICE(8) rounds.
 expect([...output.planes[0]!]).toEqual([0,0,0,255,254,254,254,0]);expect(()=>plan.apply(frame,{maxFrameBytes:7,maxStateBytes:0})).toThrow();
 // Native picks argb from every non-packed source (tests/differential/video-colorkey.test.ts).
 for(const source of ['yuv420p','gray','rgb24','gbrp'])expect(compileVideoFilterChain('colorkey').plan(source,5,3).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat]),source).toEqual([['scale','argb'],['colorkey','argb']]);
 for(const source of ['rgba','bgra','abgr'])expect(compileVideoFilterChain('colorhold').plan(source,5,3).stages.map(stage=>stage.pixelFormat),source).toEqual([source]);
 for(const vf of ['colorkey=nocolor','colorhold=similarity=0','colorkey=enable=1'])expect(()=>compileVideoFilterChain(vf),vf).toThrow();
 expect(()=>compileVideoFilterGraph('[0:v]colorkey=blend=2[o]')).toThrow('out of range');expect(()=>createFrameActors('colorhold=bogus',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow("Cannot find color 'bogus'");expect(()=>createFrameActors('colorkey=enable=gte(t\\,1)',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
 const actors=createFrameActors('colorkey',{maxSteps:64,maxQueuedFrames:2,maxQueuedBytes:1<<12,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry:{format:'rgba',width:2,height:1}}]});
 try{for(const [command,argument]of [['color','white'],['similarity','0.5'],['blend','0.1'],['enable','0']] as const)expect(actors.sendFilterCommand('colorkey',command,argument).code,command).toBe(command==='enable'?-1163346256:-38);
  actors.sendFrameInput(0,{kind:'frame',duration:1n,frame});actors.endInput(0,-541478725,1n);const result=await actors.readFrame(0);expect(result.code).toBe(0);expect([...result.event!.frame.planes[0]!]).toEqual([255,255,255,255,0,0,0,0]);}finally{actors.dispose();}
});
