import {expect,it} from 'vitest';
import {compileVideoFilterChain,compileVideoFilterGraph,planTimedVideoGraph,VideoFilterError} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {fieldOperator,fieldVideoFrame,fieldHeight,VideoFieldError} from '../../packages/avfilter/src/video-ops/field.js';
import {negotiationOrder} from '../../packages/avfilter/src/video-ops/formats.js';
const token=(options:string|null)=>({name:'field',options});
const gray=(data:Uint8Array,width:number,height:number,stride=width):VideoFrameData=>({width,height,pixelFormat:'gray',planes:[data],linesizes:[stride],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{colorRange:2}});
it('parses the type option, its shorthand and constants into frozen steps and refuses everything else',()=>{
 expect(fieldOperator.parse!(token(null)).configuration).toEqual({name:'field',type:0});expect(Object.isFrozen(fieldOperator.parse!(token(null)).configuration)).toBe(true);
 for(const [options,type]of [['top',0],['bottom',1],['0',0],['1',1],['type=bottom',1],['type=top',0],['type=1:type=0',0]] as const)expect(fieldOperator.parse!(token(options)).configuration,options).toEqual({name:'field',type});
 for(const options of ['2','-1','Bottom','top+1','1.0','0x1','type=','enable=1','threads=1','foo=1','top:1'])expect(()=>fieldOperator.parse!(token(options)),options).toThrow();
 expect(()=>fieldOperator.parse!(token('enable=1'))).toThrow('timeline');
 expect(fieldOperator.formats).toBeUndefined();expect(fieldOperator.paths).toEqual(['linear','graph','stream','actor','timed']);
});
it('computes (h + top) / 2 and refuses the empty bottom link and the chroma over-read heights',()=>{
 for(const [height,top,bottom]of [[1,1,null],[2,1,1],[3,2,1],[7,4,3],[8,4,4]] as const){expect(fieldHeight('gray',5,height,0)).toBe(top);if(bottom===null)expect(()=>fieldHeight('gray',5,height,1)).toThrow('empty frame');else expect(fieldHeight('gray',5,height,1)).toBe(bottom);}
 for(const format of negotiationOrder)for(let height=2;height<=14;height++){
  const refused=['yuv420p','yuva420p','nv12','nv21'].includes(format)&&height%4===2;
  if(refused)expect(()=>fieldHeight(format,5,height,1),format+height).toThrow('past the subsampled chroma');else expect(fieldHeight(format,5,height,1),format+height).toBe(height>>1);
  expect(fieldHeight(format,5,height,0)).toBe(height+1>>1);
 }
 for(const format of ['pal8','monob','rgb0'])expect(()=>fieldHeight(format,4,4,0),format).toThrow('not supported');
 expect(fieldOperator.geometry!({name:'field',type:0},[{format:'gray',width:5,height:7}])).toEqual({width:5,height:4});
 expect(()=>compileVideoFilterChain('field=bottom').plan('gray',4,1)).toThrow(VideoFilterError);expect(()=>compileVideoFilterChain('field=bottom').plan('yuv420p',4,6)).toThrow('past the subsampled chroma');
 expect(()=>compileVideoFilterGraph('[0:v]field=bottom[o]').plan({format:'nv12',width:4,height:10},[null])).toThrow('past the subsampled chroma');
 expect(()=>planTimedVideoGraph('field=bottom',[{geometry:{format:'gray',width:4,height:1},timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n}}],[null])).toThrow('empty frame');
 expect(compileVideoFilterChain('field=bottom').plan('yuv422p',4,6).height).toBe(3);
});
it('copies alternate rows of every plane into owned tight planes from padded input without mutating it',()=>{
 const input=Uint8Array.from({length:4*5},(_,i)=>i),frame=gray(input,3,5,4),copy=input.slice();
 const top=fieldVideoFrame(frame,0,{maxFrameBytes:20}),bottom=fieldVideoFrame(frame,1,{maxFrameBytes:20});
 expect([...top.planes[0]!]).toEqual([0,1,2,8,9,10,16,17,18]);expect([top.width,top.height,top.linesizes]).toEqual([3,3,[3]]);
 expect([...bottom.planes[0]!]).toEqual([4,5,6,12,13,14]);expect(bottom.height).toBe(2);
 expect(top.pts).toEqual(frame.pts);expect(top.pts).not.toBe(frame.pts);expect(top.metadata).toEqual({colorRange:2});expect(top.metadata).not.toBe(frame.metadata);expect(input).toEqual(copy);expect(top.planes[0]!.buffer).not.toBe(input.buffer);
 const layout=pixelLayout('yuv420p',4,4),data=Uint8Array.from({length:layout.bytes},(_,i)=>i),yuv:VideoFrameData={width:4,height:4,pixelFormat:'yuv420p',planes:layout.planes.map(plane=>data.slice(plane.offset,plane.offset+plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:null,metadata:{}};
 const out=fieldVideoFrame(yuv,1,{maxFrameBytes:64});expect(out.planes.map(plane=>[...plane])).toEqual([[4,5,6,7,12,13,14,15],[18,19],[22,23]]);expect(out.pts).toBeNull();
 const plan=compileVideoFilterChain('field,hflip').plan('gray',3,5);expect([plan.width,plan.height]).toEqual([3,3]);expect([...plan.apply(gray(Uint8Array.from({length:15},(_,i)=>i),3,5),{maxFrameBytes:15,maxStateBytes:0}).planes[0]!]).toEqual([2,1,0,8,7,6,14,13,12]);
});
it('rejects budgets, malformed storage, mismatched sizes, bad time bases and cancellation explicitly',()=>{
 const options={maxFrameBytes:64};
 expect(()=>fieldVideoFrame(gray(new Uint8Array(15),3,5),0,{maxFrameBytes:8})).toThrow('allocation limit');expect(fieldOperator.parse!(token('')).configuration).toEqual({name:'field',type:0});expect(()=>fieldVideoFrame(gray(new Uint8Array(20),3,5,4),0,{maxFrameBytes:19})).toThrow('storage exceeds');
 expect(()=>fieldVideoFrame(gray(new Uint8Array(14),3,5),0,options)).toThrow('stride or storage');expect(()=>fieldVideoFrame(gray(new Uint8Array(15),3,5,2),0,options)).toThrow('stride or storage');expect(()=>fieldVideoFrame({...gray(new Uint8Array(15),3,5),linesizes:[3.5]},0,options)).toThrow('stride or storage');
 expect(()=>fieldVideoFrame({...gray(new Uint8Array(15),3,5),planes:[]},0,options)).toThrow('plane count');expect(()=>fieldVideoFrame({...gray(new Uint8Array(15),3,5),pts:{value:0n,timeBase:{num:0n,den:1n}}},0,options)).toThrow('time base');
 expect(()=>fieldVideoFrame(gray(new Uint8Array(3),3,1),1,options)).toThrow(VideoFieldError);expect(()=>fieldVideoFrame(gray(new Uint8Array(6),3,2),2 as 0,options)).toThrow('Invalid field type');
 const layout=pixelLayout('nv12',4,6),bad:VideoFrameData={width:4,height:6,pixelFormat:'nv12',planes:layout.planes.map(plane=>new Uint8Array(plane.bytes)),linesizes:layout.planes.map(plane=>plane.rowBytes),pts:null,metadata:{}};expect(()=>fieldVideoFrame(bad,1,options)).toThrow('past the subsampled chroma');
 const plan=compileVideoFilterChain('field').plan('gray',3,5);expect(()=>plan.apply(gray(new Uint8Array(15),3,5),{maxFrameBytes:8,maxStateBytes:0})).toThrow();
 const controller=new AbortController();controller.abort(new Error('stop'));expect(()=>fieldVideoFrame(gray(new Uint8Array(15),3,5),0,{maxFrameBytes:64,signal:controller.signal})).toThrow('stop');
 let rows=0;const later=new AbortController(),signal={throwIfAborted(){if(++rows===3)later.abort(new Error('late'));later.signal.throwIfAborted();}} as AbortSignal;expect(()=>fieldVideoFrame(gray(new Uint8Array(15),3,5),0,{maxFrameBytes:64,signal})).toThrow('late');
});
