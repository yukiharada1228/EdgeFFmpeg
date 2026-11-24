import {expect,it} from 'vitest';
import {negateVideoFrame,parseNegateOptions,negatePixelFormats,VideoNegateError,compileVideoFilterChain,compileVideoFilterGraph} from '@edge-ffmpeg/avfilter';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoStoreFactory} from '@edge-ffmpeg/avformat';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
it('parses declared defaults, shorthand, flag folding and boolean narrowing into frozen settings',()=>{
 expect(parseNegateOptions(null)).toEqual({components:0x77,negateAlpha:false});expect(Object.isFrozen(parseNegateOptions(''))).toBe(true);
 expect(parseNegateOptions('y+u:1')).toEqual({components:0x30,negateAlpha:true});expect(parseNegateOptions('components=y:components=+a:components=-y')).toEqual({components:0x08,negateAlpha:false});
 expect(parseNegateOptions('components=all').components).toBe(-1);expect(parseNegateOptions('components=all-y').components).toBe(-17);expect(parseNegateOptions('components=-all').components).toBe(0);expect(parseNegateOptions('components=0XfF').components).toBe(255);expect(parseNegateOptions('components=4294967295').components).toBe(-1);
 expect(parseNegateOptions('negate_alpha=4294967297').negateAlpha).toBe(true);expect(parseNegateOptions('negate_alpha=').negateAlpha).toBe(false);
 for(const options of ['components=','components=y+','components=Y','components=4294967296','components=+4294967296','components=y*2','components=1e1','negate_alpha=2','negate_alpha=auto','enable=1','threads=1','foo=1','y:1:2','components=y:1',`components=${'y+'.repeat(128)}y`])expect(()=>parseNegateOptions(options),options).toThrow();
 expect(()=>parseNegateOptions('enable=1')).toThrow(VideoNegateError);expect(()=>parseNegateOptions('enable=1')).toThrow('timeline');
});
it('materializes owned tight negated planes from padded input without changing timestamps or metadata',()=>{
 const input=Uint8Array.of(0,1,2,99,10,11,12,99),frame=gray(input,3,2,4),actual=negateVideoFrame(frame,parseNegateOptions(null),{maxFrameBytes:8});
 expect([...actual.planes[0]!]).toEqual([255,254,253,245,244,243]);expect(actual.linesizes).toEqual([3]);expect(actual.pts).toEqual(frame.pts);expect(actual.pts).not.toBe(frame.pts);expect(actual.metadata).toEqual({colorRange:2});expect([...input]).toEqual([0,1,2,99,10,11,12,99]);
 const copy=negateVideoFrame(frame,parseNegateOptions('none'),{maxFrameBytes:8});expect([...copy.planes[0]!]).toEqual([0,1,2,10,11,12]);expect(copy.planes[0]!.buffer).not.toBe(input.buffer);
 const packed=negateVideoFrame({width:1,height:1,pixelFormat:'argb',planes:[Uint8Array.of(1,2,3,4)],linesizes:[4],pts:null,metadata:{}},parseNegateOptions('r+a'),{maxFrameBytes:4});expect([...packed.planes[0]!]).toEqual([254,253,3,4]);expect(packed.pts).toBeNull();
 const yuva=negateVideoFrame({width:1,height:1,pixelFormat:'yuva420p',planes:[Uint8Array.of(1),Uint8Array.of(2),Uint8Array.of(3),Uint8Array.of(4)],linesizes:[1,1,1,1],pts:null,metadata:{}},parseNegateOptions('negate_alpha=1'),{maxFrameBytes:4});expect(yuva.planes.map(plane=>plane[0])).toEqual([254,253,252,251]);
});
it('rejects unsupported layouts, unavailable components, budgets, malformed storage and cancellation explicitly',()=>{
 const settings=parseNegateOptions(null);expect(negatePixelFormats).not.toContain('nv12');expect(Object.isFrozen(negatePixelFormats)).toBe(true);
 for(const pixelFormat of ['nv12','nv21','pal8','monob','rgb0'])expect(()=>negateVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},settings,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>negateVideoFrame(gray(new Uint8Array(6),3,2),parseNegateOptions('u'),{maxFrameBytes:64})).toThrow('Requested components not available');
 expect(()=>negateVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>negateVideoFrame(gray(new Uint8Array(8),3,2,4),settings,{maxFrameBytes:7})).toThrow('storage exceeds');
 expect(()=>negateVideoFrame(gray(new Uint8Array(5),3,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>negateVideoFrame(gray(new Uint8Array(6),3,2,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>negateVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},settings,{maxFrameBytes:64})).toThrow('time base');expect(()=>negateVideoFrame(gray(new Uint8Array(6),3,2),{components:0.5,negateAlpha:false},{maxFrameBytes:64})).toThrow('Invalid negate settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>negateVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('preflights negate through linear and branch planners and rejects the timed actor executors',async()=>{
 const plan=compileVideoFilterChain('negate,hflip,negate=y').plan('gray',5,3);expect(plan.stages.map(stage=>stage.operation)).toEqual(['negate','hflip','negate']);expect(plan.stateBytes).toBe(0);expect(plan.intermediateBytes).toBe(45);
 const frame=gray(Uint8Array.from({length:15},(_,i)=>i),5,3),output=plan.apply(frame,{maxFrameBytes:15,maxStateBytes:0});expect([...output.planes[0]!]).toEqual([4,3,2,1,0,9,8,7,6,5,14,13,12,11,10]);expect(()=>plan.apply(frame,{maxFrameBytes:14,maxStateBytes:0})).toThrow('budget');
 const graph=compileVideoFilterGraph('[0:v]split[a][b];[a]negate[x];[b]null[y]').plan({format:'nv12',width:5,height:3},['nv12','gray']);expect(graph.negotiated.nodes[1]!.inputs[0]!.format).toBe('yuv420p');expect(()=>compileVideoFilterGraph('[0:v]negate=a[out]').plan({format:'rgb24',width:5,height:3},[null])).toThrow('Requested components not available');
 expect(()=>createFrameActors('negate',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('Actor operators not implemented');
 const factory:TimedVideoStoreFactory=()=>({async append(){},async read(){throw new Error('Unexpected read');},async discardBefore(){},async close(){}});let writes=0;
 const ffmpeg=new FFmpeg({filesystem:{async openRead(){return {size:6n,async readAt(){return new Uint8Array(6);}};},async openWrite(){writes++;throw new Error('Unexpected write');}},backend:createTimedVideoBackend({storage:factory,limits:{numericProfile:'darwin-arm64',maxEvents:32}}),budget:{maxResidentBytes:1<<20,maxBufferBytes:4096,maxCpuTimeMs:10000,maxPendingPackets:32}});
 const result=await ffmpeg.exec(['-y','-f','rawvideo','-pixel_format','gray','-video_size','3x2','-framerate','25','-i','/input0','-vf','negate','-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f','framecrc','/out']);expect(result.exitCode).toBe(1);expect(result.diagnostics.map(entry=>entry.message)).toEqual(['Actor operators not implemented']);expect(result.outputs).toEqual([]);expect(writes).toBe(0);
});
