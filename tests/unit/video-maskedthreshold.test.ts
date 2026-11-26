import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,compileMultiInputVideoFilterGraph,planTimedVideoGraph,videoOperator,VideoFilterError} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {maskedthresholdOperator,maskedthresholdPixelFormats,maskedthresholdVideoFrames,maskedthresholdGeometry,parseMaskedthresholdOptions,VideoMaskedthresholdError} from '../../packages/avfilter/src/video-ops/maskedthreshold.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
const time={num:1n,den:25n};
const gray=(data:Uint8Array,width:number,height:number,stride=width,pts:bigint|null=7n):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:pts===null?null:{value:pts,timeBase:time},metadata:{colorRange:2}});
it('parses declared defaults, shorthand, named modes, integer expressions and ranges, refusing every other option',()=>{
 expect(parseMaskedthresholdOptions(null)).toEqual({name:'maskedthreshold',threshold:1,planes:15,mode:'abs',shortest:false});expect(Object.isFrozen(parseMaskedthresholdOptions(''))).toBe(true);
 expect(parseMaskedthresholdOptions('10:5:diff')).toEqual({name:'maskedthreshold',threshold:10,planes:5,mode:'diff',shortest:false});
 expect(parseMaskedthresholdOptions('mode=1:planes=3:threshold=0')).toEqual({name:'maskedthreshold',threshold:0,planes:3,mode:'diff',shortest:false});
 expect(parseMaskedthresholdOptions('mode=abs+1').mode).toBe('diff');expect(parseMaskedthresholdOptions('mode=diff-1').mode).toBe('abs');expect(parseMaskedthresholdOptions('threshold=max').threshold).toBe(65535);expect(parseMaskedthresholdOptions('threshold=2*100:planes=0x3').planes).toBe(3);
 expect(parseMaskedthresholdOptions('threshold=2.5').threshold).toBe(2);expect(parseMaskedthresholdOptions('threshold=3.5').threshold).toBe(4);expect(parseMaskedthresholdOptions('threshold=1:threshold=9').threshold).toBe(9);expect(parseMaskedthresholdOptions('planes=default:threshold=default').planes).toBe(15);
 for(const [options,message]of [['threshold=-1','Invalid maskedthreshold threshold'],['threshold=65536','Invalid maskedthreshold threshold'],['planes=16','Invalid maskedthreshold planes'],['planes=all','Invalid maskedthreshold planes'],['mode=2','Invalid maskedthreshold mode'],['mode=bogus','Invalid maskedthreshold mode'],['threshold=','Invalid maskedthreshold threshold'],
  ['enable=1','timeline'],['enable=between(t,0,1)','timeline'],['shortest=1','Unsupported maskedthreshold option'],['eof_action=repeat','Unsupported maskedthreshold option'],['repeatlast=0','Unsupported maskedthreshold option'],['ts_sync_mode=nearest','Unsupported maskedthreshold option'],['threads=1','Unsupported maskedthreshold option'],['1:2:abs:4',''],['threshold=1:2','']] as const)
  expect(()=>parseMaskedthresholdOptions(options),options).toThrow(message);
 expect(()=>parseMaskedthresholdOptions('mode=3')).toThrow(VideoFilterParseError);
 expect(maskedthresholdPixelFormats).toEqual('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
 expect(maskedthresholdOperator.formats!(parseMaskedthresholdOptions(null))).toBe(maskedthresholdPixelFormats);expect(Object.isFrozen(maskedthresholdPixelFormats)).toBe(true);
 expect(videoOperator('maskedthreshold')).toBe(maskedthresholdOperator);expect(maskedthresholdOperator.role).toBe('join');expect(maskedthresholdOperator.paths).toEqual(['graph','stream','actor','timed']);expect(maskedthresholdOperator.timeline).toBeUndefined();expect(maskedthresholdOperator.geometryCommands).toBeUndefined();
 expect(maskedthresholdOperator.parse!({name:'maskedthreshold',options:'5',label:null} as never)).toMatchObject({inputs:2,outputs:1,configuration:{threshold:5}});
});
it('picks threshold8_abs and threshold8_diff per pixel, copies unselected planes from the reference and keeps source properties',()=>{
 const src=Uint8Array.of(10,10,10,200,0,255,99,99),ref=Uint8Array.of(10,11,12,190,5,250,99,99),a=gray(src,3,2,4),b=gray(ref,3,2,4),options={maxFrameBytes:8};
 // abs: |s-r| <= t ? s : r.
 expect([...maskedthresholdVideoFrames([a,b],parseMaskedthresholdOptions('threshold=1'),options).planes[0]!]).toEqual([10,10,12,5,250,99]);
 expect([...maskedthresholdVideoFrames([a,b],parseMaskedthresholdOptions('threshold=0'),options).planes[0]!]).toEqual([10,11,12,5,250,99]);
 expect([...maskedthresholdVideoFrames([a,b],parseMaskedthresholdOptions('threshold=255'),options).planes[0]!]).toEqual([10,10,10,0,255,99]);
 // diff: r - s <= t ? max(r - t, 0) : s, including negative differences.
 expect([...maskedthresholdVideoFrames([a,b],parseMaskedthresholdOptions('threshold=1:mode=diff'),options).planes[0]!]).toEqual([9,10,10,0,249,98]);
 expect([...maskedthresholdVideoFrames([a,b],parseMaskedthresholdOptions('threshold=0:mode=diff'),options).planes[0]!]).toEqual([10,10,10,0,250,99]);
 expect([...maskedthresholdVideoFrames([a,b],parseMaskedthresholdOptions('threshold=300:mode=diff'),options).planes[0]!]).toEqual([0,0,0,0,0,0]);
 const out=maskedthresholdVideoFrames([a,b],parseMaskedthresholdOptions('planes=0'),options);expect([...out.planes[0]!]).toEqual([10,11,12,5,250,99]);expect(out.planes[0]!.buffer).not.toBe(ref.buffer);
 expect(out.linesizes).toEqual([3]);expect(out.pts).toEqual(a.pts);expect(out.pts).not.toBe(a.pts);expect(out.metadata).toEqual({colorRange:2});expect(out.metadata).not.toBe(a.metadata);
 expect([...src]).toEqual([10,10,10,200,0,255,99,99]);expect([...ref]).toEqual([10,11,12,190,5,250,99,99]);
 // Bits follow plane index: yuva420p Y, U, V, A.
 const yuva=(values:number[]):VideoFrameData=>({width:1,height:1,pixelFormat:'yuva420p',planes:values.map(value=>Uint8Array.of(value)),linesizes:[1,1,1,1],pts:null,metadata:{}});
 expect(maskedthresholdVideoFrames([yuva([1,2,3,4]),yuva([9,9,9,9])],parseMaskedthresholdOptions('threshold=255:planes=5'),{maxFrameBytes:4}).planes.map(plane=>plane[0])).toEqual([1,9,3,9]);
 expect(maskedthresholdVideoFrames([yuva([1,2,3,4]),yuva([9,9,9,9])],parseMaskedthresholdOptions('threshold=255:planes=8'),{maxFrameBytes:4}).planes.map(plane=>plane[0])).toEqual([9,9,9,4]);
 // The minimum timestamp is rescaled without PASS_MINMAX.
 expect(maskedthresholdVideoFrames([gray(src,3,2,4,-(1n<<63n)),gray(ref,3,2,4,-(1n<<63n))],parseMaskedthresholdOptions(null),options).pts!.value).toBe(-(1n<<63n)+1n);
});
it('refuses mismatched inputs, unsupported layouts, budgets, malformed storage, settings and cancellation explicitly',()=>{
 const step=parseMaskedthresholdOptions(null),ok=gray(new Uint8Array(6),3,2);
 expect(maskedthresholdGeometry([{format:'gray',width:3,height:2},{format:'gray',width:3,height:2}])).toEqual({width:3,height:2});
 expect(()=>maskedthresholdGeometry([{format:'gray',width:3,height:2},{format:'gray',width:2,height:3}])).toThrow('First input link source parameters (size 3x2) do not match the corresponding second input link reference parameters (2x3)');
 expect(()=>maskedthresholdGeometry([{format:'gray',width:3,height:2},{format:'yuv420p',width:3,height:2}])).toThrow('pixel formats differ');expect(()=>maskedthresholdGeometry([{format:'gray',width:3,height:2}])).toThrow(VideoMaskedthresholdError);
 expect(()=>maskedthresholdVideoFrames([ok],step,{maxFrameBytes:64})).toThrow('source and a reference');expect(()=>maskedthresholdVideoFrames([ok,gray(new Uint8Array(4),2,2)],step,{maxFrameBytes:64})).toThrow('do not match');
 for(const pixelFormat of ['nv12','rgb24','rgba','yuv420p10le','gbrap'])expect(()=>maskedthresholdVideoFrames([1,2].map(()=>({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}})),step,{maxFrameBytes:64}),pixelFormat).toThrow();
 expect(()=>maskedthresholdVideoFrames([{width:2,height:2,pixelFormat:'nv12',planes:[],linesizes:[],pts:null,metadata:{}},{width:2,height:2,pixelFormat:'nv12',planes:[],linesizes:[],pts:null,metadata:{}}],step,{maxFrameBytes:64})).toThrow('not supported');
 expect(()=>maskedthresholdVideoFrames([ok,ok],step,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>maskedthresholdVideoFrames([ok,ok],step,{maxFrameBytes:0})).toThrow('allocation limit');
 expect(()=>maskedthresholdVideoFrames([ok,gray(new Uint8Array(8),3,2,4)],step,{maxFrameBytes:7})).toThrow('storage exceeds');
 for(const bad of [gray(new Uint8Array(5),3,2),gray(new Uint8Array(6),3,2,2),gray(new Uint8Array(6),3,2,3.5)])expect(()=>maskedthresholdVideoFrames([ok,bad],step,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>maskedthresholdVideoFrames([ok,{...ok,planes:[]}],step,{maxFrameBytes:64})).toThrow('plane count');expect(()=>maskedthresholdVideoFrames([{...ok,pts:{value:0n,timeBase:{num:0n,den:1n}}},ok],step,{maxFrameBytes:64})).toThrow('time base');
 expect(()=>maskedthresholdVideoFrames([ok,gray(new Uint8Array(6),3,2,3,8n)],step,{maxFrameBytes:64})).toThrow('synchronized');expect(()=>maskedthresholdVideoFrames([ok,gray(new Uint8Array(6),3,2,3,null)],step,{maxFrameBytes:64})).toThrow('synchronized');
 expect(maskedthresholdVideoFrames([ok,{...ok,pts:{value:14n,timeBase:{num:1n,den:50n}}}],step,{maxFrameBytes:64}).pts).toEqual(ok.pts);
 for(const bad of [{threshold:-1},{threshold:65536},{threshold:0.5},{planes:16},{mode:'max'}])expect(()=>maskedthresholdVideoFrames([ok,ok],{...step,...bad} as never,{maxFrameBytes:64}),JSON.stringify(bad)).toThrow('Invalid maskedthreshold settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>maskedthresholdVideoFrames([ok,ok],step,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans maskedthreshold as a two-input join only, refuses size mismatches at plan time and refuses runtime commands',async()=>{
 expect(()=>compileVideoFilterChain('maskedthreshold')).toThrow(VideoFilterError);
 const plan=compileMultiInputVideoFilterGraph('[0:v][1:v]maskedthreshold=threshold=0:mode=diff[o]').plan([{format:'gray',width:3,height:2},{format:'gray',width:3,height:2}],[null],{arithmetic:'scalar'});
 const [out]=plan.applyBatch([gray(Uint8Array.of(1,2,3,4,5,6),3,2),gray(Uint8Array.of(6,5,4,3,2,1),3,2)],{maxFrameBytes:64,maxStateBytes:0,maxResidentBytes:1<<12});expect([...out!.planes[0]!]).toEqual([1,2,3,3,2,1]);
 expect(()=>compileMultiInputVideoFilterGraph('[0:v][1:v]maskedthreshold[o]').plan([{format:'gray',width:3,height:2},{format:'gray',width:2,height:2}],[null])).toThrow('do not match');
 expect(()=>compileVideoFilterGraph('[0:v]split[a][b];[a]scale=4:2[c];[c][b]maskedthreshold[o]').plan({format:'gray',width:3,height:2},[null])).toThrow('do not match');
 expect(()=>planTimedVideoGraph('split[a][b];[a]scale=4:2[c];[c][b]maskedthreshold',[{geometry:{format:'gray',width:3,height:2},timeBase:time,frameRate:{num:25n,den:1n}}],[null])).toThrow('do not match');
 expect(()=>compileVideoFilterGraph('[0:v]split[a][b];[a][b]maskedthreshold=shortest=1[o]')).toThrow('Unsupported maskedthreshold option');expect(()=>createFrameActors('split[a][b];[a][b]maskedthreshold=enable=1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
 const actors=createFrameActors('[0:v][1:v]maskedthreshold',{maxSteps:64,maxQueuedFrames:2,maxQueuedBytes:1<<12,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[0,1].map(()=>({timeBase:time,frameRate:{num:25n,den:1n},geometry:{format:'gray',width:3,height:2}}))});
 try{for(const [command,argument]of [['threshold','0'],['planes','0'],['mode','1']] as const)expect(actors.sendFilterCommand('maskedthreshold',command,argument).code,command).toBe(-38);
  actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:gray(Uint8Array.of(1,2,3,4,5,6),3,2,3,0n)});actors.sendFrameInput(1,{kind:'frame',duration:1n,frame:gray(Uint8Array.of(1,9,3,9,5,9),3,2,3,0n)});actors.endInput(0,-541478725,1n);actors.endInput(1,-541478725,1n);
  const result=await actors.readFrame(0);expect(result.code).toBe(0);expect([...result.event!.frame.planes[0]!]).toEqual([1,9,3,9,5,9]);}finally{actors.dispose();}
});
