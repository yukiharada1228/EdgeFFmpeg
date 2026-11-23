import {expect,it} from 'vitest';
import {flipVideoFrame} from '@edge-ffmpeg/avfilter';
import type {VideoFrameData} from '@edge-ffmpeg/avutil';
const frame=():VideoFrameData=>({width:2,height:2,pixelFormat:'gray',planes:[Uint8Array.of(1,2,99,99,3,4)],linesizes:[4],pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{label:'sample'}});
it('reads padded rows and returns owned tight storage with independent exact timestamp descriptors',()=>{
 const source=frame(),output=flipVideoFrame(source,'vertical',{maxFrameBytes:6});
 expect(output.planes[0]).toEqual(Uint8Array.of(3,4,1,2));expect(output.linesizes).toEqual([2]);expect(output.pts).toEqual(source.pts);expect(output.pts).not.toBe(source.pts);expect(output.pts!.timeBase).not.toBe(source.pts!.timeBase);expect(output.metadata).toEqual(source.metadata);expect(output.metadata).not.toBe(source.metadata);
 output.planes[0]![0]=42;expect(source.planes[0]).toEqual(Uint8Array.of(1,2,99,99,3,4));
});
it('rejects aggregate padded input and malformed storage before allocating output',()=>{
 expect(()=>flipVideoFrame(frame(),'horizontal',{maxFrameBytes:4})).toThrow('input plane storage');
 for(const linesizes of [[1],[-4],[NaN],[]])expect(()=>flipVideoFrame({...frame(),linesizes},'horizontal',{maxFrameBytes:64})).toThrow();
 expect(()=>flipVideoFrame({...frame(),planes:[Uint8Array.of(1,2)]},'vertical',{maxFrameBytes:64})).toThrow('storage');
 expect(()=>flipVideoFrame(frame(),'horizontal',{maxFrameBytes:NaN})).toThrow('allocation');
});
it('cancels before processing and rejects invalid timestamp bases',()=>{
 const signal=AbortSignal.abort(new Error('Stopped'));expect(()=>flipVideoFrame(frame(),'horizontal',{maxFrameBytes:64,signal})).toThrow('Stopped');
 const source=frame();expect(()=>flipVideoFrame({...source,pts:{value:source.pts!.value,timeBase:{num:1n,den:0n}}},'horizontal',{maxFrameBytes:64})).toThrow('timestamp');
});
