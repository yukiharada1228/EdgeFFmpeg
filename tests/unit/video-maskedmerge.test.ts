import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,compileMultiInputVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {maskedmergeOperator,maskedmergePixelFormats,maskedMergeGeometry,maskedMergeVideoFrames,parseMaskedMergeOptions} from '../../packages/avfilter/src/video-ops/maskedmerge.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width,pts:VideoFrameData['pts']={value:9007199254740993n,timeBase:{num:1n,den:25n}}):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts,metadata:{colorRange:2}});
const step=parseMaskedMergeOptions(null);
it('parses planes with integer expressions and ranges and refuses enable=, framesync options and unknown options',()=>{
 expect(step).toEqual({name:'maskedmerge',planes:15,shortest:false});expect(Object.isFrozen(parseMaskedMergeOptions(''))).toBe(true);
 expect(parseMaskedMergeOptions('5').planes).toBe(5);expect(parseMaskedMergeOptions('planes=0').planes).toBe(0);expect(parseMaskedMergeOptions('planes=0x3').planes).toBe(3);expect(parseMaskedMergeOptions('planes=2*3').planes).toBe(6);
 expect(parseMaskedMergeOptions('planes=max').planes).toBe(15);expect(parseMaskedMergeOptions('planes=default').planes).toBe(15);expect(parseMaskedMergeOptions('planes=1:planes=2').planes).toBe(2);expect(parseMaskedMergeOptions('planes=2.5').planes).toBe(2);
 for(const [options,message]of [['planes=16','Invalid maskedmerge planes'],['planes=-1','Invalid maskedmerge planes'],['planes=abc','Invalid maskedmerge planes'],['planes=','Invalid maskedmerge planes'],['enable=1','timeline'],['enable=between(t,0,1)','timeline'],
  ['shortest=1','Unsupported maskedmerge option'],['shortest=0','Unsupported maskedmerge option'],['eof_action=repeat','Unsupported maskedmerge option'],['repeatlast=1','Unsupported maskedmerge option'],['ts_sync_mode=default','Unsupported maskedmerge option'],['foo=1','Unsupported maskedmerge option'],['1:2','']] as const)expect(()=>parseMaskedMergeOptions(options),options).toThrow(message);
 expect(()=>parseMaskedMergeOptions('planes=16')).toThrow(VideoFilterParseError);
 // The pinned vf_maskedmerge.c pix_fmts in declared order, shared by every pad.
 expect(maskedmergePixelFormats.slice(0,9)).toEqual(['yuva444p','yuv444p','yuv440p','yuvj444p','yuvj440p','yuva422p','yuv422p','yuva420p','yuv420p']);expect(maskedmergePixelFormats.slice(-9)).toEqual(['gray','gray9le','gray10le','gray12le','gray14le','gray16le','grayf32le','gbrpf32le','gbrapf32le']);
 expect(maskedmergePixelFormats).toHaveLength(61);expect(new Set(maskedmergePixelFormats).size).toBe(61);expect(maskedmergeOperator.formats!(step)).toBe(maskedmergePixelFormats);expect(Object.isFrozen(maskedmergePixelFormats)).toBe(true);
 expect(videoOperator('maskedmerge')).toBe(maskedmergeOperator);expect(maskedmergeOperator.role).toBe('join');expect(maskedmergeOperator.paths).toEqual(['graph','stream','actor','timed']);expect(maskedmergeOperator.timeline).toBeUndefined();expect(maskedmergeOperator.geometryCommands).toBeUndefined();
 expect(maskedmergeOperator.parse!({name:'maskedmerge',options:'planes=3'} as never)).toEqual({inputs:3,outputs:1,configuration:{name:'maskedmerge',planes:3,shortest:false}});
});
it('refuses differing sizes, differing formats and other input counts in geometry',()=>{
 const shape=(width:number,height:number,format='gray')=>({format,width,height});
 expect(maskedMergeGeometry([shape(5,3),shape(5,3),shape(5,3)])).toEqual({width:5,height:3});
 for(const inputs of [[shape(5,3),shape(4,3),shape(5,3)],[shape(5,3),shape(5,3),shape(5,2)],[shape(5,3),shape(5,4),shape(5,3)]])expect(()=>maskedMergeGeometry(inputs)).toThrow('Maskedmerge input sizes differ');
 expect(()=>maskedMergeGeometry([shape(5,3),shape(5,3,'yuv444p'),shape(5,3)])).toThrow('pixel formats differ');expect(()=>maskedMergeGeometry([shape(5,3),shape(5,3)])).toThrow('base, overlay and mask');expect(()=>maskedMergeGeometry([shape(5,3),shape(5,3),shape(5,3),shape(5,3)])).toThrow('base, overlay and mask');
});
it('merges selected planes with (b*(255-m)+m*o+127)/255, copies the rest from base, into owned tight planes without mutating padded inputs',()=>{
 const base=Uint8Array.of(255,0,200,9,10,255,1,9),overlay=Uint8Array.of(0,255,100,9,250,0,254,9),mask=Uint8Array.of(128,128,0,9,255,1,127,9),frames=[gray(base,3,2,4),gray(overlay,3,2,4),gray(mask,3,2,4)];
 const output=maskedMergeVideoFrames(frames,step,{maxFrameBytes:8});
 // 255*127+127=32512 -> 127; 0*127+128*255+127=32767 -> 128; m=0 keeps base; m=255 takes overlay; 255*254+127=64897 -> 254; 1*128+127*254+127=32513 -> 127.
 expect([...output.planes[0]!]).toEqual([127,128,200,250,254,127]);expect(output.linesizes).toEqual([3]);expect(output.pts).toEqual(frames[0]!.pts);expect(output.pts).not.toBe(frames[0]!.pts);expect(output.metadata).toEqual({colorRange:2});expect(output.metadata).not.toBe(frames[0]!.metadata);
 expect([...base]).toEqual([255,0,200,9,10,255,1,9]);expect([...overlay]).toEqual([0,255,100,9,250,0,254,9]);expect([...mask]).toEqual([128,128,0,9,255,1,127,9]);for(const frame of frames)expect(output.planes[0]!.buffer).not.toBe(frame.planes[0]!.buffer);
 const copy=maskedMergeVideoFrames(frames,parseMaskedMergeOptions('planes=14'),{maxFrameBytes:8});expect([...copy.planes[0]!]).toEqual([255,0,200,10,255,1]);
 const yuva=(values:readonly number[]):VideoFrameData=>({width:1,height:1,pixelFormat:'yuva420p',planes:values.map(value=>Uint8Array.of(value)),linesizes:[1,1,1,1],pts:null,metadata:{}});
 const triple=[yuva([10,20,30,40]),yuva([200,210,220,230]),yuva([255,255,255,255])];
 expect(maskedMergeVideoFrames(triple,parseMaskedMergeOptions('planes=5'),{maxFrameBytes:4}).planes.map(plane=>plane[0])).toEqual([200,20,220,40]);expect(maskedMergeVideoFrames(triple,parseMaskedMergeOptions('planes=8'),{maxFrameBytes:4}).planes.map(plane=>plane[0])).toEqual([10,20,30,230]);
 expect(maskedMergeVideoFrames(triple,parseMaskedMergeOptions('planes=8'),{maxFrameBytes:4}).pts).toBeNull();
 const minimum=gray(Uint8Array.of(1),1,1,1,{value:-(1n<<63n),timeBase:{num:1n,den:25n}});expect(maskedMergeVideoFrames([minimum,minimum,minimum],step,{maxFrameBytes:1}).pts!.value).toBe(-(1n<<63n)+1n);
});
it('rejects unsupported layouts, budgets, malformed storage, unsynchronized timestamps, settings and cancellation explicitly',()=>{
 const tight=()=>gray(new Uint8Array(6),3,2),three=(frame:VideoFrameData)=>[tight(),frame,tight()];
 for(const pixelFormat of ['nv12','rgb24','rgba','bgr24'])expect(()=>maskedMergeVideoFrames(Array.from({length:3},()=>({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}})),step,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>maskedMergeVideoFrames([tight(),tight(),tight()],step,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>maskedMergeVideoFrames([tight(),tight(),tight()],step,{maxFrameBytes:0})).toThrow('allocation limit');expect(()=>maskedMergeVideoFrames(three(gray(new Uint8Array(8),3,2,4)),step,{maxFrameBytes:7})).toThrow('storage exceeds');
 expect(()=>maskedMergeVideoFrames(three(gray(new Uint8Array(5),3,2)),step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>maskedMergeVideoFrames(three(gray(new Uint8Array(6),3,2,2)),step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>maskedMergeVideoFrames(three(gray(new Uint8Array(6),3,2,3.5)),step,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>maskedMergeVideoFrames(three({...tight(),planes:[]}),step,{maxFrameBytes:64})).toThrow('plane count');expect(()=>maskedMergeVideoFrames(three({...tight(),pts:{value:0n,timeBase:{num:0n,den:1n}}}),step,{maxFrameBytes:64})).toThrow('time base');
 expect(()=>maskedMergeVideoFrames(three({...tight(),pts:{value:1n,timeBase:{num:1n,den:25n}}}),step,{maxFrameBytes:64})).toThrow('synchronized');expect(()=>maskedMergeVideoFrames(three({...tight(),pts:null}),step,{maxFrameBytes:64})).toThrow('synchronized');
 expect(maskedMergeVideoFrames(three({...tight(),pts:{value:18014398509481986n,timeBase:{num:1n,den:50n}}}),step,{maxFrameBytes:64}).pts!.value).toBe(9007199254740993n);
 expect(()=>maskedMergeVideoFrames(three(gray(new Uint8Array(4),2,2)),step,{maxFrameBytes:64})).toThrow('sizes differ');expect(()=>maskedMergeVideoFrames([tight(),tight()],step,{maxFrameBytes:64})).toThrow('base, overlay and mask');
 for(const planes of [-1,16,0.5])expect(()=>maskedMergeVideoFrames([tight(),tight(),tight()],{name:'maskedmerge',planes,shortest:false},{maxFrameBytes:64}),String(planes)).toThrow('Invalid maskedmerge settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>maskedMergeVideoFrames([tight(),tight(),tight()],step,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('refuses the linear path, plans the graph paths, refuses size mismatches before frames and refuses runtime commands',async()=>{
 for(const description of ['maskedmerge','null,maskedmerge','maskedmerge=planes=1'])expect(()=>compileVideoFilterChain(description),description).toThrow();
 const graph=compileVideoFilterGraph('[0:v]split=3[a][b][c];[a][b][c]maskedmerge=planes=1[o]').plan({format:'gray',width:5,height:3},[null],{arithmetic:'scalar'});
 const frame=gray(Uint8Array.from({length:15},(_,i)=>i*17),5,3),[merged]=graph.apply(frame,{maxFrameBytes:15,maxStateBytes:graph.stateBytes,maxResidentBytes:1<<16});expect([...merged!.planes[0]!]).toEqual([...frame.planes[0]!]);
 expect(()=>compileVideoFilterGraph('[0:v]split=3[a][b][c];[c]scale=4:3[d];[a][b][d]maskedmerge[o]').plan({format:'gray',width:5,height:3},[null],{arithmetic:'scalar'})).toThrow('Maskedmerge input sizes differ');
 expect(()=>compileMultiInputVideoFilterGraph('[0:v][1:v][2:v]maskedmerge[o]').plan([{format:'gray',width:5,height:3},{format:'gray',width:5,height:3},{format:'gray',width:5,height:2}],[null],{arithmetic:'scalar'})).toThrow('Maskedmerge input sizes differ');
 expect(()=>compileVideoFilterGraph('[0:v]split=3[a][b][c];[a][b][c]maskedmerge=shortest=1[o]')).toThrow('Unsupported maskedmerge option');expect(()=>createFrameActors('split=3[a][b][c];[a][b][c]maskedmerge=enable=1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
 expect(()=>compileVideoFilterGraph('[0:v]split[a][b];[a][b]maskedmerge[o]')).toThrow();
 const actors=createFrameActors('split=3[a][b][c];[a][b][c]maskedmerge',{maxSteps:256,maxQueuedFrames:4,maxQueuedBytes:1<<12,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry:{format:'gray',width:5,height:3}}]});
 try{for(const [command,argument]of [['planes','0'],['enable','0']] as const)expect(actors.sendFilterCommand('maskedmerge',command,argument).code,command).toBe(command==='enable'?-1163346256:-38);
  actors.sendFrameInput(0,{kind:'frame',duration:1n,frame});actors.endInput(0,-541478725,1n);const result=await actors.readFrame(0);expect(result.code).toBe(0);expect([...result.event!.frame.planes[0]!]).toEqual([...frame.planes[0]!]);}finally{actors.dispose();}
});
