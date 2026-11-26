import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {rgbashiftOperator,parseRgbashiftOptions,VideoRgbashiftError} from '../../packages/avfilter/src/video-ops/rgbashift.js';
import type {RgbashiftStep} from '../../packages/avfilter/src/video-ops/rgbashift.js';
const gbrp=(width:number,height:number,padding=0):VideoFrameData=>({width,height,pixelFormat:'gbrp',planes:[0,1,2].map(plane=>Uint8Array.from({length:(width+padding)*height},(_,i)=>(plane*64+i)&255)),linesizes:[0,1,2].map(()=>width+padding),pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:1}});
const frame=(input:VideoFrameData,options:string|null,maxFrameBytes=4096,signal?:AbortSignal)=>rgbashiftOperator.frame!(input,parseRgbashiftOptions(options),{maxFrameBytes,...(signal?{signal}:{})});
const values=(output:VideoFrameData)=>output.planes.map(plane=>[...plane]);
it('parses declared defaults, shorthand order, edge constants and duplicate keys into frozen steps',()=>{
 const zero={name:'rgbashift',rh:0,rv:0,gh:0,gv:0,bh:0,bv:0,ah:0,av:0,edge:0};
 expect(parseRgbashiftOptions(null)).toEqual(zero);expect(Object.isFrozen(parseRgbashiftOptions(''))).toBe(true);
 expect(parseRgbashiftOptions('1:-2:3:-4:5:-6:7:-8:wrap')).toEqual({name:'rgbashift',rh:1,rv:-2,gh:3,gv:-4,bh:5,bv:-6,ah:7,av:-8,edge:1});
 expect(parseRgbashiftOptions('av=255:rh=-255:edge=1:edge=smear:rh=+7:gh=-0:bv=007')).toEqual({...zero,rh:7,bv:7,av:255});expect(Object.is(parseRgbashiftOptions('gh=-0').gh,0)).toBe(true);
 for(const options of ['rh=256','bv=-256','av=99999999999999999999','gh=1.5','rv=1+1','bh=0x1','ah=','rh=1 2','edge=2','edge=-1','edge=WRAP','edge=','edge=smear+wrap','enable=1','threads=2','cbh=1','foo=1','1:2:3:4:5:6:7:8:wrap:9','rh=1:2'])expect(()=>parseRgbashiftOptions(options),options).toThrow();
 expect(()=>parseRgbashiftOptions('enable=1')).toThrow('timeline');expect(()=>parseRgbashiftOptions('ah=256')).toThrow('-255 to 255');expect(()=>parseRgbashiftOptions('cbh=1')).toThrow('Unsupported rgbashift option');expect(()=>parseRgbashiftOptions('edge=2')).toThrow('edge smear, wrap');
 expect(()=>compileVideoFilterChain('rgbashift=enable=1')).toThrow('timeline');expect(()=>createFrameActors('rgbashift=enable=1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
});
it('shifts the G, B and R planes with smear clamping and C-remainder wrap into owned tight planes',()=>{
 const input=gbrp(3,2,2),before=input.planes.map(plane=>[...plane]);
 expect(values(frame(input,null))).toEqual([[0,1,2,5,6,7],[64,65,66,69,70,71],[128,129,130,133,134,135]]);
 // gbrp has three planes, so the alpha shifts have no effect (nb_planes < 4).
 expect(values(frame(input,'ah=5:av=-5:edge=wrap'))).toEqual(values(frame(input,null)));
 expect(values(frame(input,'gh=1:bv=-1:rh=-1:rv=1'))).toEqual([[0,0,1,5,5,6],[69,70,71,69,70,71],[129,130,130,129,130,130]]);
 const wrap=frame(input,'gh=1:bh=-4:bv=3:rv=-1:edge=wrap');expect(values(wrap)).toEqual([[2,0,1,7,5,6],[70,71,69,65,66,64],[133,134,135,128,129,130]]);
 expect(values(frame(input,'rh=255:rv=-255:edge=wrap'))[2]).toEqual([133,134,135,128,129,130]);expect(values(frame(input,'rh=255:rv=-255'))[2]).toEqual([133,133,133,133,133,133]);
 expect(values(frame(input,'gh=-255:gv=255:bh=4:bv=-4'))).toEqual([[2,2,2,2,2,2],[69,69,69,69,69,69],[128,129,130,133,134,135]]);
 expect(wrap.linesizes).toEqual([3,3,3]);expect(wrap.pts).toEqual(input.pts);expect(wrap.pts).not.toBe(input.pts);expect(wrap.metadata).toEqual({colorRange:1});expect(wrap.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);
 expect(input.planes.map(plane=>[...plane])).toEqual(before);
 expect(values(frame(gbrp(1,1),'rh=-3:gv=2:bh=255:edge=wrap'))).toEqual([[0],[64],[128]]);
});
it('rejects unsupported layouts, budgets, malformed storage, settings and cancellation explicitly',()=>{
 // The pinned vf_chromashift.c rgb_pix_fmts in declared order.
 expect(rgbashiftOperator.formats!(parseRgbashiftOptions(null))).toEqual('gbrp gbrap gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap10le gbrap12le gbrap16le'.split(' '));
 for(const pixelFormat of ['gray','yuv444p','rgb24','gbrap','gbrp9le','pal8']){expect(()=>frame({...gbrp(2,2),pixelFormat},null),pixelFormat).toThrow('not supported');expect(()=>rgbashiftOperator.validate!(pixelFormat,parseRgbashiftOptions(null)),pixelFormat).toThrow(VideoRgbashiftError);}
 expect(()=>frame(gbrp(3,2),null,17)).toThrow('allocation limit');expect(()=>frame(gbrp(3,2,1),null,20)).toThrow('storage exceeds');expect(frame(gbrp(3,2),null,18).planes[0]!.length).toBe(6);
 const bad=gbrp(3,2);expect(()=>frame({...bad,linesizes:[3,2,3]},null)).toThrow('stride or storage');expect(()=>frame({...bad,planes:[bad.planes[0]!.subarray(1),...bad.planes.slice(1)]},null)).toThrow('stride or storage');expect(()=>frame({...bad,linesizes:[3,3.5,3]},null)).toThrow('stride or storage');expect(()=>frame({...bad,planes:bad.planes.slice(0,2)},null)).toThrow('plane count');expect(()=>frame({...bad,linesizes:[3,3]},null)).toThrow('plane count');
 expect(()=>frame({...bad,width:0},null)).toThrow();expect(()=>frame({...bad,pts:{value:0n,timeBase:{num:1n,den:0n}}},null)).toThrow('time base');
 for(const step of [{rh:256},{av:-256},{gv:0.5},{edge:2}])expect(()=>rgbashiftOperator.frame!(bad,{...parseRgbashiftOptions(null),...step} as RgbashiftStep,{maxFrameBytes:64}),JSON.stringify(step)).toThrow('Invalid rgbashift settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>frame(bad,null,64,controller.signal)).toThrow('stop');
});
it('negotiates gbrp and refuses the gbrap pick without storage on the linear, graph and timed planners before output',()=>{
 const plan=compileVideoFilterChain('rgbashift=1,hflip').plan('rgb24',5,3);expect(plan.stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','gbrp'],['rgbashift','gbrp'],['hflip','gbrp']]);
 for(const source of ['gbrp','bgr24','gray','yuv420p','nv12'])expect(compileVideoFilterChain('rgbashift').plan(source,5,3).pixelFormat,source).toBe('gbrp');
 for(const source of ['rgba','argb','yuva420p'])expect(()=>compileVideoFilterChain('rgbashift').plan(source,5,3),source).toThrow('Video filter rgbashift input negotiates gbrap, which is not implemented');
 expect(()=>compileVideoFilterGraph('[0:v]rgbashift[out]').plan({format:'bgra',width:5,height:3},[null])).toThrow('negotiates gbrap, which is not implemented');
 expect(()=>planTimedVideoGraph('rgbashift',[{geometry:{format:'rgba',width:5,height:3},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}],[null])).toThrow('negotiates gbrap, which is not implemented');
});
