import {expect,it} from 'vitest';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {negotiableFormats,executableFormat} from '../../packages/avfilter/src/video-ops/formats.js';
import {balanceVideoColors,colorbalanceComponent,colorbalanceOperator,colorbalancePixel,colorbalancePixelFormats,colorbalancePreserve,parseColorbalanceOptions,VideoColorbalanceError} from '../../packages/avfilter/src/video-ops/colorbalance.js';
const parse=(options:string|null)=>colorbalanceOperator.parse!({name:'colorbalance',options} as never).configuration;
const zero=[0,0,0,0,0,0,0,0,0],f=Math.fround;
const frame=(pixelFormat:string,width:number,height:number,pad=0):VideoFrameData=>{const layout=pixelLayout(pixelFormat,width,height);return {width,height,pixelFormat,planes:layout.planes.map((plane,index)=>Uint8Array.from({length:(plane.rowBytes+pad)*plane.height},(_,i)=>(index*64+i*37)&255)),linesizes:layout.planes.map(plane=>plane.rowBytes+pad),pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}};};
it('parses defaults, the declared shorthand order, named balances, constants and pl into frozen single-precision steps',()=>{
 expect(parse(null)).toEqual({name:'colorbalance',balances:zero,preserveLightness:false});expect(Object.isFrozen(parse(null))).toBe(true);expect(Object.isFrozen(parse(null).balances)).toBe(true);
 expect(parse('-1:0.5:0:0.25:-0.75:1:0:0:-0.4:1')).toEqual({name:'colorbalance',balances:[-1,.5,0,.25,-.75,1,0,0,f(-.4),],preserveLightness:true});
 expect(parse('bh=0.3:rs=1e-1:gm=+.5').balances).toEqual([f(.1),0,0,0,.5,0,0,0,f(.3)]);
 expect(parse('rs=max:gs=min:bs=all:rm=none:gm=default').balances).toEqual([1,-1,-1,0,0,0,0,0,0]);
 expect(parse('rs=0.5:rs=-0.5').balances[0]).toBe(-.5);
 for(const [text,value]of [['1',true],['0',false],['true',true],['no',false],['enable',true],['off',false],['',false]] as const)expect(parse(`pl=${text}`).preserveLightness,text).toBe(value);
 expect(parseColorbalanceOptions('rh=0.333').balances[6]).toBe(f(.333));
});
it('refuses timelines, out-of-range and non-constant values, and unknown options before planning',()=>{
 for(const options of ['rs=1.0001','gs=-2','bh=1e1','rm=-1.5'])expect(()=>parse(options),options).toThrow('outside -1..1');
 for(const options of ['rs=1/3','rs=0x1','rs=nan','rs=inf','rs=','rs=1k','gm=sin(0)'])expect(()=>parse(options),options).toThrow('Only constant');
 for(const options of ['pl=2','pl=-1','pl=auto','pl=maybe'])expect(()=>parse(options),options).toThrow('Invalid colorbalance pl');
 expect(()=>parse('enable=1')).toThrow('timeline');expect(()=>parse('rs=1:enable=gt(t\\,1)')).toThrow('timeline');
 for(const options of ['threads=1','r=1','0:0:0:0:0:0:0:0:0:0:1'])expect(()=>parse(options),options).toThrow();
});
it('lists native query_formats in declared order and executes only the members with frame storage',()=>{
 expect(colorbalancePixelFormats.every(format=>negotiableFormats.includes(format))).toBe(true);expect(new Set(colorbalancePixelFormats).size).toBe(24);
 expect(colorbalancePixelFormats.slice(0,6)).toEqual(['rgb24','bgr24','rgba','bgra','abgr','argb']);
 expect(colorbalancePixelFormats.filter(executableFormat)).toEqual(['rgb24','bgr24','rgba','bgra','abgr','argb','gbrp']);
 expect(colorbalanceOperator.formats!(parse(null))).toBe(colorbalancePixelFormats);expect(videoOperator('colorbalance')).toBe(colorbalanceOperator);
 expect(colorbalanceOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
});
it('keeps every byte with the defaults and follows get_component and preservel in single precision',()=>{
 const defaults=parse(null);for(let v=0;v<256;v++)expect(colorbalancePixel(defaults,v,255-v,v>>1)).toEqual([v,255-v,v>>1]);
 // Shadows weigh dark pixels only, highlights bright ones; components clip to 0..1.
 expect(colorbalanceComponent(0,0,1,0,0)).toBe(f(f(0.7)));expect(colorbalanceComponent(1,2,1,1,-1)).toBe(f(1-f(0.7)));expect(colorbalanceComponent(0.5,0.5,-1,0,0)).toBe(0.5);
 expect(colorbalancePixel(parse('rs=1:gs=1:bs=1'),0,0,0)).toEqual([178,178,178]);expect(colorbalancePixel(parse('rh=-1:gh=-1:bh=-1'),255,255,255)).toEqual([76,76,76]);
 // pl with black or white input divides by zero: native's NaN saturation clips every component to 0.
 expect(colorbalancePixel(parse('rs=0.5:gs=0.5:bs=0.5:pl=1'),0,0,0)).toEqual([0,0,0]);expect(colorbalancePixel(parse('rh=-0.5:gh=-0.5:bh=-0.5:pl=1'),255,255,255)).toEqual([0,0,0]);
 expect(colorbalancePreserve(0.5,0.5,0.5,1)).toEqual([0.5,0.5,0.5]);
 const [r,g,b]=colorbalancePreserve(f(0.8),f(0.4),f(0.2),f(1));expect(r).toBeCloseTo(0.8,5);expect(g).toBeCloseTo(0.4,5);expect(b).toBeCloseTo(0.2,5);
});
it('balances packed and planar pixels into owned tight planes from padded input without mutating it',()=>{
 const step=parse('rs=0.3:gm=-0.2:bh=0.5:pl=1');
 const rgba=frame('rgba',3,2,5),snapshot=rgba.planes.map(plane=>[...plane]),out=balanceVideoColors(rgba,step,{maxFrameBytes:34});
 expect(rgba.planes.map(plane=>[...plane])).toEqual(snapshot);expect(out.linesizes).toEqual([12]);expect(out.planes[0]!.buffer).not.toBe(rgba.planes[0]!.buffer);expect(out.pts).toEqual(rgba.pts);expect(out.pts).not.toBe(rgba.pts);expect(out.metadata).toEqual({colorRange:2});
 const source=rgba.planes[0]!;for(let y=0;y<2;y++)for(let x=0;x<3;x++){const o=y*17+x*4;expect([...out.planes[0]!.subarray(y*12+x*4,y*12+x*4+4)]).toEqual([...colorbalancePixel(step,source[o]!,source[o+1]!,source[o+2]!),source[o+3]!]);}
 const pixel=(format:string,bytes:number[])=>[...balanceVideoColors({width:1,height:1,pixelFormat:format,planes:[Uint8Array.from(bytes)],linesizes:[bytes.length],pts:null,metadata:{}},step,{maxFrameBytes:4}).planes[0]!];
 const [r,g,b]=colorbalancePixel(step,200,100,50);
 expect(pixel('rgba',[200,100,50,7])).toEqual([r,g,b,7]);expect(pixel('bgra',[50,100,200,7])).toEqual([b,g,r,7]);expect(pixel('argb',[7,200,100,50])).toEqual([7,r,g,b]);expect(pixel('abgr',[7,50,100,200])).toEqual([7,b,g,r]);
 expect(pixel('rgb24',[200,100,50])).toEqual([r,g,b]);expect(pixel('bgr24',[50,100,200])).toEqual([b,g,r]);
 const planar=balanceVideoColors({width:2,height:1,pixelFormat:'gbrp',planes:[Uint8Array.of(100,0),Uint8Array.of(50,255),Uint8Array.of(200,9)],linesizes:[2,2,2],pts:null,metadata:{}},step,{maxFrameBytes:6});
 expect(planar.planes.map(plane=>plane[0])).toEqual([g,b,r]);const [r2,g2,b2]=colorbalancePixel(step,9,0,255);expect(planar.planes.map(plane=>plane[1])).toEqual([g2,b2,r2]);expect(planar.pts).toBeNull();
});
it('rejects unsupported formats, budgets, malformed strides, settings and cancellation explicitly',()=>{
 const step=parse(null);
 for(const format of ['yuv420p','gray','nv12','yuva420p','rgb0','0rgb','bgr0'])expect(()=>balanceVideoColors(frame(format,2,2),step,{maxFrameBytes:64}),format).toThrow(VideoColorbalanceError);
 expect(()=>balanceVideoColors(frame('rgb24',3,2),step,{maxFrameBytes:17})).toThrow('allocation limit');expect(()=>balanceVideoColors(frame('rgb24',3,2,1),step,{maxFrameBytes:19})).toThrow('storage exceeds');expect(()=>balanceVideoColors(frame('rgb24',3,2),step,{maxFrameBytes:0})).toThrow('allocation limit');
 const short=frame('rgba',3,2);short.planes[0]=new Uint8Array(23);expect(()=>balanceVideoColors(short,step,{maxFrameBytes:64})).toThrow('stride or storage');
 const narrow=frame('rgba',3,2);narrow.linesizes[0]=11;expect(()=>balanceVideoColors(narrow,step,{maxFrameBytes:64})).toThrow('stride or storage');
 const fractional=frame('gbrp',3,2);fractional.linesizes[1]=3.5;expect(()=>balanceVideoColors(fractional,step,{maxFrameBytes:64})).toThrow('stride or storage');
 const missing=frame('gbrp',3,2);missing.planes.pop();expect(()=>balanceVideoColors(missing,step,{maxFrameBytes:64})).toThrow('plane count');
 for(const balances of [[2,...zero.slice(1)],[0.1,...zero.slice(1)],zero.slice(1)])expect(()=>balanceVideoColors(frame('rgb24',1,1),{name:'colorbalance',balances,preserveLightness:false},{maxFrameBytes:64})).toThrow('settings');
 expect(()=>balanceVideoColors({...frame('rgb24',1,1),pts:{value:0n,timeBase:{num:0n,den:1n}}},step,{maxFrameBytes:64})).toThrow('time base');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>balanceVideoColors(frame('rgb24',3,2),step,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans colorbalance through linear, graph and actor planners and refuses timelines and commands',()=>{
 const plan=compileVideoFilterChain('colorbalance=rs=0.5,hflip').plan('rgba',5,3);expect(plan.stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['colorbalance','rgba'],['hflip','rgba']]);expect(plan.stateBytes).toBe(0);
 expect(compileVideoFilterChain('colorbalance').plan('gray',4,2).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','rgb24'],['colorbalance','rgb24']]);
 const output=plan.apply(frame('rgba',5,3),{maxFrameBytes:60,maxStateBytes:0});expect(output.planes[0]!.length).toBe(60);expect(()=>plan.apply(frame('rgba',5,3),{maxFrameBytes:59,maxStateBytes:0})).toThrow();
 const graph=compileVideoFilterGraph('[0:v]colorbalance[out]').plan({format:'gbrp',width:4,height:2},[null]);expect(graph.negotiated.nodes[0]!.inputs[0]!.format).toBe('gbrp');
 for(const description of ['colorbalance=enable=1','colorbalance=rs=1:enable=gt(t\\,1)','colorbalance=rs=1/3'])expect(()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:1<<16}),description).toThrow();
 expect(colorbalanceOperator.timeline).toBeUndefined();expect(colorbalanceOperator.geometryCommands).toBeUndefined();
});
