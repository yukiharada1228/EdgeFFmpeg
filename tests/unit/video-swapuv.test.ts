import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,parseFilterTopology,resolveVideoFilter as resolveTimed} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {swapuvOperator,swapuvVideoFrame,VideoSwapuvError} from '../../packages/avfilter/src/video-ops/swapuv.js';
import {resolveVideoFilter as resolveScoped} from '../../packages/avfilter/src/video-graph-resolver.js';
const yuv=(pixelFormat:string,planes:number[][],linesizes:number[],width=2,height=2):VideoFrameData=>({width,height,pixelFormat,planes:planes.map(plane=>Uint8Array.from(plane)),linesizes,pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
it('parses bare swapuv and refuses every option, enable= and runtime commands before planning',()=>{
 expect(swapuvOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(swapuvOperator.timeline).toBeUndefined();expect(swapuvOperator.geometryCommands).toBeUndefined();
 // Native is_planar_yuv() over every AVPixelFormat of the pinned build.
 expect(swapuvOperator.formats!({name:'swapuv'})).toEqual('yuv420p yuv422p yuv444p yuv410p yuv411p yuvj420p yuvj422p yuvj444p yuv440p yuvj440p yuva420p yuv420p16le yuv420p16be yuv422p16le yuv422p16be yuv444p16le yuv444p16be yuv420p9be yuv420p9le yuv420p10be yuv420p10le yuv422p10be yuv422p10le yuv444p9be yuv444p9le yuv444p10be yuv444p10le yuv422p9be yuv422p9le yuva422p yuva444p yuva420p9be yuva420p9le yuva422p9be yuva422p9le yuva444p9be yuva444p9le yuva420p10be yuva420p10le yuva422p10be yuva422p10le yuva444p10be yuva444p10le yuva420p16be yuva420p16le yuva422p16be yuva422p16le yuva444p16be yuva444p16le yuv420p12be yuv420p12le yuv420p14be yuv420p14le yuv422p12be yuv422p12le yuv422p14be yuv422p14le yuv444p12be yuv444p12le yuv444p14be yuv444p14le yuvj411p yuv440p10le yuv440p10be yuv440p12le yuv440p12be yuva422p12be yuva422p12le yuva444p12be yuva444p12le'.split(' '));
 expect(parseFilterTopology('[0:v]swapuv[o]',resolveScoped).nodes[0]!.configuration).toEqual({name:'swapuv'});expect(parseFilterTopology('[0:v]swapuv[o]',resolveTimed).nodes[0]!.configuration).toEqual({name:'swapuv'});
 expect(()=>compileVideoFilterChain('swapuv=1')).toThrow();
 for(const description of ['swapuv=enable=1','swapuv=enable=gte(t\\,1)','swapuv=foo=1','swapuv=threads=1'])expect(()=>compileVideoFilterChain(description),description).toThrow('Timeline and reflection options are not implemented');
 for(const description of ['[0:v]swapuv=enable=1[o]','[0:v]swapuv=threads=2[o]'])expect(()=>compileVideoFilterGraph(description),description).toThrow('Timeline and reflection options are not implemented');
 for(const description of ['[0:v]swapuv=enable=1[o]'])expect(()=>parseFilterTopology(description,resolveTimed),description).toThrow('Timeline and reflection options are not implemented');
});
it('swaps chroma into owned tight planes from padded input without mutating it',()=>{
 const frame=yuv('yuv420p',[[1,2,99,3,4,99],[5,98],[6,97]],[3,2,2]),before=frame.planes.map(plane=>[...plane]),actual=swapuvVideoFrame(frame,{maxFrameBytes:10});
 expect(actual.planes.map(plane=>[...plane])).toEqual([[1,2,3,4],[6],[5]]);expect(actual.linesizes).toEqual([2,1,1]);expect(actual.pixelFormat).toBe('yuv420p');
 expect(actual.pts).toEqual(frame.pts);expect(actual.pts).not.toBe(frame.pts);expect(actual.metadata).toEqual({colorRange:2});expect(actual.metadata).not.toBe(frame.metadata);
 expect(frame.planes.map(plane=>[...plane])).toEqual(before);for(const plane of actual.planes)for(const input of frame.planes)expect(plane.buffer).not.toBe(input.buffer);
 const alpha=swapuvVideoFrame(yuv('yuva420p',[[1],[2],[3],[4]],[1,1,1,1],1,1),{maxFrameBytes:4});expect(alpha.planes.map(plane=>plane[0])).toEqual([1,3,2,4]);
 const wide=swapuvVideoFrame(yuv('yuv422p',[[1,2,3,4,5,6],[7,8,9,10],[11,12,13,14]],[3,2,2],3,2),{maxFrameBytes:14});expect(wide.planes.map(plane=>[...plane])).toEqual([[1,2,3,4,5,6],[11,12,13,14],[7,8,9,10]]);
 expect(swapuvVideoFrame({...frame,pts:null},{maxFrameBytes:10}).pts).toBeNull();
});
it('plans swapuv with native auto-conversion and runs it on the linear chain',()=>{
 const plan=compileVideoFilterChain('swapuv,hflip').plan('yuv444p',2,1);expect(plan.stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['swapuv','yuv444p'],['hflip','yuv444p']]);expect(plan.stateBytes).toBe(0);
 const output=plan.apply(yuv('yuv444p',[[1,2],[3,4],[5,6]],[2,2,2],2,1),{maxFrameBytes:6,maxStateBytes:0});expect(output.planes.map(plane=>[...plane])).toEqual([[2,1],[6,5],[4,3]]);
 // Native negotiation for these sources is proven in tests/differential/video-swapuv.test.ts: gray and packed RGB with alpha
 // convert into yuvj444p and yuva444p, which have no frame storage here and are refused at plan time.
 for(const [source,format]of [['nv12','yuv420p'],['gbrp','yuv444p'],['rgb24','yuv444p']] as const)expect(compileVideoFilterChain('swapuv').plan(source,4,4).stages.find(stage=>stage.operation==='swapuv')!.pixelFormat,source).toBe(format);
 for(const [source,format]of [['gray','yuvj444p'],['rgba','yuva444p']] as const)expect(()=>compileVideoFilterChain('swapuv').plan(source,4,4),source).toThrow(`Video filter swapuv input negotiates ${format}, which is not implemented`);
});
it('rejects unsupported layouts, budgets, malformed storage and cancellation explicitly',()=>{
 const ok=()=>yuv('yuv420p',[[1,2,3,4],[5],[6]],[2,1,1]);
 for(const pixelFormat of ['gray','nv12','rgba','gbrp','yuv410p'])expect(()=>swapuvVideoFrame({...ok(),pixelFormat},{maxFrameBytes:64}),pixelFormat).toThrow('pixel format is not supported');
 expect(()=>swapuvVideoFrame(ok(),{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>swapuvVideoFrame(ok(),{maxFrameBytes:0})).toThrow('allocation limit');expect(()=>swapuvVideoFrame(ok(),{maxFrameBytes:1.5})).toThrow('allocation limit');
 expect(()=>swapuvVideoFrame(yuv('yuv420p',[[1,2,0,3,4],[5],[6]],[3,1,1]),{maxFrameBytes:6})).toThrow('storage exceeds');
 expect(()=>swapuvVideoFrame({...ok(),planes:ok().planes.slice(0,2)},{maxFrameBytes:64})).toThrow('plane count');expect(()=>swapuvVideoFrame({...ok(),linesizes:[2,1]},{maxFrameBytes:64})).toThrow('plane count');
 for(const linesizes of [[1,1,1],[2,0,1],[2,1,-1],[2.5,1,1],[2,1,Number.NaN]])expect(()=>swapuvVideoFrame({...ok(),linesizes},{maxFrameBytes:64}),String(linesizes)).toThrow('stride or storage');
 expect(()=>swapuvVideoFrame(yuv('yuv420p',[[1,2,3],[5],[6]],[2,1,1]),{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>swapuvVideoFrame({...ok(),planes:[new Uint8Array(4),[5] as never,new Uint8Array(1)]},{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>swapuvVideoFrame({...ok(),pts:{value:0n,timeBase:{num:0n,den:1n}}},{maxFrameBytes:64})).toThrow('time base');expect(()=>swapuvVideoFrame(ok(),{maxFrameBytes:5})).toThrow(VideoSwapuvError);
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>swapuvVideoFrame(ok(),{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 const plan=compileVideoFilterChain('swapuv').plan('yuv420p',2,2);expect(()=>plan.apply(ok(),{maxFrameBytes:5,maxStateBytes:0})).toThrow();
});
