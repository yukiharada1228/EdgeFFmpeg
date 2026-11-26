import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {parseThresholdOptions,thresholdGeometry,thresholdOperator,thresholdPixelFormats,thresholdVideoFrames} from '../../packages/avfilter/src/video-ops/threshold.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
const time={num:1n,den:25n};
const gray=(values:readonly number[],width:number,height:number,stride=width,pts:VideoFrameData['pts']={value:9007199254740993n,timeBase:time}):VideoFrameData=>{const data=new Uint8Array(stride*(height-1)+width).fill(77);for(let y=0;y<height;y++)for(let x=0;x<width;x++)data[y*stride+x]=values[y*width+x]!;return {width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts,metadata:{colorRange:2}};};
const planar=(format:string,width:number,height:number,seed:number):VideoFrameData=>{const layout=pixelLayout(format,width,height);return {width,height,pixelFormat:format,planes:layout.planes.map((plane,p)=>Uint8Array.from({length:plane.bytes},(_,i)=>(i*29+p*71+seed*53)&255)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:null,metadata:{}};};
const budget={maxFrameBytes:4096};
it('parses planes with integer expressions and ranges and refuses shortest, enable= and every other option',()=>{
 expect(parseThresholdOptions(null)).toEqual({name:'threshold',planes:15,shortest:true});expect(Object.isFrozen(parseThresholdOptions(''))).toBe(true);
 expect(parseThresholdOptions('1').planes).toBe(1);expect(parseThresholdOptions('planes=5').planes).toBe(5);expect(parseThresholdOptions('planes=0x3').planes).toBe(3);expect(parseThresholdOptions('planes=2*3').planes).toBe(6);
 expect(parseThresholdOptions('planes=max').planes).toBe(15);expect(parseThresholdOptions('planes=min').planes).toBe(0);expect(parseThresholdOptions('planes=default').planes).toBe(15);expect(parseThresholdOptions('planes=1:planes=4').planes).toBe(4);expect(parseThresholdOptions('planes=2.5').planes).toBe(2);
 for(const [options,message]of [['planes=16','Invalid threshold planes'],['planes=-1','Invalid threshold planes'],['planes=abc','Invalid threshold planes'],['planes=','Invalid threshold planes'],['shortest=1','Unsupported threshold option'],['shortest=0','Unsupported threshold option'],['repeatlast=0','Unsupported threshold option'],['eof_action=endall','Unsupported threshold option'],['ts_sync_mode=nearest','Unsupported threshold option'],['threads=1','Unsupported threshold option'],['enable=1','timeline'],['enable=between(t,0,1)','timeline'],['1:2','Missing filter option name']] as const)expect(()=>parseThresholdOptions(options),options).toThrow(message);
 expect(()=>parseThresholdOptions('shortest=1')).toThrow(VideoFilterParseError);
 // The pinned vf_threshold.c pix_fmts in declared order.
 expect(thresholdPixelFormats).toEqual('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv440p10le yuv444p10le yuv420p12le yuv422p12le yuv440p12le yuv444p12le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
 expect(thresholdOperator.formats!(parseThresholdOptions(null))).toBe(thresholdPixelFormats);expect(Object.isFrozen(thresholdPixelFormats)).toBe(true);
 expect(videoOperator('threshold')).toBe(thresholdOperator);expect(thresholdOperator.role).toBe('join');expect(thresholdOperator.paths).toEqual(['graph','stream','actor','timed']);expect(thresholdOperator.timeline).toBeUndefined();expect(thresholdOperator.geometryCommands).toBeUndefined();expect(thresholdOperator.jpegSiblings).toBeUndefined();
 expect(thresholdOperator.parse!({name:'threshold',options:'planes=3',inputs:[],outputs:[]} as never)).toEqual({inputs:4,outputs:1,configuration:{name:'threshold',planes:3,shortest:true}});
});
it('selects min where in <= threshold and max otherwise, with ties, into owned tight planes without mutating padded inputs',()=>{
 const input=gray([0,100,255,50,128,200],3,2,4),limit=gray([0,99,255,51,128,0],3,2,5),low=gray([10,11,12,13,14,15],3,2),high=gray([20,21,22,23,24,25],3,2,6);
 const snapshot=[input,limit,low,high].map(frame=>frame.planes[0]!.slice()),output=thresholdVideoFrames([input,limit,low,high],parseThresholdOptions(null),budget);
 // Ties (0<=0, 255<=255, 128<=128) take min.
 expect([...output.planes[0]!]).toEqual([10,21,12,13,14,25]);expect(output.linesizes).toEqual([3]);expect(output.pts).toEqual(input.pts);expect(output.pts).not.toBe(input.pts);expect(output.metadata).toEqual({colorRange:2});expect(output.metadata).not.toBe(input.metadata);
 [input,limit,low,high].forEach((frame,index)=>expect(frame.planes[0]).toEqual(snapshot[index]));for(const frame of [input,limit,low,high])expect(output.planes[0]!.buffer).not.toBe(frame.planes[0]!.buffer);
 // planes=0 copies the first input.
 const copy=thresholdVideoFrames([input,limit,low,high],parseThresholdOptions('0'),budget);expect([...copy.planes[0]!]).toEqual([0,100,255,128,200].slice(0,3).concat([50,128,200]));expect(copy.planes[0]!.buffer).not.toBe(input.planes[0]!.buffer);
 // Masks follow the plane index; bit 3 has no plane in yuv420p and is ignored.
 const frames=[0,1,2,3].map(seed=>planar('yuv420p',3,3,seed)),masked=(planes:number)=>thresholdVideoFrames(frames,parseThresholdOptions(String(planes)),budget);
 const select=(p:number)=>[...frames[0]!.planes[p]!].map((value,i)=>value<=frames[1]!.planes[p]![i]!?frames[2]!.planes[p]![i]!:frames[3]!.planes[p]![i]!);
 for(const planes of [0,1,2,4,5,7,8,15])expect(masked(planes).planes.map(plane=>[...plane]),String(planes)).toEqual([0,1,2].map(p=>planes>>p&1?select(p):[...frames[0]!.planes[p]!]));
 const yuva=[0,1,2,3].map(seed=>planar('yuva420p',2,2,seed));expect([...thresholdVideoFrames(yuva,parseThresholdOptions('8'),budget).planes[3]!]).toEqual([...yuva[0]!.planes[3]!].map((value,i)=>value<=yuva[1]!.planes[3]![i]!?yuva[2]!.planes[3]![i]!:yuva[3]!.planes[3]![i]!));
 // A null timestamp passes through; MIN is clamped as the synchronized event rescale does.
 expect(thresholdVideoFrames(frames,parseThresholdOptions(null),budget).pts).toBeNull();const min={value:-(1n<<63n),timeBase:time};expect(thresholdVideoFrames([0,1,2,3].map(()=>gray([1],1,1,1,min)),parseThresholdOptions(null),budget).pts!.value).toBe(-(1n<<63n)+1n);
});
it('refuses size and format mismatches, layouts, budgets, malformed storage, settings, timestamps and cancellation explicitly',()=>{
 const step=parseThresholdOptions(null),a=gray([1,2,3,4,5,6],3,2);
 expect(thresholdGeometry([{format:'gray',width:3,height:2},{format:'gray',width:3,height:2},{format:'gray',width:3,height:2},{format:'gray',width:3,height:2}])).toEqual({width:3,height:2});
 for(const shape of [{format:'gray',width:2,height:2},{format:'gray',width:3,height:1}])expect(()=>thresholdGeometry([{format:'gray',width:3,height:2},{format:'gray',width:3,height:2},shape,{format:'gray',width:3,height:2}])).toThrow('Threshold input sizes differ');
 expect(()=>thresholdGeometry([{format:'gray',width:3,height:2},{format:'yuv444p',width:3,height:2},{format:'gray',width:3,height:2},{format:'gray',width:3,height:2}])).toThrow('formats differ');expect(()=>thresholdGeometry([{format:'gray',width:3,height:2}])).toThrow('four inputs');
 expect(()=>thresholdVideoFrames([a,a,a],step,budget)).toThrow('four inputs');expect(()=>thresholdVideoFrames([a,a,a,gray([1,2],2,1)],step,budget)).toThrow('sizes differ');
 for(const pixelFormat of ['nv12','rgb24','rgba','bgr24'])expect(()=>thresholdVideoFrames(Array(4).fill(planar(pixelFormat,2,2,1)),step,budget),pixelFormat).toThrow('not supported');
 expect(()=>thresholdVideoFrames([a,a,a,a],step,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>thresholdVideoFrames([a,a,a,a],step,{maxFrameBytes:0})).toThrow('allocation limit');const padded=gray([1,2,3,4,5,6],3,2,4);expect(()=>thresholdVideoFrames([a,a,a,padded],step,{maxFrameBytes:6})).toThrow('storage exceeds');
 expect(()=>thresholdVideoFrames([a,{...a,planes:[new Uint8Array(5)]},a,a],step,budget)).toThrow('stride or storage');expect(()=>thresholdVideoFrames([a,a,{...a,linesizes:[2]},a],step,budget)).toThrow('stride or storage');expect(()=>thresholdVideoFrames([a,a,a,{...a,linesizes:[3.5]}],step,budget)).toThrow('stride or storage');
 expect(()=>thresholdVideoFrames([a,{...a,planes:[]},a,a],step,budget)).toThrow('plane count');expect(()=>thresholdVideoFrames([a,a,{...a,pts:{value:0n,timeBase:{num:0n,den:1n}}},a],step,budget)).toThrow('Invalid threshold timestamp');
 expect(()=>thresholdVideoFrames([a,a,a,{...a,pts:{value:0n,timeBase:time}}],step,budget)).toThrow('synchronized');expect(()=>thresholdVideoFrames([a,a,a,{...a,pts:null}],step,budget)).toThrow('synchronized');
 expect(thresholdVideoFrames([a,{...a,pts:{value:a.pts!.value*2n,timeBase:{num:1n,den:50n}}},a,a],step,budget).pts).toEqual(a.pts);
 for(const bad of [{planes:16},{planes:-1},{planes:0.5}])expect(()=>thresholdVideoFrames([a,a,a,a],{...step,...bad},budget),JSON.stringify(bad)).toThrow('Invalid threshold settings');expect(()=>thresholdVideoFrames([a,a,a,a],{...step,shortest:false} as never,budget)).toThrow('Invalid threshold settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>thresholdVideoFrames([a,a,a,a],step,{...budget,signal:controller.signal})).toThrow('stop');
});
it('plans the join on graph and timed paths, refuses linear chains, size mismatches, option errors and runtime commands',async()=>{
 expect(()=>compileVideoFilterChain('threshold')).toThrow('Unsupported video filter');
 const plan=compileVideoFilterGraph('[0:v]split=4[a][b][c][d];[a][b][c][d]threshold=planes=1[o]').plan({format:'gray',width:3,height:2},[null]);
 const source=gray([0,100,255,50,128,200],3,2),output=plan.apply(source,{maxFrameBytes:4096,maxStateBytes:1<<16,maxResidentBytes:1<<20})[0]!;expect([...output.planes[0]!]).toEqual([0,100,255,50,128,200]);
 expect(plan.negotiated.nodes.find(node=>node.inputs.length===4)!.inputs.map(input=>input.format)).toEqual(['gray','gray','gray','gray']);
 expect(compileVideoFilterGraph('[0:v]split=4[a][b][c][d];[a][b][c][d]threshold[o]').plan({format:'nv12',width:4,height:2},[null]).negotiated.nodes.find(node=>node.inputs.length===4)!.inputs[0]!.format).toBe('yuv420p');
 expect(()=>compileVideoFilterGraph('[0:v]split=4[a][b][c][d];[a]scale=2:2[e];[e][b][c][d]threshold[o]').plan({format:'gray',width:3,height:2},[null])).toThrow('Threshold input sizes differ');
 expect(()=>compileVideoFilterGraph('[0:v]split=4[a][b][c][d];[a][b][c][d]threshold=shortest=1[o]')).toThrow('Unsupported threshold option');expect(()=>compileVideoFilterGraph('[0:v]split=4[a][b][c][d];[a][b][c][d]threshold=enable=1[o]')).toThrow('timeline');
 expect(()=>planTimedVideoGraph('split=4[a][b][c][d];[a][b][c][d]threshold=planes=99',[{geometry:{format:'gray',width:3,height:2},timeBase:time,frameRate:{num:25n,den:1n}}],[null])).toThrow('Invalid threshold planes');
 expect(planTimedVideoGraph('split=4[a][b][c][d];[a][b][c][d]threshold',[{geometry:{format:'gray',width:3,height:2},timeBase:time,frameRate:{num:25n,den:1n}}],[null]).statefulNodes.length).toBeGreaterThan(0);
 const actors=createFrameActors('split=4[a][b][c][d];[a][b][c][d]threshold',{maxSteps:256,maxQueuedFrames:8,maxQueuedBytes:1<<14,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:time,frameRate:{num:25n,den:1n},geometry:{format:'gray',width:3,height:2}}]});
 try{for(const [command,argument]of [['planes','0'],['enable','0']] as const)expect(actors.sendFilterCommand('threshold',command,argument).code,command).toBeLessThan(0);
  actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:{...source,pts:{value:0n,timeBase:time}}});actors.endInput(0,-541478725,1n);const result=await actors.readFrame(0);expect(result.code).toBe(0);expect([...result.event!.frame.planes[0]!]).toEqual([0,100,255,50,128,200]);}finally{actors.dispose();}
});
