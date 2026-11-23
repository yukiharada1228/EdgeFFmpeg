import {it,expect} from 'vitest';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
const budget={maxResidentBytes:1048576,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000};
function memory(inputs:Map<string,Uint8Array>,faults:{read?:(path:string,offset:bigint)=>void;commit?:(path:string)=>void;write?:(path:string)=>Promise<void>}={}){
 const published=new Map<string,Uint8Array>(),stages=new Map<string,Uint8Array[]>(),readers=new Map<string,number>();let opens=0,reads=0;
 const filesystem:VirtualFileSystem={async openRead(path){opens++;readers.set(path,(readers.get(path)??0)+1);const bytes=inputs.get(path);if(!bytes)throw new Error('Missing input');return {size:BigInt(bytes.length),async readAt(offset,length){reads++;faults.read?.(path,offset);return bytes.slice(Number(offset),Number(offset)+Math.min(length,32));}};},async openWrite(path){opens++;const parts:Uint8Array[]=[];stages.set(path,parts);return {async write(chunk){await faults.write?.(path);parts.push(chunk.slice());},async commit(){faults.commit?.(path);const bytes=Uint8Array.from(parts.flatMap(part=>[...part]));published.set(path,bytes);stages.delete(path);},async abort(){stages.delete(path);}};}};
 return {filesystem,published,stages,readers,get opens(){return opens;},get reads(){return reads;}};
}

it('compares fourteen-format input pairs through the public multiple-input CLI with native payloads',async()=>{
 const arithmetic=referencePixelArithmetic(),directory=mkdtempSync(join(tmpdir(),'edge-multi-color-')),formats=['gray','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21'];let checked=0;
 const parameters=(path:string,format:string,rate:string)=>['-f','rawvideo','-pixel_format',format,'-s','4x4','-framerate',rate,'-i',path];
 try{for(const a of formats)for(const b of formats)for(const target of [null,'gray','rgb24','yuv420p'])for(const swapped of [false,true]){
  const sourceA=Uint8Array.from({length:pixelLayout(a,4,4).bytes*3},(_,i)=>(i*37+53)&255),sourceB=Uint8Array.from({length:pixelLayout(b,4,4).bytes*2},(_,i)=>(i*29+97)&255),io=memory(new Map([['/a',sourceA],['/b',sourceB]])),graph=swapped?'[1:v][0:v]hstack[o]':'[0:v][1:v]hstack[o]',nativeA=join(directory,'a'),nativeB=join(directory,'b'),nativeOutput=join(directory,'out');writeFileSync(nativeA,sourceA);writeFileSync(nativeB,sourceB);
  const outputs=['-map','[o]',...(target?['-pix_fmt',target]:[]),'-c:v','rawvideo','-bitexact','-f','rawvideo'];execFileSync('.build/reference/ffmpeg',['-v','error','-nostdin','-y','-filter_complex_threads','1',...parameters(nativeA,a,'25'),...parameters(nativeB,b,'30'),'-filter_complex',graph,...outputs,'-threads:v','1',nativeOutput],{timeout:10000});
  const actual=await new FFmpeg({filesystem:io.filesystem,budget,backend:createMediaBackend({pixelArithmetic:arithmetic})}).exec([...parameters('/a',a,'25'),...parameters('/b',b,'30'),'-filter_complex',graph,...outputs,'/out']);expect(actual.exitCode,JSON.stringify({a,b,target,swapped,diagnostics:actual.diagnostics})).toBe(0);expect(io.published.get('/out'),JSON.stringify({a,b,target,swapped})).toEqual(new Uint8Array(readFileSync(nativeOutput)));expect([...io.readers.values()]).toEqual([1,1]);checked++;
 }expect(checked).toBe(1568);}finally{rmSync(directory,{recursive:true,force:true});}
},120000);
