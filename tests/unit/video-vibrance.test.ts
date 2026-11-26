import {expect,it} from 'vitest';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {negotiableFormats,executableFormat} from '../../packages/avfilter/src/video-ops/formats.js';
import {vibranceOperator,vibrancePixelFormats,vibranceVideoFrame,parseVibranceOptions,VideoVibranceError} from '../../packages/avfilter/src/video-ops/vibrance.js';
const parse=(options:string|null)=>vibranceOperator.parse!({name:'vibrance',options} as never).configuration;
const f=Math.fround,defaults={name:'vibrance',intensity:0,rbal:1,gbal:1,bbal:1,rlum:f(0.212656),glum:f(0.715158),blum:f(0.072186),alternate:false};
const frame=(pixelFormat:string,width:number,height:number,pad=0):VideoFrameData=>{const layout=pixelLayout(pixelFormat,width,height);return {width,height,pixelFormat,planes:layout.planes.map((plane,index)=>Uint8Array.from({length:(plane.rowBytes+pad)*plane.height},(_,i)=>(index*64+i*37)&255)),linesizes:layout.planes.map(plane=>plane.rowBytes+pad),pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}};};
/** An independent double-precision reading of vibrance_slice8 with every float operation rounded to single precision. */
function reference(step:ReturnType<typeof parse>,r:number,g:number,b:number):[number,number,number]{
 const s=f(1/255),G=f(g*s),B=f(b*s),R=f(r*s),sat=f(Math.max(R,G,B)-Math.min(R,G,B)),luma=f(f(f(G*step.glum)+f(R*step.rlum))+f(B*step.blum)),alt=step.alternate?1:-1;
 const one=(v:number,bal:number)=>{const k=f(step.intensity*bal),c=f(1+f(k*f(1-f(alt*(k>0?1:-1)*sat))));const o=Math.trunc(f(f(luma+f(f(v-luma)*c))*255));return Math.min(255,Math.max(0,o));};
 return [one(R,step.rbal),one(G,step.gbal),one(B,step.bbal)];
}
it('parses defaults, the declared shorthand order, named values and booleans into frozen float steps',()=>{
 expect(parse(null)).toEqual(defaults);expect(Object.isFrozen(parse(null))).toBe(true);
 expect(parse('0.8:2:0.5:-3:0.3:0.6:0.1:1')).toEqual({name:'vibrance',intensity:f(0.8),rbal:2,gbal:0.5,bbal:-3,rlum:f(0.3),glum:f(0.6),blum:f(0.1),alternate:true});
 expect(parse('intensity=-2:rbal=-10:gbal=10:bbal=0:rlum=0:glum=1:blum=1:alternate=0')).toEqual({name:'vibrance',intensity:-2,rbal:-10,gbal:10,bbal:0,rlum:0,glum:1,blum:1,alternate:false});
 expect(parse('intensity=max:rbal=min:gbal=none:bbal=all:rlum=default:glum=max:blum=min')).toEqual({name:'vibrance',intensity:2,rbal:-10,gbal:0,bbal:-1,rlum:f(0.212656),glum:1,blum:0,alternate:false});
 expect(parse('intensity=all').intensity).toBe(-1);expect(parse('intensity=.5:intensity=1e-1').intensity).toBe(f(0.1));expect(parseVibranceOptions('rbal=+.25').rbal).toBe(0.25);
 for(const value of ['1','true','y','yes','enable','enabled','on','TRUE'])expect(parse(`alternate=${value}`).alternate,value).toBe(true);
 for(const value of ['0','false','n','no','disable','disabled','off',''])expect(parse(`alternate=${value}`).alternate,value).toBe(false);
});
it('refuses timelines, out-of-range and non-constant values, and unknown options before planning',()=>{
 for(const options of ['intensity=2.0001','intensity=-3','rbal=10.5','gbal=-11','bbal=1e2','rlum=-0.1','glum=1.5','blum=all','rlum=-1'])expect(()=>parse(options),options).toThrow('outside');
 for(const options of ['intensity=1/3','intensity=0x1','intensity=nan','intensity=inf','intensity=','rbal=1k','glum=sqrt(0.25)','blum=PI'])expect(()=>parse(options),options).toThrow('Only constant');
 for(const options of ['alternate=2','alternate=-1','alternate=auto','alternate=maybe','alternate=1.0'])expect(()=>parse(options),options).toThrow('alternate');
 expect(()=>parse('enable=1')).toThrow('timeline');expect(()=>parse('intensity=1:enable=gt(t\\,1)')).toThrow('timeline');
 for(const options of ['threads=1','saturation=1','0:1:1:1:0.2:0.7:0.07:0:1'])expect(()=>parse(options),options).toThrow();
});
it('lists native query_formats in declared order and executes only the members with frame storage',()=>{
 expect(vibrancePixelFormats.every(format=>negotiableFormats.includes(format))).toBe(true);expect(new Set(vibrancePixelFormats).size).toBe(24);
 expect(vibrancePixelFormats.filter(executableFormat)).toEqual(['rgb24','bgr24','rgba','bgra','argb','abgr','gbrp']);
 expect(vibranceOperator.formats!(parse(null))).toBe(vibrancePixelFormats);expect(videoOperator('vibrance')).toBe(vibranceOperator);
 expect(vibranceOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
});
it('applies the single-precision kernel per pixel, copies alpha and follows every packed order and the gbrp plane order',()=>{
 const step=parse('intensity=1.3:rbal=-2:gbal=0.5:alternate=1'),input=frame('rgba',3,2,5),snapshot=input.planes.map(plane=>[...plane]),out=vibranceVideoFrame(input,step,{maxFrameBytes:34});
 expect(input.planes.map(plane=>[...plane])).toEqual(snapshot);expect(out.linesizes).toEqual([12]);expect(out.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);expect(out.pts).toEqual(input.pts);expect(out.pts).not.toBe(input.pts);expect(out.metadata).toEqual({colorRange:2});
 const source=input.planes[0]!;
 for(let y=0;y<2;y++)for(let x=0;x<3;x++){const o=y*17+x*4,[r,g,b,a]=[source[o]!,source[o+1]!,source[o+2]!,source[o+3]!];expect([...out.planes[0]!.subarray(y*12+x*4,y*12+x*4+4)]).toEqual([...reference(step,r,g,b),a]);}
 const one=(format:string,bytes:number[],s=step)=>[...vibranceVideoFrame({width:1,height:1,pixelFormat:format,planes:[Uint8Array.from(bytes)],linesizes:[bytes.length],pts:null,metadata:{}},s,{maxFrameBytes:4}).planes[0]!];
 const [r,g,b]=reference(step,200,90,30);
 expect(one('rgb24',[200,90,30])).toEqual([r,g,b]);expect(one('bgr24',[30,90,200])).toEqual([b,g,r]);expect(one('rgba',[200,90,30,7])).toEqual([r,g,b,7]);
 expect(one('bgra',[30,90,200,7])).toEqual([b,g,r,7]);expect(one('argb',[7,200,90,30])).toEqual([7,r,g,b]);expect(one('abgr',[7,30,90,200])).toEqual([7,b,g,r]);
 const planar=vibranceVideoFrame({width:2,height:1,pixelFormat:'gbrp',planes:[Uint8Array.of(90,0),Uint8Array.of(30,255),Uint8Array.of(200,9)],linesizes:[2,2,2],pts:null,metadata:{}},step,{maxFrameBytes:6});
 expect(planar.planes.map(plane=>plane[0])).toEqual([g,b,r]);expect(planar.pts).toBeNull();
 // Defaults are not an identity: luma + (v - luma) rounds in float and the store truncates.
 const identity=parse(null);let moved=0;for(let v=0;v<256;v++){const [rr,gg,bb]=reference(identity,v,255-v,(v*7)&255);expect(one('rgb24',[v,255-v,(v*7)&255],identity)).toEqual([rr,gg,bb]);if(rr!==v||gg!==255-v||bb!==((v*7)&255))moved++;}
 expect(moved).toBeGreaterThan(0);
 // Gray pixels have zero saturation and luma equal to the value up to rounding; FFSIGN(0) is -1, so zero intensity times a balance still yields 1.
 expect(one('rgb24',[0,0,0],parse('intensity=2'))).toEqual([0,0,0]);expect(one('rgb24',[255,0,0],parse('intensity=2'))).toEqual(reference(parse('intensity=2'),255,0,0));
});
it('rejects unsupported formats, budgets, malformed strides, settings and cancellation explicitly',()=>{
 const step=parse(null);
 for(const format of ['yuv420p','gray','nv12','yuva420p','yuv444p'])expect(()=>vibranceVideoFrame(frame(format,2,2),step,{maxFrameBytes:64}),format).toThrow(VideoVibranceError);
 expect(()=>vibranceVideoFrame(frame('rgb24',3,2),step,{maxFrameBytes:17})).toThrow('allocation limit');expect(()=>vibranceVideoFrame(frame('rgb24',3,2,1),step,{maxFrameBytes:19})).toThrow('storage exceeds');expect(()=>vibranceVideoFrame(frame('rgb24',3,2),step,{maxFrameBytes:0})).toThrow('allocation limit');
 const short=frame('rgba',3,2);short.planes[0]=new Uint8Array(23);expect(()=>vibranceVideoFrame(short,step,{maxFrameBytes:64})).toThrow('stride or storage');
 const narrow=frame('rgba',3,2);narrow.linesizes[0]=11;expect(()=>vibranceVideoFrame(narrow,step,{maxFrameBytes:64})).toThrow('stride or storage');
 const fractional=frame('gbrp',3,2);fractional.linesizes[1]=3.5;expect(()=>vibranceVideoFrame(fractional,step,{maxFrameBytes:64})).toThrow('stride or storage');
 const missing=frame('gbrp',3,2);missing.planes.pop();expect(()=>vibranceVideoFrame(missing,step,{maxFrameBytes:64})).toThrow('plane count');
 for(const bad of [{...step,intensity:3},{...step,rbal:0.1},{...step,glum:-1},{...step,alternate:1 as never}])expect(()=>vibranceVideoFrame(frame('rgb24',1,1),bad,{maxFrameBytes:64})).toThrow('settings');
 expect(()=>vibranceVideoFrame({...frame('rgb24',1,1),pts:{value:0n,timeBase:{num:0n,den:1n}}},step,{maxFrameBytes:64})).toThrow('time base');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>vibranceVideoFrame(frame('rgb24',3,2),step,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans vibrance through linear, graph and actor planners and refuses timelines and commands',()=>{
 const plan=compileVideoFilterChain('vibrance=intensity=0.5,hflip').plan('rgba',5,3);expect(plan.stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['vibrance','rgba'],['hflip','rgba']]);expect(plan.stateBytes).toBe(0);
 expect(compileVideoFilterChain('vibrance').plan('gray',4,2).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','rgb24'],['vibrance','rgb24']]);
 const output=plan.apply(frame('rgba',5,3),{maxFrameBytes:60,maxStateBytes:0});expect(output.planes[0]!.length).toBe(60);expect(()=>plan.apply(frame('rgba',5,3),{maxFrameBytes:59,maxStateBytes:0})).toThrow();
 const graph=compileVideoFilterGraph('[0:v]vibrance[out]').plan({format:'gbrp',width:4,height:2},[null]);expect(graph.negotiated.nodes[0]!.inputs[0]!.format).toBe('gbrp');
 for(const description of ['vibrance=enable=1','vibrance=intensity=1:enable=gt(t\\,1)','vibrance=intensity=1/2'])expect(()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:1<<16}),description).toThrow();
 expect(vibranceOperator.timeline).toBeUndefined();expect(vibranceOperator.geometryCommands).toBeUndefined();
});
