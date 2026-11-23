import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {decodeBmp,encodeBmp} from '@edge-ffmpeg/avcodec';
import {image} from '../helpers/bmp-fixture.js';
it('runs bounded BMP decoding and encoding inside workerd',async()=>{
 const bundle=await build({entryPoints:['tests/workers/bmp-codec-fixture.ts'],tsconfig:'tsconfig.workers.json',bundle:true,write:false,platform:'browser',format:'esm'}),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-11-19'}));
 try{await mf.ready;
 for(const depth of [16,24,32])for(const width of [1,3,8]){
  const stride=Math.ceil(width*depth/32)*4,data=new Uint8Array(54+stride*3),v=new DataView(data.buffer);v.setUint16(0,0x4d42,true);v.setUint32(2,data.length,true);v.setUint32(10,54,true);v.setUint32(14,40,true);v.setInt32(18,width,true);v.setInt32(22,3,true);v.setUint16(26,1,true);v.setUint16(28,depth,true);for(let i=54;i<data.length;i++)data[i]=(i*31+13)%256;
  const options={maxFrameBytes:1048576,maxPacketBytes:1048576},frame=decodeBmp({streamIndex:0,data,pts:0n,dts:0n,duration:1n,timeBase:{num:1n,den:25n},flags:1},options),encoded=encodeBmp(frame,options),response=await mf.dispatchFetch('https://test/',{method:'POST',body:data});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({width,height:3,pixelFormat:frame.pixelFormat,planes:frame.planes.map(p=>Array.from(p)),encoded:Array.from(encoded.data)});
 }
 for(const depth of [4,8])for(const top of [false,true]){
  const data=image(7,3,depth,top,[7,0x12,0,0,0,2,1,0,6,0x34,0,0,7,0x56,0,1]),options={maxFrameBytes:1048576,maxPacketBytes:1048576},frame=decodeBmp({streamIndex:0,data,pts:0n,dts:0n,duration:1n,timeBase:{num:1n,den:25n},flags:1},options),encoded=encodeBmp(frame,options),response=await mf.dispatchFetch('https://test/',{method:'POST',body:data});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({width:7,height:3,pixelFormat:'pal8',planes:frame.planes.map(p=>Array.from(p)),encoded:Array.from(encoded.data)});
 }
 }finally{await mf.dispose();}
});
