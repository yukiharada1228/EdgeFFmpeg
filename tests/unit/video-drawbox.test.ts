import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,createReplayVideoExecution} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {drawboxGeometry,drawboxNativeFormats,drawboxPixelFormats,drawboxVideoFrame,drawboxYuvColor,parseDrawboxOptions,VideoDrawboxError} from '../../packages/avfilter/src/video-drawbox.js';
import {drawboxOperator} from '../../packages/avfilter/src/video-ops/drawbox.js';
import {drawgridOperator} from '../../packages/avfilter/src/video-ops/drawgrid.js';
import {createFrameActors} from '../../packages/avfilter/src/activation/actors.js';
const frame=(pixelFormat:string,width:number,height:number,planes:Uint8Array[],linesizes:number[]):VideoFrameData=>({width,height,pixelFormat,planes,linesizes,pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:1}});
const box=(options:string|null)=>parseDrawboxOptions('drawbox',options),grid=(options:string|null)=>parseDrawboxOptions('drawgrid',options);
const rows=(data:Uint8Array,width:number)=>Array.from({length:data.length/width},(_,y)=>[...data.subarray(y*width,(y+1)*width)]);
it('parses declared defaults, shorthand, aliases, booleans and colours into frozen settings',()=>{
 expect(box(null)).toEqual({x:'0',y:'0',width:'0',height:'0',thickness:'3',color:'black',rgba:[0,0,0,255],invert:false,replace:false});expect(grid(null).thickness).toBe('1');
 expect(Object.isFrozen(box(''))).toBe(true);expect(Object.isFrozen(box(null).rgba)).toBe(true);
 expect(box('1:2:3:4:red@0.5:5:1')).toEqual({x:'1',y:'2',width:'3',height:'4',thickness:'5',color:'red@0.5',rgba:[255,0,0,127],invert:false,replace:true});
 expect(box('w=5:width=6:h=7:height=8:c=0x10203040:t=fill:replace=false')).toMatchObject({width:'6',height:'8',thickness:'fill',rgba:[16,32,48,64],replace:false});
 expect(box('c=invert').invert).toBe(true);expect(()=>box('c=Invert')).toThrow("Cannot find color 'Invert'");
 expect(box('x=iw/2-w/2:y=ih-h:w=in_w/3:h=fill:t=hypot(2,3)+log(2)+if(gt(x,1),1,2)').x).toBe('iw/2-w/2');
 for(const [options,message]of [['box_source=side_data_detection_bboxes','box_source is not implemented'],['1:1:1:1:red:1:0:side_data_detection_bboxes','box_source is not implemented'],['enable=1','timeline'],['threads=1','Unsupported drawbox option'],['c=nosuch',"Cannot find color 'nosuch'"],['c=random','is not supported'],['c=red@nan','is not supported'],['c=red@1.5','Invalid alpha'],['replace=2','replace'],['x=sin(1)','sin()'],['w=sinh(1)','sinh()'],['h=pow(2,2)','pow()'],['t=random(0)','random()'],['x=lerp(1,2,0.5)','lerp()'],['x=exp(1)','exp()'],['y=sar*2','sar or dar'],['y=dar','sar or dar'],['x=nosuch',"Error when evaluating the expression 'nosuch'."],['x=1+','expression'],['1:2:3:4:red:1:0:x:9','Missing filter option name']] as const)expect(()=>box(options),options).toThrow(message);
 expect(()=>grid('box_source=x')).toThrow('Unsupported drawgrid option');expect(()=>grid('1:1:1:1:red:1:0:x')).toThrow();expect(()=>grid('enable=1')).toThrow('Drawgrid timeline');
 expect(()=>box('c=nosuch')).toThrow(VideoDrawboxError);
});
it('prepares CCIR colours and resolves config_input geometry with the native iteration',()=>{
 expect(drawboxYuvColor([0,0,0,255])).toEqual([16,128,128,255]);expect(drawboxYuvColor([255,255,255,7])).toEqual([235,128,128,7]);expect(drawboxYuvColor([255,0,0,255])).toEqual([81,90,240,255]);
 expect(drawboxGeometry('drawbox',box(null),'yuv420p',8,6)).toEqual({x:0,y:0,w:8,h:6,t:3,hsub:1,vsub:1});
 expect(drawboxGeometry('drawbox',box('x=iw/2-w/2:y=ih-h:w=iw/3:h=fill-1:t=fill'.replace('fill-1','6')),'yuv422p',9,7)).toEqual({x:3,y:1,w:3,h:6,t:2147483647,hsub:1,vsub:0});
 // w reads x before x converges: iteration passes refine the doubles, not the truncated ints.
 expect(drawboxGeometry('drawbox',box('x=w/2:w=7.9:y=-2.5:h=-1:t=hsub+vsub+0.9'),'yuva420p',8,6)).toMatchObject({x:3,y:-2,w:7,h:6,t:2});
 expect(drawboxGeometry('drawgrid',grid('x=-3:y=fill:w=0.5:h=4'),'rgb24',8,6)).toEqual({x:-3,y:6,w:8,h:4,t:1,hsub:0,vsub:0});
 expect(()=>drawboxGeometry('drawbox',box('x=x'),'rgba',8,6)).toThrow("Error when evaluating the expression 'x'.");
 expect(()=>drawboxGeometry('drawbox',box('w=1e10'),'rgba',8,6)).toThrow('outside the int range');expect(()=>drawboxGeometry('drawbox',box('t=1/0'),'rgba',8,6)).toThrow('outside the int range');
 expect(()=>drawboxGeometry('drawbox',box('x=2147483000:w=1000'),'rgba',8,6)).toThrow('overflows int');expect(()=>drawboxGeometry('drawgrid',grid('x=-2147483647'),'rgba',8,6)).toThrow('overflows int');
 expect(()=>drawboxGeometry('drawbox',box('x=w-1:w=fill'),'rgba',8,6)).toThrow('undefined integer conversion');expect(()=>drawboxGeometry('drawbox',box('y=ih-h:h=fill-1'),'rgba',8,6)).toThrow('undefined integer conversion');
 expect(()=>drawboxGeometry('drawbox',box(null),'yuv411p',8,6)).toThrow('not supported');expect(()=>drawboxGeometry('drawbox',box(null),'gray',8,6)).toThrow('not supported');
 expect(drawboxPixelFormats).toEqual(['yuv444p','yuv422p','yuv420p','yuvj444p','yuvj422p','yuvj420p','yuva420p','rgb24','bgr24','rgba','bgra','argb','abgr']);
});
it('draws boxes and grids into owned tight planes from padded input without mutating it',()=>{
 const input=Uint8Array.from({length:4*6},(_,i)=>i%6>=4?99:i*9),snapshot=[...input],gray=frame('yuv444p',4,4,[input,new Uint8Array(24).fill(128),new Uint8Array(24).fill(128)],[6,6,6]);
 const out=drawboxVideoFrame('drawbox',gray,box('1:1:3:2:white:1'),{maxFrameBytes:72});
 expect(rows(out.planes[0]!,4)).toEqual([[0,9,18,27],[54,235,235,235],[108,235,235,235],[162,171,180,189]]);expect(out.linesizes).toEqual([4,4,4]);
 expect(out.pts).toEqual(gray.pts);expect(out.pts).not.toBe(gray.pts);expect(out.metadata).toEqual({colorRange:1});expect(out.planes[0]!.buffer).not.toBe(input.buffer);expect([...input]).toEqual(snapshot);
 const inverted=drawboxVideoFrame('drawgrid',gray,grid('w=2:h=3:c=invert'),{maxFrameBytes:72});expect(rows(inverted.planes[0]!,4)).toEqual([[255,246,237,228],[201,63,183,81],[147,117,129,135],[93,84,75,66]]);expect([...inverted.planes[1]!]).toEqual(new Array(16).fill(128));
 // Translucent YUV blends in double and truncates; subsampled chroma is blended once per covered luma sample.
 const yuv=frame('yuv420p',2,2,[Uint8Array.of(100,100,100,100),Uint8Array.of(200),Uint8Array.of(50)],[2,1,1]),half=drawboxVideoFrame('drawbox',yuv,box('c=white@0x80'),{maxFrameBytes:6});
 const a=128/255,once=(p:number,c:number)=>Math.trunc((1-a)*p+a*c);let u=200,v=50;for(let n=0;n<4;n++){u=once(u,128);v=once(v,128);}
 expect([...half.planes[0]!]).toEqual(new Array(4).fill(once(100,235)));expect([...half.planes[1]!,...half.planes[2]!]).toEqual([u,v]);
 const yuva=frame('yuva420p',2,2,[Uint8Array.of(1,2,3,4),Uint8Array.of(5),Uint8Array.of(6),Uint8Array.of(7,8,9,10)],[2,1,1,2]);
 expect(drawboxVideoFrame('drawbox',yuva,box('w=1:t=1:c=0x00000040:replace=1'),{maxFrameBytes:16}).planes.map(p=>[...p])).toEqual([[16,2,16,4],[128],[128],[64,8,64,10]]);
 expect(drawboxVideoFrame('drawbox',yuva,box('w=1:t=1:c=black'),{maxFrameBytes:16}).planes.map(p=>[...p])).toEqual([[16,2,16,4],[128],[128],[7,8,9,10]]);
 const rgba=frame('argb',2,1,[Uint8Array.of(9,10,20,30,9,40,50,60)],[8]);
 expect([...drawboxVideoFrame('drawbox',rgba,box('w=1:c=0x112233@0x00:replace=1'),{maxFrameBytes:8}).planes[0]!]).toEqual([0,17,34,51,9,40,50,60]);
 expect([...drawboxVideoFrame('drawbox',rgba,box('w=1:c=0x112233'),{maxFrameBytes:8}).planes[0]!]).toEqual([9,17,34,51,9,40,50,60]);
 const f=Math.fround,alpha=f(128/255),blend=(p:number,c:number)=>Math.trunc(f(f(f(1-alpha)*p)+f(alpha*c)));
 expect([...drawboxVideoFrame('drawbox',frame('bgr24',1,1,[Uint8Array.of(10,20,30)],[3]),box('c=0xffffff@0x80'),{maxFrameBytes:3}).planes[0]!]).toEqual([blend(10,255),blend(20,255),blend(30,255)]);
 expect([...drawboxVideoFrame('drawgrid',frame('rgb24',2,1,[Uint8Array.of(1,2,3,4,5,6)],[6]),grid('x=1:y=1:h=2:c=invert'),{maxFrameBytes:6}).planes[0]!]).toEqual([1,2,3,251,250,249]);
 const legacy=drawboxVideoFrame('drawbox',frame('yuvj420p',2,2,[new Uint8Array(4),new Uint8Array(1),new Uint8Array(1)],[2,1,1]),box('t=1'),{maxFrameBytes:6});expect(legacy.pixelFormat).toBe('yuv420p');expect([...legacy.planes[0]!]).toEqual([16,16,16,16]);
});
it('rejects unsupported layouts, budgets, malformed storage, time bases and cancellation explicitly',()=>{
 const s=box(null),f=(width:number,height:number,stride=width,data=new Uint8Array(stride*height*3))=>frame('rgb24',width,height,[data],[stride*3]);
 expect(()=>drawboxVideoFrame('drawbox',frame('gray',2,2,[new Uint8Array(4)],[2]),s,{maxFrameBytes:64})).toThrow('not supported');expect(()=>drawboxVideoFrame('drawbox',frame('nv12',2,2,[new Uint8Array(4),new Uint8Array(2)],[2,2]),s,{maxFrameBytes:64})).toThrow('not supported');
 expect(()=>drawboxVideoFrame('drawbox',f(3,2),s,{maxFrameBytes:17})).toThrow('allocation limit');expect(()=>drawboxVideoFrame('drawbox',f(3,2,4),s,{maxFrameBytes:20})).toThrow('storage exceeds');
 expect(()=>drawboxVideoFrame('drawbox',frame('rgb24',3,2,[new Uint8Array(17)],[9]),s,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>drawboxVideoFrame('drawbox',frame('rgb24',3,2,[new Uint8Array(18)],[8]),s,{maxFrameBytes:64})).toThrow('stride or storage');expect(()=>drawboxVideoFrame('drawbox',frame('rgb24',3,2,[new Uint8Array(18)],[9.5]),s,{maxFrameBytes:64})).toThrow('stride or storage');
 expect(()=>drawboxVideoFrame('drawbox',{...f(3,2),planes:[]},s,{maxFrameBytes:64})).toThrow('plane count');
 expect(()=>drawboxVideoFrame('drawbox',{...f(3,2),pts:{value:0n,timeBase:{num:0n,den:1n}}},s,{maxFrameBytes:64})).toThrow('time base');
 expect(()=>drawboxVideoFrame('drawbox',f(3,2),box('w=1e10'),{maxFrameBytes:64})).toThrow('int range');
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>drawboxVideoFrame('drawbox',f(3,2),s,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
});
it('plans drawbox and drawgrid on every flagged path and refuses size-dependent geometry before output',async()=>{
 for(const operator of [drawboxOperator,drawgridOperator]){expect(operator.paths).toEqual(['linear','graph','stream','actor','timed']);expect(operator.formats!({} as never)).toEqual(drawboxNativeFormats);expect(operator.timeline).toBeUndefined();expect(operator.geometryCommands).toBeUndefined();}
 expect(drawboxNativeFormats).toEqual('yuv444p yuv422p yuv420p yuv411p yuv410p yuvj444p yuvj422p yuvj420p yuv440p yuvj440p yuva420p yuva422p yuva444p rgb24 bgr24 rgba bgra argb abgr 0rgb 0bgr rgb0 bgr0'.split(' '));
 const plan=compileVideoFilterChain('drawbox=1:1:2:2:white:1').plan('yuv444p',4,4),input=frame('yuv444p',4,4,[new Uint8Array(16),new Uint8Array(16),new Uint8Array(16)],[4,4,4]);expect(plan.stages.map(stage=>[stage.operation,stage.pixelFormat])).toEqual([['drawbox','yuv444p']]);
 expect([...plan.apply(input,{maxFrameBytes:48,maxStateBytes:0}).planes[0]!]).toEqual([0,0,0,0,0,235,235,0,0,235,235,0,0,0,0,0]);
 expect(compileVideoFilterChain('drawgrid').plan('nv12',4,4).stages[0]!.pixelFormat).toBe('yuv420p');expect(compileVideoFilterChain('drawbox').plan('rgba',4,4).stages[0]!.pixelFormat).toBe('rgba');
 expect(()=>compileVideoFilterChain('drawbox=w=1e10').plan('yuv420p',4,4)).toThrow('outside the int range');expect(()=>compileVideoFilterChain('drawbox=x=x').plan('yuv420p',4,4)).toThrow("Error when evaluating the expression 'x'.");
 expect(()=>compileVideoFilterGraph('[0:v]drawgrid=x=-2147483647[out]').plan({format:'rgb24',width:4,height:4},[null])).toThrow('overflows int');
 for(const description of ['drawbox=enable=1','drawbox=color=nosuch','drawbox=box_source=side_data_detection_bboxes','drawgrid=x=cos(0)'])expect(()=>compileVideoFilterChain(description),description).toThrow();
 const execution=createReplayVideoExecution('[in]drawgrid=w=2:h=2:c=white[out]',[{geometry:{format:'yuv444p',width:4,height:4},timeBase:{num:1n,den:25n},async *open(){yield input;}}],[null],{maxFrameBytes:64,maxStateBytes:1<<16,maxResidentBytes:1<<20,maxSourceTraversals:4},{arithmetic:'scalar'});
 const frames:VideoFrameData[]=[];try{for await(const output of execution.outputs[0]!.frames)frames.push(output);}finally{await execution.close();}expect([...frames[0]!.planes[0]!]).toEqual([235,235,235,235,235,0,235,0,235,235,235,235,235,0,235,0]);
 expect(()=>createFrameActors('drawbox=enable=1',{maxSteps:8,maxQueuedFrames:2,maxQueuedBytes:64})).toThrow();
});
