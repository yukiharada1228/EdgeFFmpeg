import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
const formats=['gray','rgb24','bgr24','rgba','bgra','argb','abgr','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','gbrp'];
it('matches native rawvideo copy encoding frame limits and framecrc for packed planar and odd-sized frames',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-raw-video-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:512,maxWriteBytes:512}),frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:512,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    for(const pixel of formats)for(const [width,height]of [[1,1],[5,3],[8,6]])for(const rate of ['25','30000/1001','23.976']){
      const layout=pixelLayout(pixel,width!,height!),data=Uint8Array.from({length:layout.bytes*5},(_,i)=>(i*37+13)&255);writeFileSync(join(root,'input.raw'),data);
      for(const codec of ['copy','rawvideo'])for(const limit of [[],['-frames:v','0'],['-frames:v','1'],['-vframes','3'],['-frames:v','-1'],['-frames:v','9223372036854775807']])for(const format of ['rawvideo','framecrc']){
        const before=['-f','rawvideo','-pixel_format',pixel,'-video_size',`${width}x${height}`,'-framerate',rate],after=['-c:v',codec,...limit,'-bitexact','-f',format],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.out`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${pixel}/${width}x${height}/${rate}/${codec}/${limit}/${format}`).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},180000);
it('matches rawvideo defaults named rates option aliases empty streams and short physical reads',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-video-options-'));
  try{
    const base=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),filesystem={async openRead(path:string){const source=await base.openRead(path);return {size:source.size,readAt:(offset:bigint,length:number,signal?:AbortSignal)=>source.readAt(offset,Math.min(length,3),signal)};},openWrite:base.openWrite},frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});let index=0;
    for(const pixel of [null,'gray8','rgba'])for(const rate of [null,'ntsc','pal','qntsc','qpal','sntsc','spal','film','ntsc-film'])for(const frames of [0,3])for(const codec of ['copy','rawvideo'])for(const limit of [[],['-frames:v','1','-vframes','2'],['-frames:v:0','3','-frames:0','1']]){
      const layout=pixelLayout(pixel??'yuv420p',5,3);writeFileSync(join(root,'input.raw'),Uint8Array.from({length:frames*layout.bytes},(_,i)=>(i*19+17)&255));
      const before=['-f','wav','-f','rawvideo','-s','5x3',...(pixel?['-pix_fmt',pixel]:[]),...(rate?['-framerate',rate]:[])],after=['-map','0:v:0','-vcodec',codec,...limit,'-bitexact','-f','framecrc'],expected=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...before,'-i',join(root,'input.raw'),...after,'-']),out=`/${index++}.crc`,result=await frontend.exec([...before,'-i','/input.raw',...after,out]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,out.slice(1))).equals(expected),`${pixel}/${rate}/${frames}/${codec}/${limit}`).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
