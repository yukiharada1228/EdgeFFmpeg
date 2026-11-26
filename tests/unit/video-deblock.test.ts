import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph,VideoFilterError} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {deblockOperator,deblockPixelFormats,deblockVideoFrame,parseDeblockOptions,VideoDeblockError} from '../../packages/avfilter/src/video-ops/deblock.js';
import type {DeblockStep} from '../../packages/avfilter/src/video-ops/deblock.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
const step=(options:string|null)=>parseDeblockOptions(options);
const source={timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}};
it('parses deblock_options with native defaults, shorthand order, filter constants, integer expressions and last-wins keys',()=>{
 const defaults=step(null);
 expect(defaults).toEqual({name:'deblock',filter:'strong',block:8,alpha:Math.fround(0.098),beta:Math.fround(0.05),gamma:Math.fround(0.05),delta:Math.fround(0.05),planes:15,thresholds:[24,12,12,12]});
 expect(Object.isFrozen(defaults)).toBe(true);expect(Object.isFrozen(defaults.thresholds)).toBe(true);expect(step('')).toEqual(defaults);
 expect(step('weak:4:1:0.5:0:0.6:5')).toMatchObject({filter:'weak',block:4,planes:5,thresholds:[255,127,0,153]});
 expect(step('filter=0').filter).toBe('weak');expect(step('filter=strong').filter).toBe('strong');expect(step('filter=weak:filter=1').filter).toBe('strong');
 // AV_OPT_TYPE_INT: expressions, the default/min/max constants and llrint half-to-even rounding.
 expect(step('block=max:planes=min').block).toBe(512);expect(step('block=4.5').block).toBe(4);expect(step('block=5.5').block).toBe(6);expect(step('block=2*3').block).toBe(6);expect(step('planes=default').planes).toBe(15);expect(step('planes=0x3').planes).toBe(3);
 // AV_OPT_TYPE_FLOAT: the double is range-checked, then stored as float; config_output truncates float*255 once.
 expect(step('alpha=0.0118:beta=1e-2:gamma=.2:delta=1.0').thresholds).toEqual([3,2,51,255]);expect(step('alpha=0.003921568').thresholds[0]).toBe(0);expect(step('alpha=0.0039216').thresholds[0]).toBe(1);expect(step('alpha=-0').alpha).toBe(0);
 for(const options of ['enable=1','threads=1','foo=1','block=3','block=513','block=','filter=2','filter=medium','planes=16','planes=-1','alpha=1.5','alpha=-0.1','beta=1/2','gamma=0x1','delta=','alpha=abc'])expect(()=>step(options),options).toThrow(VideoFilterParseError);
 for(const options of ['strong:8:0.1:0.1:0.1:0.1:15:1','block=4:8'])expect(()=>step(options),options).toThrow('Missing filter option name');
 expect(()=>step('foo=1')).toThrow('Unsupported deblock option');expect(()=>step('enable=1')).toThrow('timeline');expect(()=>step('beta=1/2')).toThrow('Only decimal deblock beta values');expect(()=>step('alpha=1.5')).toThrow('Invalid deblock alpha');expect(()=>step('block=600')).toThrow('Invalid deblock block');
 expect(deblockOperator.parse!({name:'deblock',options:'weak'} as never).configuration.filter).toBe('weak');
});
it('declares the native pix_fmts in declared order and refuses edges within the kernel reach of the right plane border',()=>{
 expect(deblockPixelFormats).toEqual('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
 expect(Object.isFrozen(deblockPixelFormats)).toBe(true);expect(deblockOperator.formats!(step(null))).toBe(deblockPixelFormats);expect(deblockOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
 const geometry=(options:string|null,format:string,width:number,height=4)=>deblockOperator.geometry!(step(options),[{format,width,height}]);
 // Weak reads x+1 and strong x+2 at an edge x: width % block of 1 (weak) or 1..2 (strong) past the first block reads outside the row.
 for(const [options,width]of [[null,9],[null,10],[null,17],['weak',9],['block=4',5],['block=4',6],['weak:4',13],['block=512',513]] as const)expect(()=>geometry(options,'gray',width),`${options}/${width}`).toThrow('read outside the plane');
 for(const [options,width]of [[null,8],[null,11],[null,16],[null,1],['weak',10],['block=4',7],['block=4',8],['block=512',512],['block=8:planes=14',9],['weak:4',34]] as const)expect(geometry(options,'gray',width),`${options}/${width}`).toEqual({width,height:4});
 // Chroma widths of the negotiated format count only for selected planes.
 expect(()=>geometry('block=4','yuv420p',12)).toThrow('read outside the plane');expect(geometry('block=4:planes=9','yuv420p',12)).toEqual({width:12,height:4});expect(()=>geometry('block=4:planes=8','yuva420p',13)).toThrow('read outside the plane');
 expect(()=>geometry(null,'rgb24',8)).toThrow('not supported');expect(()=>geometry(null,'yuv440p',8)).toThrow('Unsupported video pixel format');expect(()=>deblockOperator.geometry!(step(null),[])).toThrow('one input');
});
it('ports the weak and strong kernels, the block loop with its border skips and the vertical stop at a skipped row',()=>{
 // 8x2, weak, thresholds 255: one vertical edge at x=4. delta=10 gives delta/8=1 and delta/2=5 on columns 2..5.
 const smooth=[10,10,10,10,20,20,20,20],input=Uint8Array.from([...smooth,...smooth]),frame=gray(input,8,2);
 const out=deblockVideoFrame(frame,step('weak:4:1:1:1'),{maxFrameBytes:16});
 expect([...out.planes[0]!]).toEqual([10,10,11,15,15,19,20,20,10,10,11,15,15,19,20,20]);expect(out.linesizes).toEqual([8]);expect(out.pts).toEqual(frame.pts);expect(out.pts).not.toBe(frame.pts);expect(out.metadata).toEqual({colorRange:2});
 expect([...input]).toEqual([...smooth,...smooth]);expect(out.planes[0]!.buffer).not.toBe(input.buffer);
 // Row 0 is skipped (|delta| = 255): native's continue skips dst += linesize, so row 1 is never reached.
 const stop=deblockVideoFrame(gray(Uint8Array.from([0,0,0,0,255,255,255,255,...smooth]),8,2),step('weak:4:1:1:1'),{maxFrameBytes:16});
 expect([...stop.planes[0]!]).toEqual([0,0,0,0,255,255,255,255,...smooth]);
 // Horizontal kernels skip one column and continue.
 const rows=Array.from({length:8},(_,y)=>Array.from({length:4},(_,x)=>y<4?10:x===1?255:20)).flat(),h=deblockVideoFrame(gray(Uint8Array.from(rows),4,8),step('weak:4:1:1:1'),{maxFrameBytes:32});
 // No vertical edge (width 4) and no horizontal edge: y=4 is the last block row at height-block, a native border skip.
 expect([...h.planes[0]!]).toEqual(rows);
 const tall=Array.from({length:12},(_,y)=>Array.from({length:4},(_,x)=>y<4?(x===3&&y===2?14:10):x===1?0:20)).flat(),t=deblockVideoFrame(gray(Uint8Array.from(tall),4,12),step('weak:4:1:0.0118:1'),{maxFrameBytes:48}).planes[0]!;
 // Only the horizontal edge at y=4 runs (y=8 is the last block row). Column 1 has delta -10 (/8 -> -1, /2 -> -5); column 3 fails beta=3
 // (|row3-row2| = 4) and the horizontal kernel continues with the next column.
 expect([...t.subarray(8,24)]).toEqual([11,9,11,14,15,5,15,10,15,5,15,20,19,1,19,20]);expect([...t.subarray(0,8)]).toEqual(tall.slice(0,8));expect([...t.subarray(24)]).toEqual(tall.slice(24));
 // Strong: edge at x=4 with delta 12 -> /8=1, /4=3, /2=6 on columns 1..6.
 const s=deblockVideoFrame(gray(Uint8Array.of(10,10,10,10,22,22,22,22),8,1),step('strong:4:1:1:1:1'),{maxFrameBytes:8}).planes[0]!;expect([...s]).toEqual([10,11,13,16,16,19,21,22]);
 // Negative deltas truncate toward zero and results clip to 0..255.
 expect([...deblockVideoFrame(gray(Uint8Array.of(1,1,1,1,0,0,0,0),8,1),step('strong:4:1:1:1:1'),{maxFrameBytes:8}).planes[0]!]).toEqual([1,1,1,1,0,0,0,0]);
 expect([...deblockVideoFrame(gray(Uint8Array.of(9,9,0,9,0,0,0,0),8,1),step('weak:4:1:1:1'),{maxFrameBytes:8}).planes[0]!]).toEqual([9,9,0,5,4,1,0,0]);
 // planes selects per plane index; zero thresholds and planes=0 copy.
 const yuva:VideoFrameData={width:8,height:1,pixelFormat:'yuva420p',planes:[Uint8Array.from(smooth),Uint8Array.of(1,2,3,4),Uint8Array.of(5,6,7,8),Uint8Array.from(smooth)],linesizes:[8,4,4,8],pts:null,metadata:{}};
 expect(deblockVideoFrame(yuva,step('weak:4:1:1:1:1:8'),{maxFrameBytes:24}).planes.map(plane=>[...plane])).toEqual([smooth,[1,2,3,4],[5,6,7,8],[10,10,11,15,15,19,20,20]]);
 expect([...deblockVideoFrame(gray(Uint8Array.from(smooth),8,1),step('weak:4:0:1:1'),{maxFrameBytes:8}).planes[0]!]).toEqual(smooth);expect([...deblockVideoFrame(gray(Uint8Array.from(smooth),8,1),step('weak:4:1:1:1:1:0'),{maxFrameBytes:8}).planes[0]!]).toEqual(smooth);
});
it('rejects unsupported layouts, budgets, malformed storage, invalid settings and cancellation explicitly',()=>{
 const settings=step(null);
 for(const pixelFormat of ['nv12','nv21','rgb24','rgba','pal8'])expect(()=>deblockVideoFrame({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}},settings,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>deblockVideoFrame(gray(new Uint8Array(9),9,1),settings,{maxFrameBytes:64})).toThrow(VideoDeblockError);
 expect(()=>deblockVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>deblockVideoFrame(gray(new Uint8Array(8),3,2,4),settings,{maxFrameBytes:7})).toThrow('storage exceeds');
 expect(()=>deblockVideoFrame(gray(new Uint8Array(5),3,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>deblockVideoFrame(gray(new Uint8Array(6),3,2,2),settings,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>deblockVideoFrame(gray(new Uint8Array(6),3,2,2.5),settings,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>deblockVideoFrame({...gray(new Uint8Array(6),3,2),planes:[]},settings,{maxFrameBytes:64})).toThrow('plane count');
 expect(()=>deblockVideoFrame({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},settings,{maxFrameBytes:64})).toThrow('time base');
 for(const bad of [{...settings,filter:'medium'},{...settings,block:3},{...settings,block:4.5},{...settings,planes:16},{...settings,thresholds:[1,2,3]},{...settings,thresholds:[1,2,3,256]},{...settings,name:'deflate'}])expect(()=>deblockVideoFrame(gray(new Uint8Array(6),3,2),bad as unknown as DeblockStep,{maxFrameBytes:64})).toThrow('Invalid deblock settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>deblockVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 let calls=0;const late={get aborted(){return false;},throwIfAborted(){if(++calls>2)throw new Error('late stop');}} as unknown as AbortSignal;expect(()=>deblockVideoFrame(gray(new Uint8Array(6),3,2),settings,{maxFrameBytes:64,signal:late})).toThrow('late stop');
});
it('plans deblock on every path with edge-reach refusals and refuses enable= and runtime commands',()=>{
 const plan=compileVideoFilterChain('deblock,hflip,deblock=weak:4').plan('gray',16,8);expect(plan.stages.map(stage=>stage.operation)).toEqual(['deblock','hflip','deblock']);expect(plan.stateBytes).toBe(0);
 expect(()=>plan.apply(gray(new Uint8Array(128),16,8),{maxFrameBytes:127,maxStateBytes:0})).toThrow('budget');
 expect(compileVideoFilterChain('deblock').plan('nv12',8,8).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['scale','yuv420p'],['deblock','yuv420p']]);
 for(const source of ['rgba','abgr'])expect(()=>compileVideoFilterChain('deblock').plan(source,8,6),source).toThrow('Video filter deblock input negotiates gbrap, which is not implemented');
 expect(()=>compileVideoFilterChain('deblock').plan('gray',9,4)).toThrow(VideoFilterError);expect(()=>compileVideoFilterChain('deblock').plan('gray',10,4)).toThrow('read outside the plane');
 expect(()=>compileVideoFilterGraph('[0:v]deblock[o]').plan({format:'gray',width:9,height:4},[null])).toThrow('read outside the plane');
 expect(()=>planTimedVideoGraph('deblock',[{geometry:{format:'gray',width:9,height:4},...source}],[null])).toThrow('read outside the plane');
 expect(planTimedVideoGraph('deblock=weak:4',[{geometry:{format:'gray',width:8,height:8},...source}],[null]).nodes.length).toBeGreaterThan(0);
 for(const description of ['deblock=enable=1','deblock=block=2','deblock=alpha=1/2'])expect(()=>createFrameActors(description,{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64}),description).toThrow();
 expect(deblockOperator.timeline).toBeUndefined();expect(deblockOperator.geometryCommands).toBeUndefined();
});
