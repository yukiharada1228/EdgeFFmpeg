import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {avgblurVideoFrame,parseAvgblurOptions,avgblurPixelFormats,avgblurRadii,avgblurOperator,VideoAvgblurError} from '../../packages/avfilter/src/video-ops/avgblur.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
it('parses declared defaults, shorthand order, integer expressions and ranges into frozen settings',()=>{
 expect(parseAvgblurOptions(null)).toEqual({name:'avgblur',sizeX:1,planes:15,sizeY:0});expect(Object.isFrozen(parseAvgblurOptions(''))).toBe(true);
 expect(parseAvgblurOptions('3:5:7')).toEqual({name:'avgblur',sizeX:3,planes:5,sizeY:7});expect(parseAvgblurOptions('sizeY=2:sizeX=4')).toEqual({name:'avgblur',sizeX:4,planes:15,sizeY:2});
 expect(parseAvgblurOptions('sizeX=max').sizeX).toBe(1024);expect(parseAvgblurOptions('planes=min').planes).toBe(0);expect(parseAvgblurOptions('planes=0xa').planes).toBe(10);expect(parseAvgblurOptions('sizeX=2.5').sizeX).toBe(2);expect(parseAvgblurOptions('sizeX=3.5').sizeX).toBe(4);expect(parseAvgblurOptions('sizeX=1+2').sizeX).toBe(3);
 expect(videoOperator('avgblur')).toBe(avgblurOperator);expect(avgblurOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
 // The pinned vf_avgblur.c pix_fmts in declared order.
 expect(avgblurPixelFormats).toHaveLength(57);expect(avgblurPixelFormats.slice(0,9)).toEqual(['yuva444p','yuv444p','yuv440p','yuvj444p','yuvj440p','yuva422p','yuv422p','yuva420p','yuv420p']);expect(avgblurPixelFormats.slice(-6)).toEqual(['gray','gray9le','gray10le','gray12le','gray14le','gray16le']);
 for(const options of ['sizeX=0','sizeX=1025','planes=16','planes=-1','sizeY=-1','sizeY=1025','sizeX=','sizeX=abc','enable=1','threads=1','sizex=2','foo=1','1:2:3:4','sizeX=1/0'])expect(()=>parseAvgblurOptions(options),options).toThrow();
 expect(()=>parseAvgblurOptions('enable=gt(t,1)')).toThrow('timeline');expect(()=>parseAvgblurOptions('sizeX=0')).toThrow('Invalid avgblur sizeX');expect(()=>parseAvgblurOptions('radius=1')).toThrow('Unsupported avgblur option');
});
it('resolves sizeY 0 to sizeX and clips both radii to half of plane 1 for every plane as config_input does',()=>{
 expect(avgblurRadii(parseAvgblurOptions('5'),'gray',17,9)).toEqual({radius:5,radiusV:4});expect(avgblurRadii(parseAvgblurOptions('64:15:2'),'gray',17,9)).toEqual({radius:8,radiusV:2});
 expect(avgblurRadii(parseAvgblurOptions('5'),'yuv420p',17,9)).toEqual({radius:4,radiusV:2});expect(avgblurRadii(parseAvgblurOptions('5'),'yuv422p',2,9)).toEqual({radius:0,radiusV:4});
 expect(avgblurRadii(parseAvgblurOptions('5'),'gbrp',3,1)).toEqual({radius:1,radiusV:0});expect(avgblurRadii(parseAvgblurOptions(null),'yuv420p',1,1)).toEqual({radius:0,radiusV:0});
});
it('applies the clamped running sums and truncating division on padded input without mutating it',()=>{
 // 3x3 with stride 4; padding bytes 99 must never be read. Radius 1 both ways, area 9, edges replicated.
 const input=Uint8Array.of(0,9,18,99,27,36,45,99,54,63,72,99),frame=gray(input,3,3,4),actual=avgblurVideoFrame(frame,parseAvgblurOptions(null),{maxFrameBytes:12});
 expect([...actual.planes[0]!]).toEqual([12,18,24,30,36,42,48,54,60]);
 expect(actual.linesizes).toEqual([3]);expect(actual.pts).toEqual(frame.pts);expect(actual.pts).not.toBe(frame.pts);expect(actual.metadata).toEqual({colorRange:2});expect([...input]).toEqual([0,9,18,99,27,36,45,99,54,63,72,99]);
 // Horizontal only (sizeY larger than half the height is clipped to 0 for a height-1 frame).
 expect([...avgblurVideoFrame(gray(Uint8Array.of(0,3,7,255),4,1),parseAvgblurOptions('1:15:5'),{maxFrameBytes:4}).planes[0]!]).toEqual([1,3,88,172]);
 const copy=avgblurVideoFrame(frame,parseAvgblurOptions('planes=0'),{maxFrameBytes:12});expect([...copy.planes[0]!]).toEqual([0,9,18,27,36,45,54,63,72]);expect(copy.planes[0]!.buffer).not.toBe(input.buffer);
 // planes=5 blurs Y and V, copies U and A.
 const yuva=avgblurVideoFrame({width:4,height:1,pixelFormat:'yuva420p',planes:[Uint8Array.of(0,30,60,90),Uint8Array.of(2,5),Uint8Array.of(3,1),Uint8Array.of(4,8,0,1)],linesizes:[4,2,2,4],pts:null,metadata:{}},parseAvgblurOptions('planes=5'),{maxFrameBytes:64});
 expect(yuva.planes.map(plane=>[...plane])).toEqual([[10,30,60,80],[2,5],[2,1],[4,8,0,1]]);expect(yuva.pts).toBeNull();
});
it('refuses unsupported layouts, budgets, malformed storage, settings and cancellation explicitly',()=>{
 const settings=parseAvgblurOptions(null);
 for(const pixelFormat of ['nv12','nv21','rgb24','rgba','pal8'])expect(()=>avgblurVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},settings,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>avgblurVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>avgblurVideoFrame(gray(new Uint8Array(8),3,2,4),settings,{maxFrameBytes:7})).toThrow('storage exceeds');
 expect(()=>avgblurVideoFrame(gray(new Uint8Array(5),3,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>avgblurVideoFrame(gray(new Uint8Array(6),3,2,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>avgblurVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},settings,{maxFrameBytes:64})).toThrow('plane count');
 expect(()=>avgblurVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},settings,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{sizeX:0},{sizeX:1025},{sizeY:-1},{planes:16},{sizeX:1.5}])expect(()=>avgblurVideoFrame(gray(new Uint8Array(6),3,2),{...settings,...bad},{maxFrameBytes:64}),JSON.stringify(bad)).toThrow(VideoAvgblurError);
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>avgblurVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans avgblur as a size-preserving stage and refuses gbrap picks, enable= and runtime commands',()=>{
 const plan=compileVideoFilterChain('avgblur,hflip,avgblur=planes=0').plan('gray',5,3);expect(plan.stages.map(stage=>stage.operation)).toEqual(['avgblur','hflip','avgblur']);expect(plan.stateBytes).toBe(0);expect(plan.pixelFormat).toBe('gray');
 const frame=gray(Uint8Array.from({length:15},(_,i)=>i*10),5,3),output=plan.apply(frame,{maxFrameBytes:15,maxStateBytes:0});expect(output.planes[0]!).toHaveLength(15);expect(()=>plan.apply(frame,{maxFrameBytes:14,maxStateBytes:0})).toThrow('budget');
 expect(compileVideoFilterChain('avgblur').plan('nv12',5,3).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv420p'],['avgblur','yuv420p']]);
 for(const source of ['rgba','abgr'])expect(()=>compileVideoFilterChain('avgblur').plan(source,5,3),source).toThrow('Video filter avgblur input negotiates gbrap, which is not implemented');
 for(const [format,width]of [['gray',1],['yuv420p',1],['yuv420p',2],['yuv422p',1],['yuva420p',2]] as const){expect(compileVideoFilterChain('avgblur=64').plan(format,width,3).pixelFormat).toBe(format);expect(()=>compileVideoFilterGraph('[0:v]avgblur=5[out]').plan({format,width,height:3},[null])).not.toThrow();}
 expect(()=>compileVideoFilterChain('avgblur=enable=1')).toThrow();expect(()=>createFrameActors('avgblur=enable=1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow();
 const live=createFrameActors('avgblur',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64,maxFrameBytes:64,arithmetic:'scalar',numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry:{format:'gray',width:2,height:3}}]});
 try{for(const [command,argument,code]of [['sizeX','5',-38],['planes','1',-38],['sizeY','2',-38],['w','4',-38],['enable','0',-1163346256]] as const)expect(live.sendFilterCommand('avgblur',command,argument).code,command).toBe(code);}finally{live.dispose();}
});
