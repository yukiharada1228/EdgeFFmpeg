import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {epxVideoFrame,epxGeometry,parseEpxOptions,epxPixelFormats,VideoEpxError} from '../../packages/avfilter/src/video-epx.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
const rgba=(data:Uint8Array,width:number,height:number,stride=width*4,pixelFormat='rgba'):VideoFrameData=>({width,height,pixelFormat,planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const words=(frame:VideoFrameData)=>Array.from({length:frame.width*frame.height},(_,i)=>frame.planes[0]![i*4]!);
it('parses n=2|3 with the native default and shorthand, and refuses other values, enable= and unknown options',()=>{
 expect(parseEpxOptions(null)).toEqual({n:3});expect(parseEpxOptions('')).toEqual({n:3});expect(Object.isFrozen(parseEpxOptions('2'))).toBe(true);
 expect(parseEpxOptions('2').n).toBe(2);expect(parseEpxOptions('n=2').n).toBe(2);expect(parseEpxOptions('n=3').n).toBe(3);expect(parseEpxOptions('n=2:n=3').n).toBe(3);expect(parseEpxOptions('n=+02').n).toBe(2);
 for(const options of ['n=1','n=4','n=0','n=-2','n=','n=2.0','n=0x2','n=1+1','n=two','enable=1','threads=1','foo=1','n=2:enable=t'])expect(()=>parseEpxOptions(options),options).toThrow(VideoEpxError);
 expect(()=>parseEpxOptions('2:3')).toThrow('Missing filter option name');expect(()=>parseEpxOptions('enable=1')).toThrow('timeline');expect(()=>parseEpxOptions('n=4')).toThrow('must be 2 or 3');
 for(const description of ['epx=n=4','epx=enable=1','epx=foo=1'])expect(()=>compileVideoFilterChain(description),description).toThrow();
 const op=videoOperator('epx')!;expect(op.paths).toEqual(['linear','graph','stream','actor','timed']);expect(op.formats!({name:'epx',n:3} as never)).toEqual(['argb','rgba','abgr','bgra']);expect(op.timeline).toBeUndefined();expect(op.geometryCommands).toBeUndefined();
 expect(epxPixelFormats).toEqual(['rgba','bgra','argb','abgr']);expect(Object.isFrozen(epxPixelFormats)).toBe(true);
});
it('applies epx2 and epx3 neighbour rules with edge clamping into owned tight planes',()=>{
 // A 2x2 diagonal: top-left and bottom-right are colour 1, the others colour 2.
 const input=Uint8Array.of(1,0,0,0,2,0,0,0,99,99,2,0,0,0,1,0,0,0,99,99),frame=rgba(input,2,2,10),two=epxVideoFrame(frame,{n:2},{maxFrameBytes:64});
 expect([two.width,two.height,two.linesizes[0]]).toEqual([4,4,16]);expect(words(two)).toEqual([1,1,2,2,1,2,1,2,2,1,2,1,2,2,1,1]);
 const three=epxVideoFrame(frame,{n:3},{maxFrameBytes:144});expect([three.width,three.height,three.linesizes[0]]).toEqual([6,6,24]);expect(words(three)).toEqual([1,1,1,2,2,2,1,1,2,1,2,2,1,2,2,1,1,2,2,1,1,2,2,1,2,2,1,2,1,1,2,2,2,1,1,1]);
 // Noise without equal neighbours is plain replication; 1x1 always is.
 const noise=epxVideoFrame(rgba(Uint8Array.of(1,0,0,0,2,0,0,0,3,0,0,0,4,0,0,0),2,2),{n:2},{maxFrameBytes:64});expect(words(noise)).toEqual([1,1,2,2,1,1,2,2,3,3,4,4,3,3,4,4]);
 expect(words(epxVideoFrame(rgba(Uint8Array.of(7,8,9,10),1,1),{n:3},{maxFrameBytes:36}))).toEqual(Array(9).fill(7));
 expect(two.pts).toEqual(frame.pts);expect(two.pts).not.toBe(frame.pts);expect(two.metadata).toEqual({colorRange:2});expect(two.planes[0]!.buffer).not.toBe(input.buffer);expect([...input]).toEqual([1,0,0,0,2,0,0,0,99,99,2,0,0,0,1,0,0,0,99,99]);
 // Whole-word comparison: a difference only in the fourth byte counts.
 const alpha=epxVideoFrame(rgba(Uint8Array.of(1,0,0,0,1,0,0,9,1,0,0,9,1,0,0,0),2,2,8,'abgr'),{n:2},{maxFrameBytes:64});expect(alpha.pixelFormat).toBe('abgr');expect(Array.from({length:16},(_,i)=>alpha.planes[0]![i*4+3])).toEqual([0,0,9,9,0,9,0,9,9,0,9,0,9,9,0,0]);
});
it('refuses formats, budgets, malformed strides, bad time bases and cancellation explicitly',()=>{
 for(const pixelFormat of ['rgb24','gray','yuv420p','rgb0','0rgb'])expect(()=>epxGeometry(pixelFormat,2,2,{n:2}),pixelFormat).toThrow('pixel format is not supported');
 expect(epxGeometry('argb',5,4,{n:3})).toEqual({width:15,height:12});expect(()=>epxGeometry('rgba',20000,20000,{n:3})).toThrow('output size is invalid');expect(()=>epxGeometry('rgba',2,2,{n:4} as never)).toThrow('Invalid epx settings');
 const frame=rgba(new Uint8Array(24),3,2);
 expect(()=>epxVideoFrame(frame,{n:3},{maxFrameBytes:215})).toThrow('allocation limit');expect(()=>epxVideoFrame(frame,{n:2},{maxFrameBytes:95})).toThrow('allocation limit');expect(epxVideoFrame(frame,{n:2},{maxFrameBytes:96}).planes[0]!.length).toBe(96);
 expect(()=>epxVideoFrame(rgba(new Uint8Array(200),3,2,100),{n:2},{maxFrameBytes:150})).toThrow('input plane storage exceeds');
 expect(()=>epxVideoFrame(rgba(new Uint8Array(23),3,2),{n:2},{maxFrameBytes:1024})).toThrow('stride or storage');expect(()=>epxVideoFrame(rgba(new Uint8Array(24),3,2,8),{n:2},{maxFrameBytes:1024})).toThrow('stride or storage');expect(()=>epxVideoFrame(rgba(new Uint8Array(24),3,2,12.5),{n:2},{maxFrameBytes:1024})).toThrow('stride or storage');
 expect(()=>epxVideoFrame({...frame,planes:[new Uint8Array(24),new Uint8Array(1)],linesizes:[12,1]},{n:2},{maxFrameBytes:1024})).toThrow('plane count');
 expect(()=>epxVideoFrame({...frame,pts:{value:0n,timeBase:{num:0n,den:1n}}},{n:2},{maxFrameBytes:1024})).toThrow('time base');expect(()=>epxVideoFrame({...frame,pixelFormat:'rgb24'},{n:2},{maxFrameBytes:1024})).toThrow('not supported');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>epxVideoFrame(frame,{n:2},{maxFrameBytes:1024,signal:controller.signal})).toThrow('stop');
});
it('plans n-times geometry on every path, keeps the timed sample aspect ratio and bounds the scaled output',()=>{
 const plan=compileVideoFilterChain('epx,epx=2').plan('rgba',3,2);expect(plan.stages.map(stage=>[stage.operation,stage.width,stage.height,stage.pixelFormat])).toEqual([['epx',9,6,'rgba'],['epx',18,12,'rgba']]);
 const frame=rgba(Uint8Array.from({length:24},(_,i)=>i),3,2);expect(plan.apply(frame,{maxFrameBytes:864,maxStateBytes:0}).width).toBe(18);expect(()=>plan.apply(frame,{maxFrameBytes:863,maxStateBytes:0})).toThrow();
 expect(compileVideoFilterChain('epx').plan('gray',3,2).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','argb'],['epx','argb']]);expect(compileVideoFilterChain('epx').plan('gray',3,2,{outputPixelFormat:'gray'}).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','argb'],['epx','argb'],['scale','gray']]);
 const graph=compileVideoFilterGraph('[0:v]epx=n=2[o]').plan({format:'bgra',width:5,height:4},[null]);expect(graph.negotiated.nodes[0]!.outputs[0]).toMatchObject({format:'bgra',width:10,height:8});
 const timed=planTimedVideoGraph('epx',[{geometry:{format:'abgr',width:5,height:4,sampleAspectRatio:{num:3n,den:2n}},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}],[null]);
 expect(timed.nodes[0]!.outputs[0]).toMatchObject({format:'abgr',width:15,height:12,sampleAspectRatio:{num:3n,den:2n}});
 expect(()=>createFrameActors('epx=n=4',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow();
});
