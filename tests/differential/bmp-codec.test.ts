import {verifyBmpReference} from '../helpers/bmp-corpus.js';
verifyBmpReference();
import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {decodeBmp,encodeBmp} from '@edge-ffmpeg/avcodec';
function fixture(width:number,height:number,depth:number,header:number,top:boolean,padding:boolean){
 const row=width*depth/8,stride=padding?Math.ceil(row/4)*4:row,offset=14+header,data=new Uint8Array(offset+stride*height),v=new DataView(data.buffer);
 v.setUint16(0,0x4d42,true);v.setUint32(2,data.length,true);v.setUint32(10,offset,true);v.setUint32(14,header,true);
 if(header===12){v.setUint16(18,width,true);v.setUint16(20,height,true);v.setUint16(22,1,true);v.setUint16(24,depth,true);}else{v.setInt32(18,width,true);v.setInt32(22,top?-height:height,true);v.setUint16(26,1,true);v.setUint16(28,depth,true);}
 for(let i=offset;i<data.length;i++)data[i]=(i*73+19)%256;return data;
}
const packet=(data:Uint8Array)=>({streamIndex:0,data,pts:19n,dts:19n,duration:1n,timeBase:{num:1n,den:25n},flags:1});
const options={maxFrameBytes:1048576,maxPacketBytes:1048576};
it('matches native visible pixels across direct BMP depths, headers, orientations and row alignment',()=>{
 let jobs=0;
 for(const depth of [16,24,32])for(const header of [12,40,56,64,108,124])for(const width of [1,3,4,7])for(const top of header===12?[false]:[false,true])for(const padding of [false,true]){
  const data=fixture(width,3,depth,header,top,padding),frame=decodeBmp(packet(data),options);
  const native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','image2pipe','-c:v','bmp','-i','pipe:0','-frames:v','1','-c:v','rawvideo','-pix_fmt',frame.pixelFormat,'-f','rawvideo','pipe:1'],{input:data,timeout:5000});
  expect(native.status,String([depth,header,width,top,padding])+String(native.stderr)).toBe(0);
  expect(Buffer.from(frame.planes[0]!)).toEqual(native.stdout);jobs++;
 }
 expect(jobs).toBe(264);
});
it('rejects malformed headers, resource overflows and cancellation before allocating',()=>{
 const data=fixture(3,3,24,40,false,true);
 expect(()=>decodeBmp(packet(data),{...options,maxFrameBytes:26})).toThrow('budget');
 expect(()=>decodeBmp(packet(data),{...options,maxPacketBytes:2})).toThrow();
 for(const length of [0,13,17,30,53,54,55,60])expect(()=>decodeBmp(packet(data.slice(0,length)),options)).toThrow();
 const cancel=new AbortController();cancel.abort();expect(()=>decodeBmp(packet(data),{...options,signal:cancel.signal})).toThrow();
 const frame=decodeBmp(packet(data),options),before=frame.planes[0]!.slice();data.fill(0);expect(frame.planes[0]).toEqual(before);expect(frame.pts).toEqual({value:19n,timeBase:{num:1n,den:25n}});
});
it('matches native packed palette indices and palette words for 1/4/8-bit images',()=>{
 let jobs=0;
 for(const depth of [1,4,8])for(const width of [1,3,7,8,9,17])for(const header of [12,40,108])for(const top of header===12?[false]:[false,true]){
  const colors=1<<depth,entry=header===12?3:4,offset=14+header+colors*entry,stride=Math.ceil(width*depth/32)*4,data=new Uint8Array(offset+stride*3),v=new DataView(data.buffer);
  v.setUint16(0,0x4d42,true);v.setUint32(2,data.length,true);v.setUint32(10,offset,true);v.setUint32(14,header,true);
  if(header===12){v.setUint16(18,width,true);v.setUint16(20,3,true);v.setUint16(22,1,true);v.setUint16(24,depth,true);}else{v.setInt32(18,width,true);v.setInt32(22,top?-3:3,true);v.setUint16(26,1,true);v.setUint16(28,depth,true);}
  for(let i=14+header;i<data.length;i++)data[i]=(i*97+41)%256;
  const frame=decodeBmp(packet(data),options),native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','image2pipe','-c:v','bmp','-i','pipe:0','-frames:v','1','-c:v','rawvideo','-pix_fmt','pal8','-f','rawvideo','pipe:1'],{input:data,timeout:5000});
  expect(native.status,String([depth,width,header,top])+String(native.stderr)).toBe(0);expect(Buffer.concat(frame.planes.map(p=>Buffer.from(p)))).toEqual(native.stdout);jobs++;
 }
 expect(jobs).toBe(90);
});
it('matches native supported bitfield layouts and zero-alpha format inference',()=>{
 const masks16=[[63488,2016,31],[31744,992,31],[3840,240,15]],masks32=[[4278190080,16711680,65280],[16711680,65280,255],[65280,16711680,4278190080],[255,65280,16711680]];
 for(const depth of [16,32])for(const masks of depth===16?masks16:masks32)for(const alpha of [false,true]){
  const base=fixture(3,3,depth,108,false,true),view=new DataView(base.buffer);view.setUint32(30,3,true);masks.forEach((m,i)=>view.setUint32(54+i*4,m,true));view.setUint32(66,alpha?0xff000000:0,true);
  const frame=decodeBmp(packet(base),options),native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','image2pipe','-c:v','bmp','-i','pipe:0','-frames:v','1','-c:v','rawvideo','-pix_fmt',frame.pixelFormat,'-f','rawvideo','pipe:1'],{input:base,timeout:5000});
  expect(native.status,String(native.stderr)).toBe(0);expect(Buffer.from(frame.planes[0]!)).toEqual(native.stdout);
 }
 const data=fixture(3,3,32,40,false,true);for(let i=57;i<data.length;i+=4)data[i]=0;expect(decodeBmp(packet(data),options).pixelFormat).toBe('bgr0');
});

it('matches complete native BMP encoder packets including masks, grayscale palette and padding',()=>{
 let jobs=0;
 for(const [pixelFormat,depth]of Object.entries({bgr24:24,bgra:32,rgb555le:16,rgb565le:16,rgb444le:16,gray:8,monob:1,rgb8:8,bgr8:8,rgb4_byte:8,bgr4_byte:8}))for(const width of [1,3,7,8,17])for(const height of [1,4]){
  const row=Math.ceil(width*depth/8),pixels=new Uint8Array(row*height);for(let i=0;i<pixels.length;i++)pixels[i]=(i*91+77)%256;
  const frame={width,height,pixelFormat,planes:[pixels],linesizes:[row],pts:null,metadata:{}},actual=encodeBmp(frame,options);
  const native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','rawvideo','-pixel_format',pixelFormat,'-video_size',`${width}x${height}`,'-i','pipe:0','-frames:v','1','-c:v','bmp','-f','image2pipe','pipe:1'],{input:pixels,timeout:5000});
  expect(native.status,String(native.stderr)).toBe(0);expect(Buffer.from(actual.data),String([pixelFormat,width,height])).toEqual(native.stdout);jobs++;
 }
 expect(jobs).toBe(110);
});
it('matches native pal8 encoder palettes with alpha discarded and padded input rows',()=>{
 for(const width of [1,3,7,17])for(const height of [1,4]){
  const row=width+3,pixels=new Uint8Array(row*height),palette=new Uint8Array(1024),tight=new Uint8Array(width*height+1024);
  for(let i=0;i<pixels.length;i++)pixels[i]=(i*29+17)%256;for(let i=0;i<palette.length;i++)palette[i]=(i*43+71)%256;
  for(let y=0;y<height;y++)tight.set(pixels.subarray(y*row,y*row+width),y*width);tight.set(palette,width*height);
  const actual=encodeBmp({width,height,pixelFormat:'pal8',planes:[pixels,palette],linesizes:[row,1024],pts:null,metadata:{}},options),native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','rawvideo','-pixel_format','pal8','-video_size',`${width}x${height}`,'-i','pipe:0','-frames:v','1','-c:v','bmp','-f','image2pipe','pipe:1'],{input:tight,timeout:5000});
  expect(native.status,String(native.stderr)).toBe(0);expect(Buffer.from(actual.data)).toEqual(native.stdout);
 }
});
it('rejects encoder overflow, aggregate plane budgets and truncated strides',()=>{
 const frame={width:3,height:2,pixelFormat:'bgr24',planes:[new Uint8Array(18)],linesizes:[9],pts:null,metadata:{}};
 expect(()=>encodeBmp(frame,{...options,maxPacketBytes:77})).toThrow('budget');
 expect(()=>encodeBmp(frame,{...options,maxFrameBytes:17})).toThrow('budget');
 expect(()=>encodeBmp({...frame,linesizes:[8]},options)).toThrow('stride');
 expect(()=>encodeBmp({...frame,width:2147483647,height:2147483647},options)).toThrow('budget');
 expect(()=>encodeBmp({...frame,planes:[new Uint8Array(17)]},options)).toThrow('storage');
});
