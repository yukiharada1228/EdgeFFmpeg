import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {chromashiftOperator,parseChromashiftOptions,VideoChromashiftError} from '../../packages/avfilter/src/video-ops/chromashift.js';
import type {ChromashiftStep} from '../../packages/avfilter/src/video-ops/chromashift.js';
const yuv=(pixelFormat:string,width:number,height:number,padding=0):VideoFrameData=>{
 const cw=pixelFormat==='yuv444p'?width:Math.ceil(width/2),ch=pixelFormat==='yuv420p'||pixelFormat==='yuva420p'?Math.ceil(height/2):height,shapes=[[width,height],[cw,ch],[cw,ch],...(pixelFormat==='yuva420p'?[[width,height]]:[])];
 return {width,height,pixelFormat,planes:shapes.map(([w,h],plane)=>Uint8Array.from({length:(w!+padding)*h!},(_,i)=>(plane*64+i)&255)),linesizes:shapes.map(([w])=>w!+padding),pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:1}};
};
const frame=(input:VideoFrameData,options:string|null,maxFrameBytes=4096,signal?:AbortSignal)=>chromashiftOperator.frame!(input,parseChromashiftOptions(options),{maxFrameBytes,...(signal?{signal}:{})});
it('parses declared defaults, shorthand order, edge constants and duplicate keys into frozen steps',()=>{
 expect(parseChromashiftOptions(null)).toEqual({name:'chromashift',cbh:0,cbv:0,crh:0,crv:0,edge:0});expect(Object.isFrozen(parseChromashiftOptions(''))).toBe(true);
 expect(parseChromashiftOptions('1:-2:3:-4:wrap')).toEqual({name:'chromashift',cbh:1,cbv:-2,crh:3,crv:-4,edge:1});
 expect(parseChromashiftOptions('crv=255:cbh=-255:edge=1:edge=smear:cbh=+7:crh=-0:cbv=007')).toEqual({name:'chromashift',cbh:7,cbv:7,crh:0,crv:255,edge:0});expect(Object.is(parseChromashiftOptions('crh=-0').crh,0)).toBe(true);
 for(const options of ['cbh=256','cbh=-256','crv=99999999999999999999','cbh=1.5','cbh=1+1','cbh=0x1','cbh=','cbh=1 2','edge=2','edge=-1','edge=SMEAR','edge=','edge=smear+wrap','enable=1','threads=2','rh=1','foo=1','1:2:3:4:wrap:5','cbh=1:2'])expect(()=>parseChromashiftOptions(options),options).toThrow();
 expect(()=>parseChromashiftOptions('enable=1')).toThrow('timeline');expect(()=>parseChromashiftOptions('cbh=256')).toThrow('-255 to 255');expect(()=>parseChromashiftOptions('rh=1')).toThrow('Unsupported chromashift option');
 expect(()=>compileVideoFilterChain('chromashift=enable=1')).toThrow('timeline');expect(()=>createFrameActors('chromashift=enable=1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
});
it('copies luma and shifts chroma with smear clamping and C-remainder wrap into owned tight planes',()=>{
 const input=yuv('yuv444p',3,2,2),before=input.planes.map(plane=>[...plane]),smear=frame(input,'cbh=1:crv=-1');
 expect([...smear.planes[0]!]).toEqual([0,1,2,5,6,7]);expect([...smear.planes[1]!]).toEqual([64,64,65,69,69,70]);expect([...smear.planes[2]!]).toEqual([133,134,135,133,134,135]);
 const wrap=frame(input,'cbh=1:cbv=0:crh=-4:crv=3:edge=wrap');expect([...wrap.planes[1]!]).toEqual([66,64,65,71,69,70]);expect([...wrap.planes[2]!]).toEqual([134,135,133,129,130,128]);
 const far=frame(input,'cbh=255:cbv=-255:crh=-255:crv=255:edge=wrap');expect([...far.planes[1]!]).toEqual([69,70,71,64,65,66]);expect([...far.planes[2]!]).toEqual([133,134,135,128,129,130]);
 expect(wrap.linesizes).toEqual([3,3,3]);expect(wrap.pts).toEqual(input.pts);expect(wrap.pts).not.toBe(input.pts);expect(wrap.metadata).toEqual({colorRange:1});expect(wrap.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);
 expect(input.planes.map(plane=>[...plane])).toEqual(before);
 const sub=frame(yuv('yuv420p',5,3),'cbv=1:crh=1:edge=wrap');expect(sub.planes.map(plane=>plane.length)).toEqual([15,6,6]);expect([...sub.planes[1]!]).toEqual([67,68,69,64,65,66]);expect([...sub.planes[2]!]).toEqual([130,128,129,133,131,132]);
 const s422=frame(yuv('yuv422p',4,2),'crv=-1');expect([...s422.planes[2]!]).toEqual([130,131,130,131]);
 expect([...frame(yuv('yuv420p',1,1),'cbh=-3:crv=2:edge=wrap').planes.map(plane=>plane[0])]).toEqual([0,64,128]);
});
it('rejects yuva420p and unsupported layouts, budgets, malformed storage, settings and cancellation explicitly',()=>{
 expect(chromashiftOperator.formats!(parseChromashiftOptions(null))).toEqual(['yuv420p','yuv422p','yuv444p','yuva420p']);
 expect(()=>frame(yuv('yuva420p',2,2),null)).toThrow('yuva420p is not implemented');expect(()=>chromashiftOperator.validate!('yuva420p',parseChromashiftOptions(null))).toThrow(VideoChromashiftError);
 for(const pixelFormat of ['gray','nv12','rgb24','gbrp','pal8'])expect(()=>frame({...yuv('yuv444p',2,2),pixelFormat},null),pixelFormat).toThrow('not supported');
 expect(()=>frame(yuv('yuv420p',3,2),null,9)).toThrow('allocation limit');expect(()=>frame(yuv('yuv420p',3,2,1),null,13)).toThrow('storage exceeds');expect(frame(yuv('yuv420p',3,2),null,10).planes[0]!.length).toBe(6);
 const bad=yuv('yuv420p',3,2);expect(()=>frame({...bad,linesizes:[2,2,2]},null)).toThrow('stride or storage');expect(()=>frame({...bad,planes:[bad.planes[0]!.subarray(1),...bad.planes.slice(1)]},null)).toThrow('stride or storage');expect(()=>frame({...bad,linesizes:[3,2.5,2]},null)).toThrow('stride or storage');expect(()=>frame({...bad,planes:bad.planes.slice(0,2)},null)).toThrow('plane count');
 expect(()=>frame({...bad,width:0},null)).toThrow();expect(()=>frame({...bad,pts:{value:0n,timeBase:{num:1n,den:0n}}},null)).toThrow('time base');
 for(const step of [{cbh:256},{crv:0.5},{edge:2}])expect(()=>chromashiftOperator.frame!(bad,{...parseChromashiftOptions(null),...step} as ChromashiftStep,{maxFrameBytes:64})).toThrow('Invalid chromashift settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>frame(bad,null,64,controller.signal)).toThrow('stop');
});
it('negotiates its yuv formats and refuses yuva420p on the linear, graph and timed planners before output',()=>{
 const plan=compileVideoFilterChain('chromashift=1,hflip').plan('gray',5,3);expect(plan.stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv444p'],['chromashift','yuv444p'],['hflip','yuv444p']]);
 expect(compileVideoFilterChain('chromashift').plan('rgb24',5,3).stages[0]!.pixelFormat).toBe('yuv444p');expect(compileVideoFilterChain('chromashift').plan('nv12',5,3).stages[0]!.pixelFormat).toBe('yuv420p');
 for(const description of ['chromashift','format=yuva420p,chromashift'])expect(()=>compileVideoFilterChain(description).plan('yuva420p',5,3),description).toThrow('yuva420p is not implemented');
 expect(()=>compileVideoFilterChain('chromashift').plan('rgba',5,3)).toThrow('yuva420p is not implemented');
 expect(()=>compileVideoFilterGraph('[0:v]chromashift[out]').plan({format:'yuva420p',width:5,height:3},[null])).toThrow('yuva420p is not implemented');
 expect(()=>planTimedVideoGraph('chromashift',[{geometry:{format:'yuva420p',width:5,height:3},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}],[null])).toThrow('yuva420p is not implemented');
});
