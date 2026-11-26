import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {maskfunOperator,maskfunPixelFormats,maskVideoFrame,parseMaskfunOptions} from '../../packages/avfilter/src/video-ops/maskfun.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const defaults={name:'maskfun',low:10,high:10,planes:15,fill:0,sum:10};
it('parses declared defaults, shorthand, integer expressions and ranges with no cross-option check',()=>{
 expect(parseMaskfunOptions(null)).toEqual(defaults);expect(Object.isFrozen(parseMaskfunOptions(''))).toBe(true);
 expect(parseMaskfunOptions('1:2:3:4:5')).toEqual({name:'maskfun',low:1,high:2,planes:3,fill:4,sum:5});expect(parseMaskfunOptions('sum=7:fill=9:planes=5:high=200:low=20')).toEqual({name:'maskfun',low:20,high:200,planes:5,fill:9,sum:7});
 expect(parseMaskfunOptions('low=1:low=7').low).toBe(7);expect(parseMaskfunOptions('low=0x10:high=2*100').high).toBe(200);expect(parseMaskfunOptions('low=max:high=min:planes=default:fill=max:sum=min')).toEqual({name:'maskfun',low:65535,high:0,planes:15,fill:65535,sum:0});
 expect(parseMaskfunOptions('low=2.5').low).toBe(2);expect(parseMaskfunOptions('low=3.5').low).toBe(4);
 // low > high is accepted, as native init has no check.
 expect(parseMaskfunOptions('low=100:high=50')).toMatchObject({low:100,high:50});
 for(const [options,message]of [['low=-1','Invalid maskfun low'],['low=65536','Invalid maskfun low'],['high=70000','Invalid maskfun high'],['planes=16','Invalid maskfun planes'],['planes=-1','Invalid maskfun planes'],['fill=65536','Invalid maskfun fill'],['sum=-1','Invalid maskfun sum'],['low=abc','Invalid maskfun low'],['sum=','Invalid maskfun sum'],['enable=1','timeline'],['enable=between(t,0,1)','timeline'],['threads=1','Unsupported maskfun option'],['foo=1','Unsupported maskfun option'],['1:2:3:4:5:6',''],['low=1:2','']] as const)expect(()=>parseMaskfunOptions(options),options).toThrow(message);
 expect(()=>parseMaskfunOptions('planes=16')).toThrow(VideoFilterParseError);
 // The pinned vf_maskfun.c pix_fmts in declared order (no yuva422p12/yuva444p12).
 expect(maskfunPixelFormats).toEqual('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
 expect(maskfunPixelFormats).toHaveLength(55);expect(maskfunOperator.formats!(parseMaskfunOptions(null))).toBe(maskfunPixelFormats);expect(Object.isFrozen(maskfunPixelFormats)).toBe(true);
 expect(videoOperator('maskfun')).toBe(maskfunOperator);expect(maskfunOperator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(maskfunOperator.timeline).toBeUndefined();expect(maskfunOperator.geometryCommands).toBeUndefined();
});
it('binarises masked planes into owned tight planes without mutating padded input',()=>{
 const input=Uint8Array.of(0,10,11,99,3,12,9,99),frame=gray(input,3,2,4),step=parseMaskfunOptions('sum=255'),actual=maskVideoFrame(frame,step,{maxFrameBytes:8});
 expect([...actual.planes[0]!]).toEqual([0,0,255,0,255,0]);expect(actual.linesizes).toEqual([3]);expect(actual.pts).toEqual(frame.pts);expect(actual.pts).not.toBe(frame.pts);expect(actual.metadata).toEqual({colorRange:2});expect(actual.metadata).not.toBe(frame.metadata);expect([...input]).toEqual([0,10,11,99,3,12,9,99]);expect(actual.planes[0]!.buffer).not.toBe(input.buffer);
 // low < sample <= high is kept; low > high sends every sample to 0 or max.
 expect([...maskVideoFrame(frame,parseMaskfunOptions('low=2:high=11:sum=255'),{maxFrameBytes:8}).planes[0]!]).toEqual([0,10,11,3,255,9]);expect([...maskVideoFrame(frame,parseMaskfunOptions('low=10:high=5:sum=255'),{maxFrameBytes:8}).planes[0]!]).toEqual([0,0,255,0,255,0]);
 const copy=maskVideoFrame(frame,parseMaskfunOptions('planes=0:sum=0'),{maxFrameBytes:8});expect([...copy.planes[0]!]).toEqual([0,10,11,3,12,9]);
 const yuva:VideoFrameData={width:1,height:1,pixelFormat:'yuva420p',planes:[Uint8Array.of(5),Uint8Array.of(20),Uint8Array.of(250),Uint8Array.of(251)],linesizes:[1,1,1,1],pts:null,metadata:{}};
 expect(maskVideoFrame(yuva,parseMaskfunOptions('planes=5:sum=255'),{maxFrameBytes:4}).planes.map(plane=>plane[0])).toEqual([0,20,255,251]);expect(maskVideoFrame(yuva,parseMaskfunOptions('planes=8:sum=255'),{maxFrameBytes:4}).planes.map(plane=>plane[0])).toEqual([5,20,250,255]);
 const gbrp:VideoFrameData={width:1,height:1,pixelFormat:'gbrp',planes:[Uint8Array.of(5),Uint8Array.of(5),Uint8Array.of(50)],linesizes:[1,1,1],pts:null,metadata:{}};
 // Bits follow plane index: G, B, R; bit 3 has no plane.
 expect(maskVideoFrame(gbrp,parseMaskfunOptions('planes=12:sum=255'),{maxFrameBytes:3}).planes.map(plane=>plane[0])).toEqual([5,5,255]);expect(maskVideoFrame(gbrp,parseMaskfunOptions('planes=3:sum=255'),{maxFrameBytes:3}).planes.map(plane=>plane[0])).toEqual([0,0,50]);
});
it('outputs the empty frame filled with min(fill, 255) when the selected-plane sum reaches sum * plane area',()=>{
 const frame=gray(Uint8Array.of(10,10,10,10,10,9),3,2),fill=(options:string)=>[...maskVideoFrame(frame,parseMaskfunOptions(options),{maxFrameBytes:6}).planes[0]!];
 // 59 < 10*6 keeps the frame; sum >= max_sum (not >) empties it.
 expect(fill('sum=10:fill=7')).toEqual([0,0,0,0,0,0]);expect(fill('sum=9:fill=7')).toEqual([7,7,7,7,7,7]);expect(fill('sum=0:fill=300')).toEqual(Array(6).fill(255));expect(fill('sum=0:fill=255:planes=0')).toEqual([10,10,10,10,10,9]);
 // A mask whose bits name no plane gives max_sum 0 and no rows: never empty.
 expect(fill('sum=0:fill=9:planes=14')).toEqual([10,10,10,10,10,9]);
 // The sum counts selected planes only, but the empty frame fills every plane, with the input timestamp and properties.
 const yuv:VideoFrameData={width:2,height:2,pixelFormat:'yuv420p',planes:[Uint8Array.of(0,0,0,0),Uint8Array.of(255),Uint8Array.of(1)],linesizes:[2,1,1],pts:{value:-3n,timeBase:{num:1n,den:30n}},metadata:{colorRange:1}};
 const empty=maskVideoFrame(yuv,parseMaskfunOptions('planes=2:sum=255:fill=4'),{maxFrameBytes:6});expect(empty.planes.map(plane=>[...plane])).toEqual([[4,4,4,4],[4],[4]]);expect(empty.pts).toEqual(yuv.pts);expect(empty.metadata).toEqual({colorRange:1});
 expect(maskVideoFrame(yuv,parseMaskfunOptions('planes=5:sum=255:fill=4'),{maxFrameBytes:6}).planes.map(plane=>[...plane])).toEqual([[0,0,0,0],[255],[0]]);
});
it('rejects unsupported layouts, budgets, malformed storage, settings and cancellation explicitly',()=>{
 const step=parseMaskfunOptions(null);
 for(const pixelFormat of ['nv12','rgb24','rgba','bgr24','pal8'])expect(()=>maskVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},step,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>maskVideoFrame(gray(new Uint8Array(6),3,2),step,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>maskVideoFrame(gray(new Uint8Array(8),3,2,4),step,{maxFrameBytes:7})).toThrow('storage exceeds');expect(()=>maskVideoFrame(gray(new Uint8Array(6),3,2),step,{maxFrameBytes:0})).toThrow('allocation limit');expect(()=>maskVideoFrame(gray(new Uint8Array(6),3,2),step,{maxFrameBytes:1.5})).toThrow('allocation limit');
 expect(()=>maskVideoFrame(gray(new Uint8Array(5),3,2),step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>maskVideoFrame(gray(new Uint8Array(6),3,2,2),step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>maskVideoFrame(gray(new Uint8Array(6),3,2,3.5),step,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>maskVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},step,{maxFrameBytes:64})).toThrow('plane count');expect(()=>maskVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},step,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{low:-1},{high:65536},{planes:16},{fill:0.5},{sum:-2}])expect(()=>maskVideoFrame(gray(new Uint8Array(6),3,2),{...step,...bad},{maxFrameBytes:64}),JSON.stringify(bad)).toThrow('Invalid maskfun settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>maskVideoFrame(gray(new Uint8Array(6),3,2),step,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans maskfun on linear, graph and actor paths, refuses bad options before frames and refuses runtime commands',async()=>{
 const plan=compileVideoFilterChain('maskfun=sum=255,hflip,maskfun=low=0:high=254:sum=255').plan('gray',5,3);expect(plan.stages.map(stage=>stage.operation)).toEqual(['maskfun','hflip','maskfun']);expect(plan.stateBytes).toBe(0);
 const frame=gray(Uint8Array.from({length:15},(_,i)=>i*9),5,3),output=plan.apply(frame,{maxFrameBytes:15,maxStateBytes:0});expect([...output.planes[0]!]).toEqual([255,255,255,0,0,...Array(10).fill(255)]);expect(()=>plan.apply(frame,{maxFrameBytes:14,maxStateBytes:0})).toThrow();
 expect(compileVideoFilterChain('maskfun').plan('nv12',5,3).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv420p'],['maskfun','yuv420p']]);
 // Native converts packed RGB with alpha to gbrap (tests/differential/video-maskfun.test.ts), which has no frame storage here.
 for(const source of ['rgba','argb'])expect(()=>compileVideoFilterChain('maskfun').plan(source,5,3),source).toThrow('Video filter maskfun input negotiates gbrap, which is not implemented');
 expect(()=>compileVideoFilterChain('maskfun=low=65536')).toThrow('Invalid maskfun low');expect(()=>compileVideoFilterGraph('[0:v]maskfun=planes=16[o]')).toThrow('Invalid maskfun planes');expect(()=>createFrameActors('maskfun=sum=-1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('Invalid maskfun sum');
 expect(()=>compileVideoFilterChain('maskfun=enable=1')).toThrow('timeline');expect(()=>createFrameActors('maskfun=enable=gte(t\\,1)',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
 const actors=createFrameActors('maskfun=sum=255',{maxSteps:64,maxQueuedFrames:2,maxQueuedBytes:1<<12,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry:{format:'gray',width:5,height:3}}]});
 try{for(const [command,argument]of [['low','0'],['high','10'],['planes','0'],['fill','1'],['sum','0'],['enable','0']] as const)expect(actors.sendFilterCommand('maskfun',command,argument).code,command).toBe(command==='enable'?-1163346256:-38);
  actors.sendFrameInput(0,{kind:'frame',duration:1n,frame});actors.endInput(0,-541478725,1n);const result=await actors.readFrame(0);expect(result.code).toBe(0);expect([...result.event!.frame.planes[0]!].slice(0,5)).toEqual([0,0,255,255,255]);}finally{actors.dispose();}
});
