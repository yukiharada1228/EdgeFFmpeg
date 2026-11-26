import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {colorizeComponents,colorizeOperator,colorizePixelFormats,colorizeVideoFrame,parseColorizeOptions,VideoColorizeError} from '../../packages/avfilter/src/video-ops/colorize.js';
import type {ColorizeStep} from '../../packages/avfilter/src/video-ops/colorize.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
const yuv=(pixelFormat:string,width:number,height:number,padding=0):VideoFrameData=>{
 const cw=pixelFormat==='yuv444p'?width:Math.ceil(width/2),ch=pixelFormat==='yuv420p'||pixelFormat==='yuva420p'?Math.ceil(height/2):height,shapes=[[width,height],[cw,ch],[cw,ch],...(pixelFormat==='yuva420p'?[[width,height]]:[])];
 return {width,height,pixelFormat,planes:shapes.map(([w,h],plane)=>Uint8Array.from({length:(w!+padding)*h!},(_,i)=>(plane*64+i*29)&255)),linesizes:shapes.map(([w])=>w!+padding),pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:1}};
};
const frame=(input:VideoFrameData,options:string|null,maxFrameBytes=4096,signal?:AbortSignal)=>colorizeVideoFrame(input,parseColorizeOptions(options),{maxFrameBytes,...(signal?{signal}:{})});
it('parses declared defaults, shorthand order, float storage, ranges and duplicate keys into frozen steps',()=>{
 expect(parseColorizeOptions(null)).toEqual({name:'colorize',hue:0,saturation:0.5,lightness:0.5,mix:1});expect(Object.isFrozen(parseColorizeOptions(''))).toBe(true);
 expect(parseColorizeOptions('120:1:0.25:0')).toEqual({name:'colorize',hue:120,saturation:1,lightness:0.25,mix:0});
 expect(parseColorizeOptions('mix=0.3:hue=360:hue=+12.5:saturation=.0:lightness=1.')).toEqual({name:'colorize',hue:12.5,saturation:0,lightness:1,mix:Math.fround(0.3)});
 // AV_OPT_TYPE_FLOAT stores the range-checked double as float.
 expect(parseColorizeOptions('hue=0.1').hue).toBe(Math.fround(0.1));expect(parseColorizeOptions('mix=1e-50').mix).toBe(0);expect(parseColorizeOptions('lightness=5e-1').lightness).toBe(0.5);
 for(const [options,message]of [['hue=360.0001','colorize hue must be within [0,360]'],['hue=-1','within [0,360]'],['saturation=1.5','colorize saturation must be within [0,1]'],['lightness=-0.01','colorize lightness must be within [0,1]'],['mix=2','colorize mix must be within [0,1]'],['hue=1+1','Only decimal colorize hue values'],['hue=0x10','Only decimal'],['mix=max','Only decimal colorize mix values'],['hue=1k','Only decimal'],['hue=inf','Only decimal'],['hue=nan','Only decimal'],['hue=','Only decimal'],['hue=1 2','Only decimal'],['enable=1','Colorize timeline expressions are not implemented'],['enable=between(t,0,1)','timeline'],['threads=2','Unsupported colorize option'],['h=1','Unsupported colorize option'],['foo=1','Unsupported colorize option'],['1:0.5:0.5:1:7',''],['hue=1:0.5','']] as const)expect(()=>parseColorizeOptions(options),options).toThrow(message);
 expect(()=>parseColorizeOptions('mix=2')).toThrow(VideoFilterParseError);
 expect(()=>compileVideoFilterChain('colorize=enable=1')).toThrow('timeline');expect(()=>compileVideoFilterGraph('[0:v]colorize=hue=400[o]')).toThrow('within [0,360]');expect(()=>createFrameActors('colorize=enable=gte(t\\,1)',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
 // The pinned vf_colorize.c pixel_fmts in declared order.
 expect(colorizePixelFormats).toEqual('yuv410p yuv411p yuv420p yuv422p yuv440p yuv444p yuvj420p yuvj422p yuvj440p yuvj444p yuvj411p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv440p10le yuv444p12le yuv422p12le yuv420p12le yuv440p12le yuv444p14le yuv422p14le yuv420p14le yuv420p16le yuv422p16le yuv444p16le yuva420p yuva422p yuva444p yuva444p9le yuva444p10le yuva444p12le yuva444p16le yuva422p9le yuva422p10le yuva422p12le yuva422p16le yuva420p9le yuva420p10le yuva420p16le'.split(' '));
 expect(colorizeOperator.formats!(parseColorizeOptions(null))).toBe(colorizePixelFormats);expect(Object.isFrozen(colorizePixelFormats)).toBe(true);
 expect(videoOperator('colorize')).toBe(colorizeOperator);expect(colorizeOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(colorizeOperator.timeline).toBeUndefined();expect(colorizeOperator.geometryCommands).toBeUndefined();
});
it('derives c[] with float hsl2rgb and double rgb2yuv truncation',()=>{
 expect(colorizeComponents(0,0.5,0.5)).toEqual([78,114,183]);expect(colorizeComponents(120,1,0.25)).toEqual([78,84,76]);expect(colorizeComponents(240,1,0.5)).toEqual([15,239,117]);expect(colorizeComponents(300,0.75,0.6)).toEqual([103,179,188]);
 // Black and white: no chroma, luma 0 and 219 (limited range scaled by 255).
 expect(colorizeComponents(0,0,0)).toEqual([0,127,127]);expect(colorizeComponents(77,1,0)).toEqual([0,127,127]);expect(colorizeComponents(0,0,1)).toEqual([219,127,127]);
 // h=360 wraps to t=1 for green, as hue 0 does after the single t-=1 step.
 expect(colorizeComponents(360,0.5,0.5)).toEqual(colorizeComponents(0,0.5,0.5));
});
it('lerps luma, fills chroma, copies alpha into owned tight planes without mutating padded input',()=>{
 const input=yuv('yuv444p',3,2,2),before=input.planes.map(plane=>[...plane]),output=frame(input,'hue=120:saturation=1:lightness=0.25:mix=0.3');
 // lerpf(78, v1, 0.3f) in float, truncated by the uint8_t store.
 const lerp=(v1:number)=>Math.trunc(Math.fround(78+Math.fround(Math.fround(v1-78)*Math.fround(0.3))));
 expect([...output.planes[0]!]).toEqual([0,29,58,145,174,203].map(lerp));expect([...output.planes[0]!].slice(0,2)).toEqual([54,63]);
 expect([...output.planes[1]!]).toEqual(Array(6).fill(84));expect([...output.planes[2]!]).toEqual(Array(6).fill(76));
 expect(output.linesizes).toEqual([3,3,3]);expect(output.pts).toEqual(input.pts);expect(output.pts).not.toBe(input.pts);expect(output.metadata).toEqual({colorRange:1});expect(output.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);
 expect(input.planes.map(plane=>[...plane])).toEqual(before);
 // The default mix=1 keeps luma exactly; mix=0 replaces it with c[0].
 expect([...frame(input,null).planes[0]!]).toEqual([0,29,58,145,174,203]);expect([...frame(input,'mix=0').planes[0]!]).toEqual(Array(6).fill(78));
 const alpha=yuv('yuva420p',5,3,1),result=frame(alpha,'240:1:0.5');expect(result.planes.map(plane=>plane.length)).toEqual([15,6,6,15]);expect([...result.planes[1]!]).toEqual(Array(6).fill(239));expect([...result.planes[2]!]).toEqual(Array(6).fill(117));
 expect([...result.planes[3]!]).toEqual([0,1,2,3,4,6,7,8,9,10,12,13,14,15,16].map(i=>(3*64+i*29)&255));
 expect(frame(yuv('yuv422p',4,2),null).planes.map(plane=>plane.length)).toEqual([8,4,4]);expect([...frame(yuv('yuv420p',1,1),'0:0:1:0').planes.map(plane=>plane[0])]).toEqual([219,127,127]);
});
it('rejects unsupported layouts, budgets, malformed storage, settings and cancellation explicitly',()=>{
 for(const pixelFormat of ['gray','nv12','rgb24','gbrp','yuva444p','pal8'])expect(()=>frame({...yuv('yuv444p',2,2),pixelFormat},null),pixelFormat).toThrow();
 for(const pixelFormat of ['gray','nv12','rgb24','gbrp'])expect(()=>frame({...yuv('yuv444p',2,2),pixelFormat},null),pixelFormat).toThrow('Colorize pixel format is not supported');
 expect(()=>frame(yuv('yuv420p',3,2),null,9)).toThrow('allocation limit');expect(()=>frame(yuv('yuv420p',3,2,1),null,13)).toThrow('storage exceeds');expect(frame(yuv('yuv420p',3,2),null,10).planes[0]!.length).toBe(6);
 const bad=yuv('yuv420p',3,2);expect(()=>frame({...bad,linesizes:[2,2,2]},null)).toThrow('stride or storage');expect(()=>frame({...bad,planes:[bad.planes[0]!.subarray(1),...bad.planes.slice(1)]},null)).toThrow('stride or storage');expect(()=>frame({...bad,linesizes:[3,2.5,2]},null)).toThrow('stride or storage');expect(()=>frame({...bad,planes:bad.planes.slice(0,2)},null)).toThrow('plane count');
 expect(()=>frame({...bad,width:0},null)).toThrow();expect(()=>frame({...bad,pts:{value:0n,timeBase:{num:1n,den:0n}}},null)).toThrow('time base');
 for(const step of [{hue:361},{saturation:-1},{lightness:2},{mix:0.1},{mix:Number.NaN},{hue:'1'}])expect(()=>colorizeVideoFrame(bad,{...parseColorizeOptions(null),...step} as unknown as ColorizeStep,{maxFrameBytes:64}),JSON.stringify(step)).toThrow(VideoColorizeError);
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>frame(bad,null,64,controller.signal)).toThrow('stop');
});
it('negotiates its yuv formats, refuses picks without storage on every planner and refuses runtime commands',async()=>{
 const plan=compileVideoFilterChain('colorize=hue=30,hflip').plan('gbrp',5,3);expect(plan.stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv444p'],['colorize','yuv444p'],['hflip','yuv444p']]);expect(plan.stateBytes).toBe(0);
 expect(compileVideoFilterChain('colorize').plan('nv12',5,3).stages[0]!.pixelFormat).toBe('yuv420p');expect(compileVideoFilterChain('colorize').plan('yuva420p',5,3).stages[0]!.pixelFormat).toBe('yuva420p');
 // Native converts gray to yuvj444p and packed RGB with alpha to yuva444p (tests/differential/video-colorize.test.ts): no frame storage here.
 expect(()=>compileVideoFilterChain('colorize').plan('gray',5,3)).toThrow('Video filter colorize input negotiates yuvj444p, which is not implemented');
 expect(()=>compileVideoFilterChain('colorize').plan('rgba',5,3)).toThrow('Video filter colorize input negotiates yuva444p, which is not implemented');
 expect(()=>compileVideoFilterGraph('[0:v]colorize[out]').plan({format:'argb',width:5,height:3},[null])).toThrow('yuva444p');
 expect(()=>planTimedVideoGraph('colorize',[{geometry:{format:'gray',width:5,height:3},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}],[null])).toThrow('yuvj444p');
 const input=yuv('yuv444p',3,2),actors=createFrameActors('colorize=mix=0',{maxSteps:64,maxQueuedFrames:2,maxQueuedBytes:1<<12,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry:{format:'yuv444p',width:3,height:2}}]});
 try{for(const [command,argument]of [['hue','10'],['saturation','0'],['lightness','1'],['mix','1'],['enable','0']] as const)expect(actors.sendFilterCommand('colorize',command,argument).code,command).toBe(command==='enable'?-1163346256:-38);
  actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:input});actors.endInput(0,-541478725,1n);const result=await actors.readFrame(0);expect(result.code).toBe(0);expect([...result.event!.frame.planes[0]!]).toEqual(Array(6).fill(78));}finally{actors.dispose();}
});
