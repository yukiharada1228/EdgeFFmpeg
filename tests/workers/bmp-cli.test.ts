import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {spawnSync} from 'node:child_process';
import {encodeBmp} from '@edge-ffmpeg/avcodec';
import {image} from '../helpers/bmp-fixture.js';
import {verifyBmpReference} from '../helpers/bmp-corpus.js';
verifyBmpReference();
it('matches native BMP CLI bytes through public R2 and transactional output',async()=>{
 const bundle=await build({entryPoints:['tests/workers/bmp-cli-fixture.ts'],tsconfig:'tsconfig.workers.json',bundle:true,write:false,platform:'browser',format:'esm'}),mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:'2026-11-19',r2Buckets:['MEDIA_BUCKET']}));
 const inputs:Uint8Array[]=[];
 for(const pixelFormat of ['bgr24','bgra','rgb555le','gray','pal8']){
  const step=pixelFormat==='bgr24'?3:pixelFormat==='bgra'?4:pixelFormat==='rgb555le'?2:1,parts=[];
  for(let i=0;i<3;i++){const pixels=Uint8Array.from({length:9*step},(_,j)=>(j*29+i*31+13)%256),palette=Uint8Array.from({length:1024},(_,j)=>(j*17+29)%256);parts.push(encodeBmp({width:3,height:3,pixelFormat,planes:pixelFormat==='pal8'?[pixels,palette]:[pixels],linesizes:pixelFormat==='pal8'?[3,1024]:[3*step],pts:null,metadata:{}},{maxFrameBytes:8192,maxPacketBytes:8192}).data);}
  inputs.push(Buffer.concat(parts));
 }
 for(const depth of [4,8])for(const top of [false,true])inputs.push(image(7,3,depth,top,[7,0x12,0,0,7,0x34,0,0,7,0x56,0,1]));
 let jobs=0;
 try{await mf.ready;
  for(const input of inputs)for(const codec of ['rawvideo','bmp','copy'])for(const limit of [0,2]){
   const options=['-c:v',codec,'-frames:v',String(limit),'-f',codec==='rawvideo'?'rawvideo':'image2pipe'],native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','image2pipe','-c:v','bmp','-i','pipe:0',...options,'pipe:1'],{input,timeout:5000}),response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({bytes:Array.from(input),options})}),result=await response.json() as {exitCode:number;data:string|null;temporary:number;maxWrite:number;readerOpens:number;diagnostics:unknown};
   expect(native.status,String(native.stderr)).toBe(0);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(result.data).not.toBeNull();expect(Buffer.from(result.data!,'base64')).toEqual(native.stdout);expect(result.temporary).toBe(0);expect(result.maxWrite).toBeLessThanOrEqual(7);expect(result.readerOpens).toBe(1);expect((await (await mf.getR2Bucket('MEDIA_BUCKET')).list()).objects).toHaveLength(0);jobs++;
  }
  for(const mode of ['input-change','cancel','write-failure','plan-budget','lost-ack','cleanup-published']){
   const input=inputs[0]!,response=await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({bytes:Array.from(input),mode,options:['-c:v','copy','-f','image2pipe']})}),result=await response.json() as {exitCode:number;data:string|null;temporary:number;temporaryBefore:number;recovered:boolean|null;outputs:string[];effects:{status:string}[]};
   expect(result.exitCode,mode).toBe(1);expect(result.temporary,mode).toBe(0);
   if(mode==='lost-ack'||mode==='cleanup-published'){
    expect(result.recovered,mode).toBe(true);expect(Buffer.from(result.data!,'base64')).toEqual(Buffer.from(input));expect(result.effects[0]!.status).toBe(mode==='lost-ack'?'uncertain':'published');expect(result.outputs).toEqual(mode==='lost-ack'?[]:['/output/result.bin']);
   }else {expect(result.data,mode).toBeNull();expect(result.outputs).toEqual([]);}
   expect((await (await mf.getR2Bucket('MEDIA_BUCKET')).list()).objects).toHaveLength(0);
  }
 }finally{await mf.dispose();}
 expect(jobs).toBe(54);
},60000);
