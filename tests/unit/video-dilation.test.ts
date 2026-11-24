import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator,VideoFilterError} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {dilateVideoFrame,parseDilationOptions,dilationPixelFormats,dilationOperator,VideoDilationError} from '../../packages/avfilter/src/video-ops/dilation.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
it('parses declared defaults, shorthand order, integer expressions and ranges into frozen settings',()=>{
 expect(parseDilationOptions(null)).toEqual({name:'dilation',coordinates:255,thresholds:[65535,65535,65535,65535]});expect(Object.isFrozen(parseDilationOptions(''))).toBe(true);expect(Object.isFrozen(parseDilationOptions('').thresholds)).toBe(true);
 expect(parseDilationOptions('15:0:1:2:3')).toEqual({name:'dilation',coordinates:15,thresholds:[0,1,2,3]});expect(parseDilationOptions('coordinates=0:threshold3=65535:threshold1=7').thresholds).toEqual([65535,7,65535,65535]);
 expect(parseDilationOptions('coordinates=max').coordinates).toBe(255);expect(parseDilationOptions('threshold0=min').thresholds[0]).toBe(0);expect(parseDilationOptions('threshold0=2.5').thresholds[0]).toBe(2);expect(parseDilationOptions('threshold0=3.5').thresholds[0]).toBe(4);expect(parseDilationOptions('coordinates=1+2').coordinates).toBe(3);
 expect(videoOperator('dilation')).toBe(dilationOperator);expect(dilationOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(dilationPixelFormats).toEqual(['yuv420p','yuv422p','yuv444p','gray','yuva420p','gbrp']);
 for(const options of ['coordinates=256','coordinates=-1','threshold0=65536','threshold2=-1','coordinates=','coordinates=abc','enable=1','threads=1','foo=1','1:2:3:4:5:6','threshold4=1','coordinates=1/0'])expect(()=>parseDilationOptions(options),options).toThrow();
 expect(()=>parseDilationOptions('enable=gt(t,1)')).toThrow('timeline');expect(()=>parseDilationOptions('coordinates=256')).toThrow('Invalid dilation coordinates');
});
it('applies the native border reflection, coordinate mask and threshold limit on padded input without mutating it',()=>{
 // 3x3 with stride 4; padding bytes 99 must never be read.
 const input=Uint8Array.of(1,2,3,99,4,50,6,99,7,8,9,99),frame=gray(input,3,3,4),actual=dilateVideoFrame(frame,parseDilationOptions(null),{maxFrameBytes:12});
 expect([...actual.planes[0]!]).toEqual([50,50,50,50,50,50,50,50,50]);expect(actual.linesizes).toEqual([3]);expect(actual.pts).toEqual(frame.pts);expect(actual.pts).not.toBe(frame.pts);expect(actual.metadata).toEqual({colorRange:2});expect([...input]).toEqual([1,2,3,99,4,50,6,99,7,8,9,99]);
 expect([...dilateVideoFrame(frame,parseDilationOptions('threshold0=10'),{maxFrameBytes:12}).planes[0]!]).toEqual([11,12,13,14,50,16,17,18,19]);
 // Only the right neighbour (bit 4): the last column reflects to width-2.
 expect([...dilateVideoFrame(frame,parseDilationOptions('16'),{maxFrameBytes:12}).planes[0]!]).toEqual([2,3,3,50,50,50,8,9,9]);
 // Only the left neighbour (bit 3): the first column reflects to column 1.
 expect([...dilateVideoFrame(frame,parseDilationOptions('8'),{maxFrameBytes:12}).planes[0]!]).toEqual([2,2,3,50,50,50,8,8,9]);
 // Only the bottom neighbour (bit 6): the last row clamps to itself.
 expect([...dilateVideoFrame(frame,parseDilationOptions('64'),{maxFrameBytes:12}).planes[0]!]).toEqual([4,50,6,7,50,9,7,8,9]);
 const copy=dilateVideoFrame(frame,parseDilationOptions('threshold0=0'),{maxFrameBytes:12});expect([...copy.planes[0]!]).toEqual([1,2,3,4,50,6,7,8,9]);expect(copy.planes[0]!.buffer).not.toBe(input.buffer);
 expect([...dilateVideoFrame(gray(Uint8Array.of(250,10,0,255),2,2),parseDilationOptions(null),{maxFrameBytes:4}).planes[0]!]).toEqual([255,255,255,255]);
 const yuva=dilateVideoFrame({width:4,height:1,pixelFormat:'yuva420p',planes:[Uint8Array.of(1,9,2,3),Uint8Array.of(2,5),Uint8Array.of(3,1),Uint8Array.of(4,8,0,1)],linesizes:[4,2,2,4],pts:null,metadata:{}},parseDilationOptions('threshold3=2'),{maxFrameBytes:64});
 expect(yuva.planes.map(plane=>[...plane])).toEqual([[9,9,9,3],[5,5],[3,3],[6,8,2,1]]);expect(yuva.pts).toBeNull();
});
it('refuses unsupported layouts, width-1 planes, budgets, malformed storage, settings and cancellation explicitly',()=>{
 const settings=parseDilationOptions(null);
 for(const pixelFormat of ['nv12','nv21','rgb24','rgba','pal8'])expect(()=>dilateVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},settings,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>dilateVideoFrame(gray(new Uint8Array(3),1,3),settings,{maxFrameBytes:64})).toThrow('narrower than 2');
 expect(()=>dilateVideoFrame({width:2,height:2,pixelFormat:'yuv420p',planes:[new Uint8Array(4),new Uint8Array(1),new Uint8Array(1)],linesizes:[2,1,1],pts:null,metadata:{}},settings,{maxFrameBytes:64})).toThrow('narrower than 2');
 expect(()=>dilateVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>dilateVideoFrame(gray(new Uint8Array(8),3,2,4),settings,{maxFrameBytes:7})).toThrow('storage exceeds');
 expect(()=>dilateVideoFrame(gray(new Uint8Array(5),3,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>dilateVideoFrame(gray(new Uint8Array(6),3,2,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>dilateVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},settings,{maxFrameBytes:64})).toThrow('plane count');
 expect(()=>dilateVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},settings,{maxFrameBytes:64})).toThrow('time base');
 expect(()=>dilateVideoFrame(gray(new Uint8Array(6),3,2),{...settings,coordinates:256},{maxFrameBytes:64})).toThrow('Invalid dilation settings');expect(()=>dilateVideoFrame(gray(new Uint8Array(6),3,2),{...settings,thresholds:[1,2,3,0.5]},{maxFrameBytes:64})).toThrow(VideoDilationError);
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>dilateVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans dilation as a size-preserving stage and refuses width-1 planes on the linear, graph and actor planners',()=>{
 const plan=compileVideoFilterChain('dilation,hflip,dilation=0').plan('gray',5,3);expect(plan.stages.map(stage=>stage.operation)).toEqual(['dilation','hflip','dilation']);expect(plan.stateBytes).toBe(0);expect(plan.pixelFormat).toBe('gray');
 const frame=gray(Uint8Array.from({length:15},(_,i)=>i),5,3),output=plan.apply(frame,{maxFrameBytes:15,maxStateBytes:0});expect([...output.planes[0]!]).toEqual([9,9,8,7,6,14,14,13,12,11,14,14,13,12,11]);expect(()=>plan.apply(frame,{maxFrameBytes:14,maxStateBytes:0})).toThrow('budget');
 expect(compileVideoFilterChain('dilation').plan('nv12',5,3).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv420p'],['dilation','yuv420p']]);
 for(const [format,width]of [['gray',1],['yuv420p',2],['yuv422p',1],['yuva420p',2]] as const){expect(()=>compileVideoFilterChain('dilation').plan(format,width,3),format).toThrow(VideoFilterError);expect(()=>compileVideoFilterGraph('[0:v]dilation[out]').plan({format,width,height:3},[null]),format).toThrow('narrower than 2');}
 expect(compileVideoFilterChain('dilation').plan('yuv444p',2,1).pixelFormat).toBe('yuv444p');
 expect(()=>compileVideoFilterChain('dilation=enable=1')).toThrow();expect(()=>createFrameActors('dilation=enable=1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow();
 const actors=(width:number)=>createFrameActors('dilation',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64,maxFrameBytes:64,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry:{format:'gray',width,height:3}}]});
 const live=actors(2);try{for(const [command,argument,code]of [['threshold0','5',-38],['coordinates','1',-38],['w','4',-38],['enable','0',-1163346256]] as const)expect(live.sendFilterCommand('dilation',command,argument).code,command).toBe(code);}finally{live.dispose();}expect(()=>actors(1)).toThrow('narrower than 2');
});
