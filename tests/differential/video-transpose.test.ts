import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {transposeVideoFrame} from '@edge-ffmpeg/avfilter';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native transposition directions for symmetric eight-bit layouts and padded input',()=>{
 referencePixelArithmetic();const root=mkdtempSync(join(tmpdir(),'edge-transpose-'));let count=0;
 try{for(const format of ['gray','yuv420p','yuv444p','yuva420p','nv12','nv21','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'])for(const [width,height]of [[5,3],[3,5],[4,4],[1,1],[17,9]])for(const direction of [0,1,2,3] as const){
 const layout=pixelLayout(format,width!,height!),raw=Uint8Array.from({length:layout.bytes},(_,i)=>(i*37+223)&255);writeFileSync(join(root,'in.raw'),raw);
 const native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',join(root,'in.raw'),'-vf',`transpose=${direction}`,'-pix_fmt',format,'-f','rawvideo','-']);
 for(const padding of [0,7]){
 const planes=layout.planes.map(p=>{const data=new Uint8Array((p.rowBytes+padding)*p.height).fill(199);for(let row=0;row<p.height;row++)data.set(raw.subarray(p.offset+row*p.rowBytes,p.offset+(row+1)*p.rowBytes),row*(p.rowBytes+padding));return data;}),frame={width:width!,height:height!,pixelFormat:format,planes,linesizes:layout.planes.map(p=>p.rowBytes+padding),pts:{value:9007199254740993n,timeBase:{num:1n,den:25n}},metadata:{seed:223}},actual=transposeVideoFrame(frame,direction,{maxFrameBytes:65536});
 expect(Buffer.concat(actual.planes),`${format} ${width}x${height} ${direction}`).toEqual(native);expect([actual.width,actual.height]).toEqual([height,width]);expect(actual.pts).toEqual(frame.pts);expect(actual.metadata).toEqual(frame.metadata);expect(actual.planes[0]!.buffer).not.toBe(planes[0]!.buffer);count++;
 }
 }expect(count).toBe(520);}finally{rmSync(root,{recursive:true,force:true});}
},30000);
