import {expect,it} from 'vitest';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {negotiableFormats,executableFormat} from '../../packages/avfilter/src/video-ops/formats.js';
import {colorcontrastConstants,colorcontrastOperator,colorcontrastPixel,colorcontrastPixelFormats,colorcontrastVideoFrame,parseColorcontrastOptions,VideoColorcontrastError} from '../../packages/avfilter/src/video-ops/colorcontrast.js';
const parse=(options:string|null)=>colorcontrastOperator.parse!({name:'colorcontrast',options} as never).configuration;
const zero={name:'colorcontrast',rc:0,gm:0,by:0,rcw:0,gmw:0,byw:0,pl:0};
const frame=(pixelFormat:string,width:number,height:number,pad=0):VideoFrameData=>{const layout=pixelLayout(pixelFormat,width,height);return {width,height,pixelFormat,planes:layout.planes.map((plane,index)=>Uint8Array.from({length:(plane.rowBytes+pad)*plane.height},(_,i)=>(index*64+i*37)&255)),linesizes:layout.planes.map(plane=>plane.rowBytes+pad),pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}};};
const single=(pixelFormat:string,bytes:readonly number[],step:ReturnType<typeof parse>)=>[...colorcontrastVideoFrame({width:1,height:1,pixelFormat,planes:[Uint8Array.from(bytes)],linesizes:[bytes.length],pts:null,metadata:{}},step,{maxFrameBytes:4}).planes[0]!];
it('parses defaults, the AVOption shorthand order, named options, constants and expressions into frozen float steps',()=>{
 expect(parse(null)).toEqual(zero);expect(Object.isFrozen(parse(null))).toBe(true);expect(parseColorcontrastOptions('')).toEqual(zero);
 expect(parse('-0.5:0.25:1:0.125:0.5:1:0.75')).toEqual({name:'colorcontrast',rc:-0.5,gm:0.25,by:1,rcw:0.125,gmw:0.5,byw:1,pl:0.75});
 expect(parse('pl=1:byw=0.5:rc=-1:rc=0.5')).toEqual({...zero,rc:0.5,byw:0.5,pl:1});
 // AV_OPT_TYPE_FLOAT stores the range-checked double as a float.
 expect(parse('rc=0.1').rc).toBe(Math.fround(0.1));expect(parse('gmw=1e-7').gmw).toBe(Math.fround(1e-7));expect(parse('pl=0.33').pl).toBe(Math.fround(0.33));
 expect(parse('rc=max:gm=min:by=default:rcw=max:gmw=min:byw=none:pl=max')).toEqual({...zero,rc:1,gm:-1,rcw:1,pl:1});expect(parse('rc=all').rc).toBe(-1);
 expect(parse('rc=1/3:gm=-0.5*2:pl=0x0').rc).toBe(Math.fround(1/3));expect(parse('gm=-0.5*2').gm).toBe(-1);expect(parse('rcw=+.5').rcw).toBe(.5);
});
it('refuses out-of-range, NaN and malformed values, timelines and unknown options before planning',()=>{
 for(const options of ['rc=1.0001','rc=-1.5','gm=2','by=-2','rcw=-0.001','gmw=1.5','byw=2','pl=-0.1','pl=1.01','rcw=all','pl=inf','rc=-inf'])expect(()=>parse(options),options).toThrow(/Invalid colorcontrast \w+: value outside/);
 for(const options of ['rc=','rc=abc','rc=1+','pl=(','gm=foo(1)'])expect(()=>parse(options),options).toThrow('Invalid colorcontrast');
 expect(()=>parse('rc=nan')).toThrow('Invalid colorcontrast rc: unable to parse nan');expect(()=>parse('pl=0/0')).toThrow('Invalid colorcontrast pl: unable to parse 0/0');
 expect(()=>parse('enable=1')).toThrow('timeline');expect(()=>parse('rc=0.5:enable=gt(t\\,1)')).toThrow('timeline');
 for(const options of ['threads=1','preserve=1','r=1','0:0:0:0:0:0:0:0'])expect(()=>parse(options),options).toThrow();
 expect(()=>parse('threads=1')).toThrow('Unsupported colorcontrast option');
});
it('lists native pixel_fmts in declared order and executes only the members with frame storage',()=>{
 expect(colorcontrastPixelFormats).toEqual('rgb24 bgr24 rgba bgra argb abgr 0rgb 0bgr rgb0 bgr0 gbrp gbrap gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap10le gbrap12le gbrap16le rgb48le bgr48le rgba64le bgra64le'.split(' '));
 expect(colorcontrastPixelFormats.every(format=>negotiableFormats.includes(format))).toBe(true);expect(Object.isFrozen(colorcontrastPixelFormats)).toBe(true);
 expect(colorcontrastPixelFormats.filter(executableFormat)).toEqual(['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp']);
 expect(colorcontrastOperator.formats!(parse(null))).toBe(colorcontrastPixelFormats);expect(videoOperator('colorcontrast')).toBe(colorcontrastOperator);
 expect(colorcontrastOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(colorcontrastOperator.timeline).toBeUndefined();expect(colorcontrastOperator.geometryCommands).toBeUndefined();
});
it('keeps frames whose weight sum is at most FLT_EPSILON unchanged and computes PROCESS in single precision otherwise',()=>{
 expect(colorcontrastConstants(parse(null))).toBeNull();expect(colorcontrastConstants(parse('rc=1:gm=-1:by=1:pl=1'))).toBeNull();
 // fround(4e-8) * 2 + fround(3e-8) stays below 2^-23; fround(5e-8) * 2 + fround(2e-8) does not.
 expect(colorcontrastConstants(parse('rcw=4e-8:gmw=4e-8:byw=3e-8'))).toBeNull();expect(colorcontrastConstants(parse('gmw=1e-7'))).toBeNull();expect(colorcontrastConstants(parse('rcw=5e-8:gmw=5e-8:byw=2e-8'))).not.toBeNull();
 const k=colorcontrastConstants(parse('rc=1:gm=0.5:by=-1:rcw=0.25:gmw=0.5:byw=1:pl=0.5'))!;expect([k.rc,k.gm,k.by,k.scale,k.preserve]).toEqual([0.5,0.25,-0.5,Math.fround(1/1.75),0.5]);
 // rc=1, rcw=1: r2 = r + (r - (g+b)/2) / 2, g2 = g - ..., b2 = b - ..., clipped to 0..255 and truncated.
 const red=colorcontrastConstants(parse('rc=1:rcw=1'))!;expect(colorcontrastPixel(200,100,50,red)).toEqual([255,37,0]);expect(colorcontrastPixel(10,20,30,red)).toEqual([2,27,37]);
 expect(colorcontrastPixel(0,0,0,red)).toEqual([0,0,0]);expect(colorcontrastPixel(255,255,255,red)).toEqual([255,255,255]);
 // pl=1 rescales by (max + min) / (new max + new min + FLT_EPSILON): 255 * 250 / 255 stays 250 after truncation.
 expect(colorcontrastPixel(200,100,50,colorcontrastConstants(parse('rc=1:rcw=1:pl=1'))!)).toEqual([250,36,0]);
 // gm=1, gmw=1 on gray stays gray; values measured from the reference build.
 expect(colorcontrastPixel(77,77,77,colorcontrastConstants(parse('gm=1:gmw=1'))!)).toEqual([77,77,77]);expect(colorcontrastPixel(40,200,90,colorcontrastConstants(parse('gm=1:gmw=1'))!)).toEqual([0,255,22]);
 expect(colorcontrastPixel(40,200,90,colorcontrastConstants(parse('by=-1:byw=1'))!)).toEqual([25,185,105]);
});
it('processes packed and planar channels into owned tight planes from padded input without mutating it, copying alpha',()=>{
 const step=parse('rc=0.6:gm=-0.4:by=0.9:rcw=0.3:gmw=0.6:byw=0.9:pl=0.4'),k=colorcontrastConstants(step)!;
 const rgba=frame('rgba',3,2,5),snapshot=rgba.planes.map(plane=>[...plane]),out=colorcontrastVideoFrame(rgba,step,{maxFrameBytes:34});
 expect(rgba.planes.map(plane=>[...plane])).toEqual(snapshot);expect(out.linesizes).toEqual([12]);expect(out.planes[0]!.buffer).not.toBe(rgba.planes[0]!.buffer);expect(out.pts).toEqual(rgba.pts);expect(out.pts).not.toBe(rgba.pts);expect(out.metadata).toEqual({colorRange:2});
 const source=rgba.planes[0]!;for(let y=0;y<2;y++)for(let x=0;x<3;x++){const o=y*17+x*4;expect([...out.planes[0]!.subarray(y*12+x*4,y*12+x*4+4)]).toEqual([...colorcontrastPixel(source[o]!,source[o+1]!,source[o+2]!,k),source[o+3]]);}
 const [r,g,b]=colorcontrastPixel(200,100,50,k);expect(single('rgba',[200,100,50,7],step)).toEqual([r,g,b,7]);expect(single('bgra',[50,100,200,7],step)).toEqual([b,g,r,7]);
 expect(single('argb',[7,200,100,50],step)).toEqual([7,r,g,b]);expect(single('abgr',[7,50,100,200],step)).toEqual([7,b,g,r]);expect(single('rgb24',[200,100,50],step)).toEqual([r,g,b]);expect(single('bgr24',[50,100,200],step)).toEqual([b,g,r]);
 // gbrp planes are G, B, R.
 const planar=colorcontrastVideoFrame({width:2,height:1,pixelFormat:'gbrp',planes:[Uint8Array.of(100,0),Uint8Array.of(50,255),Uint8Array.of(200,9)],linesizes:[2,2,2],pts:null,metadata:{}},step,{maxFrameBytes:6});
 expect(planar.planes.map(plane=>plane[0])).toEqual([g,b,r]);expect(planar.planes.map(plane=>plane[1])).toEqual((([rr,gg,bb])=>[gg,bb,rr])(colorcontrastPixel(9,0,255,k)));expect(planar.pts).toBeNull();
 // Identity settings still return an owned tight copy.
 const copy=colorcontrastVideoFrame(rgba,parse(null),{maxFrameBytes:34});expect([...copy.planes[0]!]).toEqual([...source.subarray(0,12),...source.subarray(17,29)]);expect(copy.planes[0]!.buffer).not.toBe(source.buffer);
});
it('rejects unsupported formats, budgets, malformed strides, settings and cancellation explicitly',()=>{
 const step=parse('rc=0.5:rcw=1');
 for(const format of ['yuv420p','gray','nv12','yuva420p','rgb0','0rgb'])expect(()=>colorcontrastVideoFrame(frame(format,2,2),step,{maxFrameBytes:64}),format).toThrow(VideoColorcontrastError);
 expect(()=>colorcontrastVideoFrame(frame('rgb24',3,2),step,{maxFrameBytes:17})).toThrow('allocation limit');expect(()=>colorcontrastVideoFrame(frame('rgb24',3,2,1),step,{maxFrameBytes:19})).toThrow('storage exceeds');expect(()=>colorcontrastVideoFrame(frame('rgb24',3,2),step,{maxFrameBytes:0})).toThrow('allocation limit');
 const short=frame('rgba',3,2);short.planes[0]=new Uint8Array(23);expect(()=>colorcontrastVideoFrame(short,step,{maxFrameBytes:64})).toThrow('stride or storage');
 const narrow=frame('rgba',3,2);narrow.linesizes[0]=11;expect(()=>colorcontrastVideoFrame(narrow,step,{maxFrameBytes:64})).toThrow('stride or storage');
 const fractional=frame('gbrp',3,2);fractional.linesizes[1]=3.5;expect(()=>colorcontrastVideoFrame(fractional,step,{maxFrameBytes:64})).toThrow('stride or storage');
 const missing=frame('gbrp',3,2);missing.planes.pop();expect(()=>colorcontrastVideoFrame(missing,step,{maxFrameBytes:64})).toThrow('plane count');
 for(const bad of [{rc:2},{pl:-1},{rcw:0.1},{gm:Number.NaN}])expect(()=>colorcontrastVideoFrame(frame('rgb24',1,1),{...zero,...bad} as never,{maxFrameBytes:64}),JSON.stringify(bad)).toThrow('Invalid colorcontrast settings');
 expect(()=>colorcontrastVideoFrame({...frame('rgb24',1,1),pts:{value:0n,timeBase:{num:0n,den:1n}}},step,{maxFrameBytes:64})).toThrow('time base');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>colorcontrastVideoFrame(frame('rgb24',3,2),step,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans colorcontrast through linear, graph and actor planners and refuses timelines and runtime commands',async()=>{
 const plan=compileVideoFilterChain('colorcontrast=rc=0.5:rcw=1,hflip').plan('rgba',5,3);expect(plan.stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['colorcontrast','rgba'],['hflip','rgba']]);expect(plan.stateBytes).toBe(0);
 expect(compileVideoFilterChain('colorcontrast').plan('gray',4,2).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','rgb24'],['colorcontrast','rgb24']]);
 const output=plan.apply(frame('rgba',5,3),{maxFrameBytes:60,maxStateBytes:0});expect(output.planes[0]!.length).toBe(60);expect(()=>plan.apply(frame('rgba',5,3),{maxFrameBytes:59,maxStateBytes:0})).toThrow();
 expect(compileVideoFilterGraph('[0:v]colorcontrast[out]').plan({format:'gbrp',width:4,height:2},[null]).negotiated.nodes[0]!.inputs[0]!.format).toBe('gbrp');
 for(const description of ['colorcontrast=enable=1','colorcontrast=rc=1:enable=gt(t\\,1)','colorcontrast=rc=2'])expect(()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:1<<16}),description).toThrow();
 const input=frame('rgb24',5,3),actors=createFrameActors('colorcontrast=rc=0.5:rcw=1',{maxSteps:64,maxQueuedFrames:2,maxQueuedBytes:1<<12,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry:{format:'rgb24',width:5,height:3}}]});
 try{for(const command of ['rc','gm','by','rcw','gmw','byw','pl','enable'])expect(actors.sendFilterCommand('colorcontrast',command,'0').code,command).toBe(command==='enable'?-1163346256:-38);
  actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:input});actors.endInput(0,-541478725,1n);const result=await actors.readFrame(0);expect(result.code).toBe(0);expect([...result.event!.frame.planes[0]!]).toEqual([...colorcontrastVideoFrame(input,parse('rc=0.5:rcw=1'),{maxFrameBytes:64}).planes[0]!]);}finally{actors.dispose();}
});
