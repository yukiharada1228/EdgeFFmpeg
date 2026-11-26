import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,compileMultiInputVideoFilterGraph,videoOperator} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
import {maskedclampOperator,maskedclampPixelFormats,maskedclampGeometry,maskedclampVideoFrames,parseMaskedclampOptions} from '../../packages/avfilter/src/video-ops/maskedclamp.js';
import {VideoFilterParseError} from '../../packages/avfilter/src/video-ops/descriptor.js';
const gray=(data:Uint8Array,width:number,height:number,stride=width,pts=9007199254740993n):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:pts,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
it('parses declared defaults, shorthand, integer expressions and ranges and refuses framesync, timeline and generic options',()=>{
 expect(parseMaskedclampOptions(null)).toEqual({name:'maskedclamp',undershoot:0,overshoot:0,planes:15,shortest:false});expect(Object.isFrozen(parseMaskedclampOptions(''))).toBe(true);
 expect(parseMaskedclampOptions('5:7:1')).toEqual({name:'maskedclamp',undershoot:5,overshoot:7,planes:1,shortest:false});expect(parseMaskedclampOptions('planes=6:overshoot=2:undershoot=3')).toMatchObject({undershoot:3,overshoot:2,planes:6});
 expect(parseMaskedclampOptions('undershoot=1:undershoot=9').undershoot).toBe(9);expect(parseMaskedclampOptions('undershoot=0x10:overshoot=2*100').overshoot).toBe(200);expect(parseMaskedclampOptions('undershoot=2.5').undershoot).toBe(2);expect(parseMaskedclampOptions('undershoot=3.5').undershoot).toBe(4);
 expect(parseMaskedclampOptions('65535:65535:0')).toMatchObject({undershoot:65535,overshoot:65535,planes:0});expect(parseMaskedclampOptions('undershoot=max:overshoot=min:planes=default')).toMatchObject({undershoot:65535,overshoot:0,planes:15});
 for(const [options,message]of [['undershoot=-1','Invalid maskedclamp undershoot'],['undershoot=65536','Invalid maskedclamp undershoot'],['overshoot=70000','Invalid maskedclamp overshoot'],['planes=16','Invalid maskedclamp planes'],['planes=-1','Invalid maskedclamp planes'],['undershoot=abc','Invalid maskedclamp undershoot'],['overshoot=','Invalid maskedclamp overshoot'],
  ['enable=1','timeline'],['enable=between(t,0,1)','timeline'],['shortest=1','Unsupported maskedclamp option'],['shortest=0','Unsupported maskedclamp option'],['eof_action=repeat','Unsupported maskedclamp option'],['repeatlast=1','Unsupported maskedclamp option'],['ts_sync_mode=default','Unsupported maskedclamp option'],['threads=1','Unsupported maskedclamp option'],['foo=1','Unsupported maskedclamp option'],['1:2:3:4',''],['undershoot=1:2','']] as const)expect(()=>parseMaskedclampOptions(options),options).toThrow(message);
 expect(()=>parseMaskedclampOptions('planes=16')).toThrow(VideoFilterParseError);
 // The pinned vf_maskedclamp.c pix_fmts in declared order.
 expect(maskedclampPixelFormats).toEqual('yuva444p yuv444p yuv440p yuvj444p yuvj440p yuva422p yuv422p yuva420p yuv420p yuvj422p yuvj420p yuvj411p yuv411p yuv410p yuv420p9le yuv422p9le yuv444p9le yuv420p10le yuv422p10le yuv444p10le yuv420p12le yuv422p12le yuv444p12le yuv440p12le yuv420p14le yuv422p14le yuv444p14le yuv420p16le yuv422p16le yuv444p16le yuva420p9le yuva422p9le yuva444p9le yuva420p10le yuva422p10le yuva444p10le yuva422p12le yuva444p12le yuva420p16le yuva422p16le yuva444p16le gbrp gbrp9le gbrp10le gbrp12le gbrp14le gbrp16le gbrap gbrap10le gbrap12le gbrap16le gray gray9le gray10le gray12le gray14le gray16le'.split(' '));
 expect(maskedclampOperator.formats!(parseMaskedclampOptions(null))).toBe(maskedclampPixelFormats);expect(Object.isFrozen(maskedclampPixelFormats)).toBe(true);
 expect(videoOperator('maskedclamp')).toBe(maskedclampOperator);expect(maskedclampOperator.role).toBe('join');expect(maskedclampOperator.paths).toEqual(['graph','stream','actor','timed']);expect(maskedclampOperator.timeline).toBeUndefined();expect(maskedclampOperator.geometryCommands).toBeUndefined();
 expect(maskedclampOperator.parse!({name:'maskedclamp',options:'1:2',inputs:[],outputs:[]} as never)).toMatchObject({inputs:3,outputs:1});
});
it('keeps the base size and refuses differing sizes, formats and input counts in geometry',()=>{
 const shape=(width:number,height:number,format='gray')=>({format,width,height});
 expect(maskedclampGeometry([shape(5,3),shape(5,3),shape(5,3)])).toEqual({width:5,height:3});
 expect(()=>maskedclampGeometry([shape(5,3),shape(5,3),shape(3,5)])).toThrow('Maskedclamp input sizes differ: base 5x3, dark 5x3, bright 3x5');expect(()=>maskedclampGeometry([shape(5,3),shape(5,2),shape(5,3)])).toThrow('dark 5x2');
 expect(()=>maskedclampGeometry([shape(5,3),shape(5,3,'yuv420p'),shape(5,3)])).toThrow('Maskedclamp input formats differ');expect(()=>maskedclampGeometry([shape(5,3),shape(5,3)])).toThrow('three inputs');
});
it('clamps base between dark-undershoot and bright+overshoot with bright winning crossed bounds, into owned tight planes without mutating padded input',()=>{
 const base=Uint8Array.of(0,100,255,99,16,235,240,99),dark=Uint8Array.of(10,120,250,7,200,0,100,7),bright=Uint8Array.of(20,110,255,7,50,240,250,7),frames=[gray(base,3,2,4),gray(dark,3,2,4),gray(bright,3,2,4)];
 const actual=maskedclampVideoFrames(frames,parseMaskedclampOptions(null),{maxFrameBytes:8});
 // max(b, d) then min(.., l): sample 1 has dark 120 > bright 110, so 110; sample 4 has dark 200 > bright 50, so 50.
 expect([...actual.planes[0]!]).toEqual([10,110,255,50,235,240]);expect(actual.linesizes).toEqual([3]);expect(actual.pts).toEqual(frames[0]!.pts);expect(actual.pts).not.toBe(frames[0]!.pts);expect(actual.metadata).toEqual({colorRange:2});expect(actual.metadata).not.toBe(frames[0]!.metadata);
 expect([...base]).toEqual([0,100,255,99,16,235,240,99]);expect([...dark]).toEqual([10,120,250,7,200,0,100,7]);expect([...bright]).toEqual([20,110,255,7,50,240,250,7]);
 expect([...maskedclampVideoFrames(frames,parseMaskedclampOptions('5:5'),{maxFrameBytes:8}).planes[0]!]).toEqual([5,115,255,55,235,240]);
 expect([...maskedclampVideoFrames(frames,parseMaskedclampOptions('255:255'),{maxFrameBytes:8}).planes[0]!]).toEqual([0,100,255,16,235,240]);
 expect([...maskedclampVideoFrames(frames,parseMaskedclampOptions('65535:0'),{maxFrameBytes:8}).planes[0]!]).toEqual([0,100,255,16,235,240]);
 const copy=maskedclampVideoFrames(frames,parseMaskedclampOptions('0:0:0'),{maxFrameBytes:8});expect([...copy.planes[0]!]).toEqual([0,100,255,16,235,240]);expect(copy.planes[0]!.buffer).not.toBe(base.buffer);
 const plane=(...values:number[])=>values.map(value=>Uint8Array.of(value)),yuva=(values:number[]):VideoFrameData=>({width:1,height:1,pixelFormat:'yuva420p',planes:plane(...values),linesizes:[1,1,1,1],pts:null,metadata:{}});
 const quad=[yuva([1,2,250,251]),yuva([10,10,10,10]),yuva([200,200,200,200])];
 expect(maskedclampVideoFrames(quad,parseMaskedclampOptions('planes=5'),{maxFrameBytes:4}).planes.map(value=>value[0])).toEqual([10,2,200,251]);expect(maskedclampVideoFrames(quad,parseMaskedclampOptions('planes=8'),{maxFrameBytes:4}).planes.map(value=>value[0])).toEqual([1,2,250,200]);
 expect(maskedclampVideoFrames(quad,parseMaskedclampOptions(null),{maxFrameBytes:4}).pts).toBeNull();
 expect(maskedclampVideoFrames([gray(Uint8Array.of(5),1,1,1,-(1n<<63n)),gray(Uint8Array.of(0),1,1),gray(Uint8Array.of(9),1,1)],parseMaskedclampOptions(null),{maxFrameBytes:1}).pts!.value).toBe(-(1n<<63n)+1n);
});
it('rejects unsupported layouts, budgets, malformed storage, settings and cancellation explicitly',()=>{
 const step=parseMaskedclampOptions(null),three=(frame:VideoFrameData)=>[frame,gray(new Uint8Array(6),3,2),gray(new Uint8Array(6),3,2)];
 for(const pixelFormat of ['nv12','rgb24','rgba','bgr24'])expect(()=>maskedclampVideoFrames([0,1,2].map(()=>({width:2,height:2,pixelFormat,planes:[],linesizes:[],pts:null,metadata:{}})),step,{maxFrameBytes:64}),pixelFormat).toThrow('not supported');
 expect(()=>maskedclampVideoFrames(three(gray(new Uint8Array(6),3,2)),step,{maxFrameBytes:5})).toThrow('allocation limit');expect(()=>maskedclampVideoFrames(three(gray(new Uint8Array(8),3,2,4)),step,{maxFrameBytes:7})).toThrow('storage exceeds');expect(()=>maskedclampVideoFrames(three(gray(new Uint8Array(6),3,2)),step,{maxFrameBytes:0})).toThrow('allocation limit');
 expect(()=>maskedclampVideoFrames(three(gray(new Uint8Array(5),3,2)),step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>maskedclampVideoFrames(three(gray(new Uint8Array(6),3,2,2)),step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>maskedclampVideoFrames(three(gray(new Uint8Array(6),3,2,3.5)),step,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>maskedclampVideoFrames([gray(new Uint8Array(6),3,2),gray(new Uint8Array(5),3,2),gray(new Uint8Array(6),3,2)],step,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>maskedclampVideoFrames([gray(new Uint8Array(6),3,2),gray(new Uint8Array(6),3,2),gray(new Uint8Array(6),3,2,1)],step,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>maskedclampVideoFrames(three({...gray(new Uint8Array(6),3,2),planes:[]}),step,{maxFrameBytes:64})).toThrow('plane count');expect(()=>maskedclampVideoFrames(three({...gray(new Uint8Array(6),3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}}),step,{maxFrameBytes:64})).toThrow('time base');
 expect(()=>maskedclampVideoFrames([gray(new Uint8Array(6),3,2),gray(new Uint8Array(6),2,3)],step,{maxFrameBytes:64})).toThrow('three');expect(()=>maskedclampVideoFrames([gray(new Uint8Array(6),3,2),gray(new Uint8Array(6),2,3),gray(new Uint8Array(6),3,2)],step,{maxFrameBytes:64})).toThrow('sizes differ');
 for(const bad of [{undershoot:-1,overshoot:0,planes:1},{undershoot:0,overshoot:65536,planes:1},{undershoot:0,overshoot:4,planes:16},{undershoot:0.5,overshoot:4,planes:1}])expect(()=>maskedclampVideoFrames(three(gray(new Uint8Array(6),3,2)),{name:'maskedclamp',shortest:false,...bad},{maxFrameBytes:64}),JSON.stringify(bad)).toThrow('Invalid maskedclamp settings');
 expect(()=>maskedclampVideoFrames(three(gray(new Uint8Array(6),3,2)),{...step,shortest:true} as never,{maxFrameBytes:64})).toThrow('Invalid maskedclamp settings');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>maskedclampVideoFrames(three(gray(new Uint8Array(6),3,2)),step,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans maskedclamp on graph paths, refuses linear chains, size mismatches before frames and runtime commands',async()=>{
 const plan=compileVideoFilterGraph('[0:v]split=3[a][b][c];[b]hflip[d];[c]vflip[e];[a][d][e]maskedclamp=0:0[o]').plan({format:'gray',width:3,height:2},[null]),source=gray(Uint8Array.of(9,1,200,30,40,50),3,2,3,0n);
 expect([...plan.apply(source,{maxFrameBytes:64,maxStateBytes:plan.stateBytes,maxResidentBytes:1<<16})[0]!.planes[0]!]).toEqual([30,1,50,9,1,50]);
 for(const description of ['maskedclamp','null,maskedclamp','maskedclamp,null'])expect(()=>compileVideoFilterChain(description),description).toThrow();
 expect(()=>compileVideoFilterGraph('[0:v]split=3[a][b][c];[c]scale=4:2[d];[a][b][d]maskedclamp[o]').plan({format:'gray',width:3,height:2},[null])).toThrow('Maskedclamp input sizes differ');
 expect(()=>compileMultiInputVideoFilterGraph('[0:v][1:v][2:v]maskedclamp[o]').plan([{format:'gray',width:3,height:2},{format:'gray',width:3,height:2},{format:'gray',width:2,height:3}],[null])).toThrow('Maskedclamp input sizes differ: base 3x2, dark 3x2, bright 2x3');
 expect(()=>compileVideoFilterGraph('[0:v]split=3[a][b][c];[a][b][c]maskedclamp=shortest=1[o]')).toThrow('Unsupported maskedclamp option');expect(()=>createFrameActors('split=3[a][b][c];[a][b][c]maskedclamp=enable=gte(t\\,1)',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow('timeline');
 const actors=createFrameActors('split=3[a][b][c];[a][b][c]maskedclamp=0:0',{maxSteps:256,maxQueuedFrames:4,maxQueuedBytes:1<<12,maxFrameBytes:64,numericProfile:'linux-x64',inputs:[{timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},geometry:{format:'gray',width:3,height:2}}]});
 try{for(const [command,argument]of [['undershoot','0'],['overshoot','10'],['planes','0'],['enable','0']] as const)expect(actors.sendFilterCommand('maskedclamp',command,argument).code,command).toBe(command==='enable'?-1163346256:-38);
  actors.sendFrameInput(0,{kind:'frame',duration:1n,frame:source});actors.endInput(0,-541478725,1n);const result=await actors.readFrame(0);expect(result.code).toBe(0);expect([...result.event!.frame.planes[0]!]).toEqual([9,1,200,30,40,50]);}finally{actors.dispose();}
});
