import {expect,it} from 'vitest';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {convertVideoFrame,pixelConversionStateBytes,UnstablePixelReferenceError} from '@edge-ffmpeg/swscale';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
function input(format:string,width:number,height:number,alpha=200){const layout=pixelLayout(format,width,height),data=new Uint8Array(layout.bytes).fill(128);if(format==='yuva420p')data.fill(alpha,layout.planes[3]!.offset);return decodeRawVideo({streamIndex:0,data,pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1001n,den:30000n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:65536});}
it('models distinct scalar-table and AArch64 integer rounding without depending on host instructions',()=>{
 const frame=input('yuv420p',16,2),neon=convertVideoFrame(frame,'rgb24',{maxFrameBytes:1024,maxStateBytes:4096,arithmetic:'aarch64'}),scalar=convertVideoFrame(frame,'rgb24',{maxFrameBytes:1024,maxStateBytes:4096,arithmetic:'scalar'});expect([...neon.planes[0]!]).toEqual(Array(96).fill(130));expect([...scalar.planes[0]!]).toEqual(Array(96).fill(129));expect(neon.pts).toEqual(frame.pts);expect(neon.planes[0]!.buffer).not.toBe(frame.planes[0]!.buffer);
});
it('preserves generic full chroma precision and structural two-tap alpha rounding at the bottom edge',()=>{
 const frame=input('yuva420p',16,7),converted=convertVideoFrame(frame,'rgba',{maxFrameBytes:4096,maxStateBytes:8192,arithmetic:'scalar'});expect(Array.from({length:7},(_,row)=>converted.planes[0]![row*64+3])).toEqual(Array(7).fill(200));
 const odd=input('yuv420p',5,3),rgb=convertVideoFrame(odd,'rgb24',{maxFrameBytes:4096,maxStateBytes:8192});expect([...rgb.planes[0]!]).toEqual(Array(45).fill(130));const planar=convertVideoFrame({...odd,pts:null},'gbrp',{maxFrameBytes:4096,maxStateBytes:8192});expect(planar.pts).toBeNull();expect(planar.planes.map(plane=>[...plane])).toEqual(Array.from({length:3},()=>Array(15).fill(130)));
});
it('rejects unverified aligned semiplanar default arithmetic but allows explicit scalar conversion',()=>{
 const frame=input('nv12',16,6);expect(()=>convertVideoFrame(frame,'rgba',{maxFrameBytes:4096,maxStateBytes:8192})).toThrow(UnstablePixelReferenceError);expect(convertVideoFrame(frame,'rgba',{maxFrameBytes:4096,maxStateBytes:8192,arithmetic:'scalar'}).planes[0]).toHaveLength(384);expect(()=>createMediaBackend({pixelArithmetic:'unknown' as never})).toThrow('profile');expect(()=>convertVideoFrame(input('yuv420p',5,3),'rgb24',{maxFrameBytes:4096,arithmetic:'unknown' as never})).toThrow('profile');
});
it('accounts inverse coefficients and row buffers and reads positive padded input strides safely',()=>{
 const frame=input('nv21',5,3),state=pixelConversionStateBytes('nv21','rgba',5,3);expect(state).toBeGreaterThan(0);expect(()=>convertVideoFrame(frame,'rgba',{maxFrameBytes:4096,maxStateBytes:state-1})).toThrow('state');
 const padded={...frame,planes:frame.planes.map((plane,index)=>{const rowBytes=frame.linesizes[index]!,rows=index===0?3:2,storage=new Uint8Array((rowBytes+2)*rows).fill(99);for(let row=0;row<rows;row++)storage.set(plane.subarray(row*rowBytes,(row+1)*rowBytes),row*(rowBytes+2));return storage;}),linesizes:frame.linesizes.map(value=>value+2)};expect(convertVideoFrame(padded,'rgba',{maxFrameBytes:4096,maxStateBytes:state}).planes[0]).toEqual(convertVideoFrame(frame,'rgba',{maxFrameBytes:4096,maxStateBytes:state}).planes[0]);expect(()=>convertVideoFrame(frame,'rgba',{maxFrameBytes:4096,maxStateBytes:state,signal:AbortSignal.abort(new Error('stop'))})).toThrow('stop');
});
