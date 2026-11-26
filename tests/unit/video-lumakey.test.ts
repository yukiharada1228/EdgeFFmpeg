import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {lumakeyBounds,lumakeyOperator,lumakeyPixelFormats,lumakeyVideoFrame,parseLumakeyOptions} from '../../packages/avfilter/src/video-ops/lumakey.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
/** yuva420p with padded strides: luma and alpha rows of `stride`, chroma rows of `stride` too. */
const yuva=(luma:readonly number[],alpha:readonly number[],width:number,height:number,stride=width):VideoFrameData=>{
 const pad=(values:readonly number[],w:number,h:number)=>{const out=new Uint8Array(stride*(h-1)+w).fill(0xee);for(let y=0;y<h;y++)for(let x=0;x<w;x++)out[y*stride+x]=values[y*w+x]!;return out;};
 const cw=(width+1)>>1,ch=(height+1)>>1;
 return {width,height,pixelFormat:'yuva420p',planes:[pad(luma,width,height),pad(Array.from({length:cw*ch},(_,i)=>10+i),cw,ch),pad(Array.from({length:cw*ch},(_,i)=>200-i),cw,ch),pad(alpha,width,height)],linesizes:[stride,stride,stride,stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:1}};
};
it('parses declared defaults, shorthand, named options, ranges and refusals',()=>{
 expect(parseLumakeyOptions(null)).toEqual({name:'lumakey',threshold:0,tolerance:0.01,softness:0});expect(Object.isFrozen(parseLumakeyOptions(''))).toBe(true);
 expect(parseLumakeyOptions('0.5:0.2:0.1')).toEqual({name:'lumakey',threshold:0.5,tolerance:0.2,softness:0.1});
 expect(parseLumakeyOptions('softness=1:threshold=.25')).toEqual({name:'lumakey',threshold:0.25,tolerance:0.01,softness:1});
 expect(parseLumakeyOptions('threshold=0.1:threshold=0.3').threshold).toBe(0.3);expect(parseLumakeyOptions('tolerance=5e-1').tolerance).toBe(0.5);expect(parseLumakeyOptions('1.').threshold).toBe(1);
 expect(Object.is(parseLumakeyOptions('threshold=-0').threshold,0)).toBe(true);expect(parseLumakeyOptions('+1').threshold).toBe(1);
 for(const [options,message]of [['threshold=1.01','Invalid lumakey threshold'],['tolerance=-0.1','Invalid lumakey tolerance'],['softness=2','Invalid lumakey softness'],['threshold=1/2','Only constant decimal lumakey threshold'],['threshold=abc','Only constant decimal'],['threshold=','Only constant decimal'],['tolerance=0x1','Only constant decimal'],['softness=1e','Only constant decimal'],['enable=1','timeline'],['enable=between(t,0,1)','timeline'],['threads=1','Unsupported lumakey option'],['foo=1','Unsupported lumakey option'],['0:0:0:0',''],['threshold=0:0.5','']] as const)expect(()=>parseLumakeyOptions(options),options).toThrow(message);
 expect(()=>parseLumakeyOptions('threshold=2')).toThrow(VideoFilterParseError);
 // The pinned vf_lumakey.c pixel_fmts in declared order.
 expect(lumakeyPixelFormats).toEqual('yuva444p yuva422p yuva420p yuva444p9le yuva422p9le yuva420p9le yuva444p10le yuva422p10le yuva420p10le yuva444p12le yuva422p12le yuva444p16le yuva422p16le yuva420p16le'.split(' '));
 expect(lumakeyOperator.formats!(parseLumakeyOptions(null))).toBe(lumakeyPixelFormats);expect(Object.isFrozen(lumakeyPixelFormats)).toBe(true);
 expect(videoOperator('lumakey')).toBe(lumakeyOperator);expect(lumakeyOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(lumakeyOperator.timeline).toBeUndefined();expect(lumakeyOperator.geometryCommands).toBeUndefined();
});
it('derives the eight-bit bounds as config_input does',()=>{
 const bounds=(options:string)=>lumakeyBounds(parseLumakeyOptions(options));
 expect(bounds('')).toEqual({white:2,black:0,so:0});expect(bounds('0.5:0.2:0.1')).toEqual({white:178,black:76,so:25});
 expect(bounds('1')).toEqual({white:255,black:252,so:0});expect(bounds('1:1:1')).toEqual({white:255,black:0,so:255});expect(bounds('0.3:0.3')).toEqual({white:153,black:0,so:0});
 // (0.1 + 0.2) * 255 truncates to 76 and (0.1 - 0.2) * 255 to -25, clipped to 0.
 expect(bounds('0.1:0.2:0.004')).toEqual({white:76,black:0,so:1});
});
it('keys alpha from luma into owned tight planes and copies Y, U and V without mutating padded input',()=>{
 const luma=[0,40,76,100,178,200,230,255],alpha=[1,2,3,4,5,6,7,8],frame=yuva(luma,alpha,4,2,6),before=frame.planes.map(plane=>[...plane]);
 const actual=lumakeyVideoFrame(frame,parseLumakeyOptions('0.5:0.2:0.1'),{maxFrameBytes:64});
 // b=76 w=178 so=25: 40 and 255 keep alpha; 100 and 178 key to 0; 200 -> (22*255)/25=224; 230 is outside w+so.
 expect([...actual.planes[3]!]).toEqual([1,2,0,0,0,224,7,8]);expect([...actual.planes[0]!]).toEqual(luma);expect([...actual.planes[1]!]).toEqual([10,11]);expect([...actual.planes[2]!]).toEqual([200,199]);
 expect(actual.linesizes).toEqual([4,2,2,4]);expect(actual.pts).toEqual(frame.pts);expect(actual.pts).not.toBe(frame.pts);expect(actual.metadata).toEqual({colorRange:1});
 expect(frame.planes.map(plane=>[...plane])).toEqual(before);for(const plane of actual.planes)expect(frame.planes.some(input=>input.buffer===plane.buffer)).toBe(false);
 // Below black: 255 - (l - b + so) * 255 / so, truncated.
 const low=lumakeyVideoFrame(yuva([52,60,75,76],[9,9,9,9],2,2),parseLumakeyOptions('0.5:0.2:0.1'),{maxFrameBytes:64});expect([...low.planes[3]!]).toEqual([245,164,11,0]);
 expect([...lumakeyVideoFrame(yuva([0,1,2,3],[9,9,9,9],2,2),parseLumakeyOptions(null),{maxFrameBytes:64}).planes[3]!]).toEqual([0,0,0,9]);
 expect([...lumakeyVideoFrame(yuva([0,1,128,255],[9,9,9,9],2,2),parseLumakeyOptions('1:1:1'),{maxFrameBytes:64}).planes[3]!]).toEqual([0,0,0,0]);
 expect([...lumakeyVideoFrame(yuva([0,3,4,255],[9,9,9,9],2,2),parseLumakeyOptions('0:0:1'),{maxFrameBytes:64}).planes[3]!]).toEqual([0,3,4,9]);
});
it('rejects unsupported layouts, budgets, malformed storage, settings and cancellation explicitly',()=>{
 const step=parseLumakeyOptions(null),good=()=>yuva([0,0,0,0],[0,0,0,0],2,2);
 for(const pixelFormat of ['yuva444p','yuva422p','yuv420p','gray','rgba','gbrap'])expect(()=>lumakeyVideoFrame({...good(),pixelFormat},step,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>lumakeyVideoFrame(good(),step,{maxFrameBytes:9})).toThrow('allocation limit');expect(()=>lumakeyVideoFrame(good(),step,{maxFrameBytes:0})).toThrow('allocation limit');expect(()=>lumakeyVideoFrame(yuva([0,0,0,0],[0,0,0,0],2,2,3),step,{maxFrameBytes:11})).toThrow('storage exceeds');
 expect(()=>lumakeyVideoFrame({...good(),linesizes:[1,1,1,2]},step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>lumakeyVideoFrame({...good(),linesizes:[2.5,1,1,2]},step,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>lumakeyVideoFrame({...good(),planes:[new Uint8Array(3),new Uint8Array(1),new Uint8Array(1),new Uint8Array(4)]},step,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>lumakeyVideoFrame({...good(),planes:good().planes.slice(0,3)},step,{maxFrameBytes:64})).toThrow('plane count');expect(()=>lumakeyVideoFrame({...good(),pts:{value:0n,timeBase:{num:1n,den:0n}}},step,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{threshold:-0.1},{tolerance:1.5},{softness:Number.NaN}])expect(()=>lumakeyVideoFrame(good(),{...step,...bad},{maxFrameBytes:64}),JSON.stringify(bad)).toThrow('Invalid lumakey settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>lumakeyVideoFrame(good(),step,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans lumakey on linear, graph and actor paths, refuses picks without storage by name and refuses runtime commands',async()=>{
 const plan=compileVideoFilterChain('lumakey=0.5:0.2,hflip').plan('yuva420p',4,2);expect(plan.stages.map(stage=>stage.operation)).toEqual(['lumakey','hflip']);expect(plan.stateBytes).toBe(0);
 const frame=yuva([0,100,150,255,0,100,150,255],[9,9,9,9,9,9,9,9],4,2),output=plan.apply(frame,{maxFrameBytes:20,maxStateBytes:0});expect([...output.planes[3]!]).toEqual([9,0,0,9,9,0,0,9]);expect(()=>plan.apply(frame,{maxFrameBytes:19,maxStateBytes:0})).toThrow();
 // Native converts yuv420p to yuva420p, and gray, yuv444p and packed RGBA to yuva444p (tests/differential/video-lumakey.test.ts).
 expect(compileVideoFilterChain('lumakey').plan('yuv420p',4,2).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuva420p'],['lumakey','yuva420p']]);
 for(const source of ['gray','rgba','yuv444p'])expect(()=>compileVideoFilterChain('lumakey').plan(source,4,2),source).toThrow('Video filter lumakey input negotiates yuva444p, which is not implemented');
 expect(()=>compileVideoFilterGraph('[0:v]lumakey=threshold=3[o]')).toThrow('Invalid lumakey threshold');expect(()=>createFrameActors('lumakey=softness=-1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('Invalid lumakey softness');
 expect(()=>compileVideoFilterChain('lumakey=enable=1')).toThrow('timeline');expect(()=>createFrameActors('lumakey=enable=gte(t\\,1)',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
 const actors=createFrameActors('lumakey=0.5:0.2',{maxSteps:64,maxQueuedFrames:2,maxQueuedBytes:1<<12,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry:{format:'yuva420p',width:4,height:2}}]});
 try{for(const [command,argument]of [['threshold','0'],['tolerance','1'],['softness','0.5'],['enable','0']] as const)expect(actors.sendFilterCommand('lumakey',command,argument).code,command).toBe(command==='enable'?-1163346256:-38);
  actors.sendFrameInput(0,{kind:'frame',duration:1n,frame});actors.endInput(0,-541478725,1n);const result=await actors.readFrame(0);expect(result.code).toBe(0);expect([...result.event!.frame.planes[3]!]).toEqual([9,0,0,9,9,0,0,9]);}finally{actors.dispose();}
});
