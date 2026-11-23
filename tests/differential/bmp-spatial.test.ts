import {it,expect} from 'vitest';import {spawnSync} from 'node:child_process';
import {flipVideoFrame,transposeVideoFrame} from '@edge-ffmpeg/avfilter';import {encodeRawVideo} from '@edge-ffmpeg/avcodec';import type {VideoFrameData} from '@edge-ffmpeg/avutil';
import {createCrop} from '../../packages/avfilter/src/activation/crop.js';import {verifyBmpReference} from '../helpers/bmp-corpus.js';verifyBmpReference();
it('preserves palettes through Native pal8 flips and positioned crop and packed vertical rows',()=>{
 for(const pixelFormat of ['pal8','monob']){
  const width=5,height=3,row=pixelFormat==='pal8'?width:1,pixels=Uint8Array.from({length:row*height},(_,i)=>(i*37+13)%256),palette=Uint8Array.from({length:1024},(_,i)=>(i*71+19)%256),frame:VideoFrameData={width,height,pixelFormat,planes:pixelFormat==='pal8'?[pixels,palette]:[pixels],linesizes:pixelFormat==='pal8'?[row,1024]:[row],pts:{value:0n,timeBase:{num:1n,den:25n}},metadata:{}},input=encodeRawVideo(frame,{num:25n,den:1n},{maxFrameBytes:4096}).data;
  for(const filter of pixelFormat==='pal8'?['hflip','vflip','crop=3:2:2:1']:['vflip']){
   const output=filter.startsWith('crop')?createCrop({width,height,format:pixelFormat,outWidth:'3',outHeight:'2',x:'2',y:'1',numericProfile:'darwin-arm64',timeBase:{num:1n,den:25n},maxFrameBytes:4096}).process({kind:'frame',frame,duration:1n}).frame:flipVideoFrame(frame,filter==='hflip'?'horizontal':'vertical',{maxFrameBytes:4096}),actual=encodeRawVideo(output,{num:25n,den:1n},{maxFrameBytes:4096}).data,native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','rawvideo','-pixel_format',pixelFormat,'-video_size',`${width}x${height}`,'-i','pipe:0','-vf',filter,'-frames:v','1','-c:v','rawvideo','-pix_fmt',pixelFormat,'-f','rawvideo','pipe:1'],{input,timeout:5000});expect(native.status,String(native.stderr)).toBe(0);expect(Buffer.from(actual),pixelFormat+filter).toEqual(native.stdout);if(pixelFormat==='pal8')expect(output.planes[1]).toEqual(palette);
  }
 }
 const frame:VideoFrameData={width:3,height:2,pixelFormat:'monob',planes:[new Uint8Array(2)],linesizes:[1],pts:null,metadata:{}};
 expect(()=>flipVideoFrame(frame,'horizontal',{maxFrameBytes:4096})).toThrow('format negotiation');expect(()=>transposeVideoFrame(frame,1,{maxFrameBytes:4096})).toThrow('format negotiation');expect(()=>transposeVideoFrame({...frame,pixelFormat:'pal8'},1,{maxFrameBytes:4096})).toThrow('format negotiation');expect(()=>createCrop({width:3,height:2,format:'monob',numericProfile:'darwin-arm64',timeBase:{num:1n,den:25n},maxFrameBytes:4096})).toThrow('format negotiation');
});
