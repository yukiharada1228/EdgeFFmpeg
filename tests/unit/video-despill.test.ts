import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {despillOperator,despillPixelFormats,despillVideoFrame,parseDespillOptions} from '../../packages/avfilter/src/video-ops/despill.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
const packed=(pixelFormat:string,data:Uint8Array,width:number,height:number,stride=width*4):VideoFrameData=>({width,height,pixelFormat,planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
/** Four rgba pixels whose native outputs were read from the reference build (see docs/contributing/despill.md). */
const pixels=Uint8Array.of(40,200,60,255,0,255,0,128,10,20,250,7,255,255,255,0);
const defaults={name:'despill',type:0,mix:0.5,expand:0,red:0,green:-1,blue:0,brightness:0,alpha:false};
it('parses AVOption defaults, shorthand order, type constants, float storage, booleans and ranges',()=>{
 expect(parseDespillOptions(null)).toEqual(defaults);expect(Object.isFrozen(parseDespillOptions(''))).toBe(true);
 expect(parseDespillOptions('blue:0.25:0.5:1:2:3:4:1')).toEqual({name:'despill',type:1,mix:0.25,expand:0.5,red:1,green:2,blue:3,brightness:4,alpha:true});
 // green is both a type constant and the green scale option: positional and type= take the constant, green= the float.
 expect(parseDespillOptions('green').type).toBe(0);expect(parseDespillOptions('type=blue:green=2')).toMatchObject({type:1,green:2});expect(parseDespillOptions('type=1').type).toBe(1);expect(parseDespillOptions('type=max').type).toBe(1);expect(parseDespillOptions('type=0.4').type).toBe(0);
 expect(parseDespillOptions('mix=0.3').mix).toBe(Math.fround(0.3));expect(parseDespillOptions('mix=0.3').mix).not.toBe(0.3);expect(parseDespillOptions('expand=1e0:red=-1E2:brightness=+.5').brightness).toBe(0.5);expect(parseDespillOptions('red=-100:green=100:blue=-100:brightness=10')).toMatchObject({red:-100,green:100,blue:-100,brightness:10});
 expect(parseDespillOptions('mix=1:mix=0').mix).toBe(0);expect(parseDespillOptions('blue:alpha=1:type=green').type).toBe(0);
 for(const [text,value]of [['1',true],['0',false],['TRUE',true],['yes',true],['on',true],['enabled',true],['Off',false],['n',false],['disable',false],['+1',true]] as const)expect(parseDespillOptions(`alpha=${text}`).alpha,text).toBe(value);
 for(const [options,message]of [['mix=1.5','outside'],['mix=-0.01','outside'],['expand=1.0001','outside'],['red=100.5','outside'],['blue=-101','outside'],['brightness=10.5','outside'],['mix=nan','Only decimal despill mix'],['mix=0.25+0.25','Only decimal despill mix'],['red=0.01k','Only decimal despill red'],['green=green','Only decimal despill green'],['brightness=','Only decimal despill brightness'],['type=2','Invalid despill type'],['type=-1','Invalid despill type'],['type=red','Invalid despill type'],['alpha=auto','alpha'],['alpha=2','alpha'],['alpha=-1','alpha'],['alpha=1.0','alpha'],['enable=1','timeline'],['enable=between(t\\,0\\,1)','timeline'],['threads=1','Unsupported despill option'],['foo=1','Unsupported despill option'],['1:0.5:0:0:-1:0:0:1:3',''],['mix=0:1','']] as const)expect(()=>parseDespillOptions(options),options).toThrow(message);
 expect(()=>parseDespillOptions('mix=2')).toThrow(VideoFilterParseError);
 // The pinned vf_despill.c pixel_fmts in declared order.
 expect(despillPixelFormats).toEqual(['argb','rgba','abgr','bgra']);expect(Object.isFrozen(despillPixelFormats)).toBe(true);expect(despillOperator.formats!(parseDespillOptions(null))).toBe(despillPixelFormats);
 expect(videoOperator('despill')).toBe(despillOperator);expect(despillOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(despillOperator.timeline).toBeUndefined();expect(despillOperator.geometryCommands).toBeUndefined();
});
it('despills rgba pixels to native values into an owned tight plane without mutating padded input',()=>{
 const input=new Uint8Array(24);input.set(pixels.subarray(0,8),0);input.set(pixels.subarray(8),12);input.fill(77,8,12);input.fill(77,20,24);const frame=packed('rgba',input,2,2,12),before=[...input];
 const output=despillVideoFrame(frame,parseDespillOptions(null),{maxFrameBytes:24});
 expect([...output.planes[0]!]).toEqual([40,49,60,255,0,0,0,128,10,20,250,7,255,255,255,0]);expect(output.linesizes).toEqual([8]);expect(output.planes[0]!.buffer).not.toBe(input.buffer);expect([...input]).toEqual(before);
 expect(output.pts).toEqual(frame.pts);expect(output.pts).not.toBe(frame.pts);expect(output.metadata).toEqual({colorRange:2});expect([output.width,output.height,output.pixelFormat]).toEqual([2,2,'rgba']);
 const tight=packed('rgba',pixels,2,2),run=(options:string)=>[...despillVideoFrame(tight,parseDespillOptions(options),{maxFrameBytes:16}).planes[0]!];
 expect(run('alpha=1')).toEqual([40,49,60,104,0,0,0,0,10,20,250,255,255,255,255,255]);expect(run('blue:alpha=1')).toEqual([40,200,60,255,0,255,0,255,10,0,250,19,255,255,255,255]);
 expect(run('mix=0.3:expand=0.2:red=100:brightness=-10')).toEqual([255,0,0,255,255,0,0,128,10,20,250,7,255,0,0,0]);
});
it('maps R, G, B and A through every packed component order',()=>{
 const order:Record<string,readonly number[]>={argb:[1,2,3,0],rgba:[0,1,2,3],abgr:[3,2,1,0],bgra:[2,1,0,3]},expected=[40,200,60,255,0,255,0,255,10,0,250,19,255,255,255,255];
 for(const format of despillPixelFormats){
  const permute=(rgba:ArrayLike<number>)=>{const data=new Uint8Array(16);for(let p=0;p<4;p++)for(let c=0;c<4;c++)data[p*4+order[format]![c]!]=rgba[p*4+c]!;return [...data];};
  expect([...despillVideoFrame(packed(format,Uint8Array.from(permute(pixels)),2,2),parseDespillOptions('blue:alpha=1'),{maxFrameBytes:16}).planes[0]!],format).toEqual(permute(expected));
 }
});
it('rejects unsupported layouts, budgets, malformed storage, settings and cancellation explicitly',()=>{
 const step=parseDespillOptions(null),frame=()=>packed('rgba',new Uint8Array(24),3,2);
 for(const pixelFormat of ['rgb24','gray','yuv420p','gbrp','yuva420p','bgr24'])expect(()=>despillVideoFrame({width:2,height:2,pixelFormat,planes:[new Uint8Array(64)],linesizes:[8],pts:null,metadata:{}},step,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>despillVideoFrame(frame(),step,{maxFrameBytes:23})).toThrow('allocation limit');expect(()=>despillVideoFrame(frame(),step,{maxFrameBytes:0})).toThrow('allocation limit');expect(()=>despillVideoFrame(frame(),step,{maxFrameBytes:1.5})).toThrow('allocation limit');
 expect(()=>despillVideoFrame(packed('rgba',new Uint8Array(32),3,2,16),step,{maxFrameBytes:31})).toThrow('storage exceeds');
 expect(()=>despillVideoFrame(packed('rgba',new Uint8Array(23),3,2),step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>despillVideoFrame(packed('rgba',new Uint8Array(24),3,2,8),step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>despillVideoFrame(packed('rgba',new Uint8Array(24),3,2,12.5),step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>despillVideoFrame(packed('rgba',new Uint8Array(24),3,2,-12),step,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>despillVideoFrame({...frame(),planes:[new Uint8Array(24),new Uint8Array(24)],linesizes:[12,12]},step,{maxFrameBytes:64})).toThrow('plane count');expect(()=>despillVideoFrame({...frame(),planes:[]},step,{maxFrameBytes:64})).toThrow('plane count');
 expect(()=>despillVideoFrame({...frame(),pts:{value:0n,timeBase:{num:1n,den:0n}}},step,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{type:2},{mix:1.5},{mix:0.3},{red:-101},{brightness:Number.NaN},{alpha:1}])expect(()=>despillVideoFrame(frame(),{...step,...bad} as never,{maxFrameBytes:64}),JSON.stringify(bad)).toThrow('Invalid despill settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>despillVideoFrame(frame(),step,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans despill on linear, graph and actor paths after negotiation and refuses enable= and runtime commands',async()=>{
 const plan=compileVideoFilterChain('despill,hflip,despill=blue').plan('rgba',2,2);expect(plan.stages.map(stage=>stage.operation)).toEqual(['despill','hflip','despill']);expect(plan.stateBytes).toBe(0);
 const output=plan.apply(packed('rgba',pixels,2,2),{maxFrameBytes:16,maxStateBytes:0}),once=despillVideoFrame(packed('rgba',pixels,2,2),parseDespillOptions(null),{maxFrameBytes:16}).planes[0]!,flipped=Uint8Array.from([4,0,12,8].flatMap(p=>[...once.subarray(p,p+4)]));
 expect([...output.planes[0]!]).toEqual([...despillVideoFrame(packed('rgba',flipped,2,2),parseDespillOptions('blue'),{maxFrameBytes:16}).planes[0]!]);expect([...output.planes[0]!.subarray(4,8)]).toEqual([40,33,60,255]);expect(()=>plan.apply(packed('rgba',pixels,2,2),{maxFrameBytes:15,maxStateBytes:0})).toThrow();
 // Native picks argb, the first declared format, from sources without packed alpha.
 expect(compileVideoFilterChain('despill').plan('yuv420p',4,2).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','argb'],['despill','argb']]);
 expect(()=>compileVideoFilterChain('despill=enable=1')).toThrow('timeline');expect(()=>compileVideoFilterGraph('[0:v]despill=mix=3[o]')).toThrow('outside');expect(()=>createFrameActors('despill=enable=gte(t\\,1)',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
 const actors=createFrameActors('despill=alpha=1',{maxSteps:64,maxQueuedFrames:2,maxQueuedBytes:1<<12,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry:{format:'rgba',width:2,height:2}}]});
 try{for(const [command,argument]of [['mix','0'],['type','blue'],['alpha','0'],['enable','0']] as const)expect(actors.sendFilterCommand('despill',command,argument).code,command).toBe(command==='enable'?-1163346256:-38);
  actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:packed('rgba',pixels,2,2)});actors.endInput(0,-541478725,1n);const result=await actors.readFrame(0);expect(result.code).toBe(0);expect([...result.event!.frame.planes[0]!]).toEqual([40,49,60,104,0,0,0,0,10,20,250,255,255,255,255,255]);}finally{actors.dispose();}
});
