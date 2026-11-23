import {it,expect} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
const budget={maxResidentBytes:1048576,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000},input=(path:string,rate:string)=>['-f','rawvideo','-pixel_format','gray','-s','2x2','-framerate',rate,'-i',path],data=(base:number,count:number)=>Uint8Array.from({length:count*4},(_,i)=>base+Math.floor(i/4));
function memory(inputs:Map<string,Uint8Array>,faults:{read?:(path:string,offset:bigint)=>void;commit?:(path:string)=>void;write?:(path:string)=>Promise<void>}={}){
 const published=new Map<string,Uint8Array>(),stages=new Map<string,Uint8Array[]>(),readers=new Map<string,number>();let opens=0,reads=0;
 const filesystem:VirtualFileSystem={async openRead(path){opens++;readers.set(path,(readers.get(path)??0)+1);const bytes=inputs.get(path);if(!bytes)throw new Error('Missing input');return {size:BigInt(bytes.length),async readAt(offset,length){reads++;faults.read?.(path,offset);return bytes.slice(Number(offset),Number(offset)+Math.min(length,2));}};},async openWrite(path){opens++;const parts:Uint8Array[]=[];stages.set(path,parts);return {async write(chunk){await faults.write?.(path);parts.push(chunk.slice());},async commit(){faults.commit?.(path);const bytes=Uint8Array.from(parts.flatMap(part=>[...part]));published.set(path,bytes);stages.delete(path);},async abort(){stages.delete(path);}};}};
 return {filesystem,published,stages,readers,get opens(){return opens;},get reads(){return reads;}};
}
const frontend=(filesystem:VirtualFileSystem)=>new FFmpeg({filesystem,budget,backend:createMediaBackend()});
it('matches complete native files for nested graphs and independent output maps',async()=>{
 const arithmetic=referencePixelArithmetic(),directory=mkdtempSync(join(tmpdir(),'edge-multi-exec-'));let checked=0;
 try{for(const rates of [['25','25'],['25','30'],['30000/1001','25'],['50/2','25']])for(const format of ['rawvideo','framecrc'])for(const graph of ['[0:v][1:v]hstack,split[x][y];[x]hflip[left];[y]vflip[right]','[0:v]split[x][direct];[x][1:v]hstack[inner];[inner][direct]hstack[left]','[1:v]null[left];[0:v]null[right]']){
 const inputs=new Map([['/a',data(10,5)],['/b',data(100,3)]]),io=memory(inputs),left=join(directory,'left'),right=join(directory,'right');for(const [path,bytes]of inputs)writeFileSync(join(directory,path.slice(1)),bytes);
 const hasRight=graph.includes('[right]'),outputs=hasRight?[['right','/right',right],['left','/left',left]]:[['left','/left',left]],args=[...input('/a',rates[0]!),...input('/b',rates[1]!),'-filter_complex',graph,...outputs.flatMap(([label,path])=>['-map',`[${label}]`,'-bitexact','-f',format,path!])],nativeArgs=['-v','error','-nostdin','-y','-filter_complex_threads','1',...input(join(directory,'a'),rates[0]!),...input(join(directory,'b'),rates[1]!),'-filter_complex',graph,...outputs.flatMap(([label,,path])=>['-map',`[${label}]`,'-c:v','rawvideo','-threads:v','1','-bitexact','-f',format,path!])];
 execFileSync('.build/reference/ffmpeg',nativeArgs,{timeout:10000});const result=await new FFmpeg({filesystem:io.filesystem,budget,backend:createMediaBackend({pixelArithmetic:arithmetic})}).exec(args);expect(result.exitCode,JSON.stringify({rates,format,graph,diagnostics:result.diagnostics})).toBe(0);
 for(const [,path,native]of outputs)expect(io.published.get(path!),`${rates}/${format}/${graph}/${path}`).toEqual(new Uint8Array(readFileSync(native!)));expect([...io.readers.values()]).toEqual([1,1]);expect(io.stages.size).toBe(0);checked++;
 }expect(checked).toBe(24);}finally{rmSync(directory,{recursive:true,force:true});}
},60000);
it('aborts all outputs after a version-change read error',async()=>{
 const io=memory(new Map([['/a',data(10,5)],['/b',data(100,5)]]),{read(path,offset){if(path==='/a'&&offset>=8n)throw new Error('Input version changed');}}),result=await frontend(io.filesystem).exec([...input('/a','25'),...input('/b','30'),'-filter_complex','[0:v][1:v]hstack,split[x][y]','-map','[x]','-f','rawvideo','/x','-map','[y]','-f','rawvideo','/y']);expect(result.exitCode).toBe(1);expect(io.published.size).toBe(0);expect(io.stages.size).toBe(0);expect(result.outputs).toEqual([]);
});
it('preserves confirmed publication and uncertain later output effects',async()=>{
 const io=memory(new Map([['/a',data(10,3)],['/b',data(100,3)]]),{commit(path){if(path==='/y')throw new Error('Acknowledgement lost');}}),result=await frontend(io.filesystem).exec([...input('/a','25'),...input('/b','30'),'-filter_complex','[0:v][1:v]hstack,split[x][y]','-map','[x]','-f','rawvideo','/x','-map','[y]','-f','rawvideo','/y']);expect(result.exitCode).toBe(1);expect(result.outputs).toEqual(['/x']);expect((result.error as {effects:{status:string}[]}).effects.map(effect=>effect.status)).toEqual(['published','uncertain']);
});
it('preflights invalid source bindings before opening storage',async()=>{
 const io=memory(new Map());const result=await frontend(io.filesystem).exec([...input('/a','25'),...input('/b','30'),'-filter_complex','[0:v][2:v]hstack[o]','-map','[o]','-f','rawvideo','/out']);expect(result.exitCode).toBe(1);expect(io.opens).toBe(0);
});

it('holds input reads under slow sink backpressure and cancels after in-flight writes drain',async()=>{
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;}),controller=new AbortController(),io=memory(new Map([['/a',data(10,20)],['/b',data(100,20)]]),{async write(){started();await gate;}}),task=frontend(io.filesystem).exec([...input('/a','25'),...input('/b','25'),'-filter_complex','[0:v][1:v]hstack[o]','-map','[o]','-f','rawvideo','/out'],{signal:controller.signal});
 await began;const reads=io.reads;await new Promise(resolve=>setTimeout(resolve,0));expect(io.reads).toBe(reads);expect(reads).toBeLessThanOrEqual(8);expect(io.published.size).toBe(0);controller.abort();release();const result=await task;expect(result.exitCode).toBe(1);expect(result.diagnostics[0]?.code).toBe('cancelled');expect(io.stages.size).toBe(0);expect(io.published.size).toBe(0);
});
it('initializes zero-frame graph parameters with bounded first packets matching Native',async()=>{
 const io=memory(new Map([['/a',data(10,20)],['/b',data(100,20)]])),result=await frontend(io.filesystem).exec([...input('/a','25'),...input('/b','30'),'-filter_complex','[0:v][1:v]hstack[o]','-map','[o]','-frames:v','0','-bitexact','-f','framecrc','/out']);expect(result.exitCode,result.diagnostics[0]?.message).toBe(0);expect(io.reads).toBe(4);expect([...io.readers.values()]).toEqual([1,1]);expect(io.stages.size).toBe(0);
 const directory=mkdtempSync(join(tmpdir(),'edge-zero-frames-'));try{writeFileSync(join(directory,'a'),data(10,20));writeFileSync(join(directory,'b'),data(100,20));execFileSync('.build/reference/ffmpeg',['-v','debug','-nostdin','-y','-filter_complex_threads','1',...input(join(directory,'a'),'25'),...input(join(directory,'b'),'30'),'-filter_complex','[0:v][1:v]hstack[o]','-map','[o]','-frames:v','0','-c:v','rawvideo','-threads:v','1','-bitexact','-f','framecrc',join(directory,'out')],{timeout:10000,stdio:['ignore','ignore','pipe']});expect(io.published.get('/out')).toEqual(new Uint8Array(readFileSync(join(directory,'out'))));}finally{rmSync(directory,{recursive:true,force:true});}
});
