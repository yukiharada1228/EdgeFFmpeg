import {it,expect} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import type {PixelArithmetic} from '@edge-ffmpeg/swscale';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
const budget={maxResidentBytes:1048576,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:10000},input=(path:string,rate:string)=>['-f','rawvideo','-pixel_format','gray','-s','2x2','-framerate',rate,'-i',path],data=(base:number,count:number)=>Uint8Array.from({length:count*4},(_,i)=>base+Math.floor(i/4));
function memory(inputs:Map<string,Uint8Array>,faults:{read?:(path:string,offset:bigint)=>void;commit?:(path:string)=>void;write?:(path:string)=>Promise<void>}={}){
 const published=new Map<string,Uint8Array>(),stages=new Map<string,Uint8Array[]>(),readers=new Map<string,number>();let opens=0,reads=0;
 const filesystem:VirtualFileSystem={async openRead(path){opens++;readers.set(path,(readers.get(path)??0)+1);const bytes=inputs.get(path);if(!bytes)throw new Error('Missing input');return {size:BigInt(bytes.length),async readAt(offset,length){reads++;faults.read?.(path,offset);return bytes.slice(Number(offset),Number(offset)+Math.min(length,2));}};},async openWrite(path){opens++;const parts:Uint8Array[]=[];stages.set(path,parts);return {async write(chunk){await faults.write?.(path);parts.push(chunk.slice());},async commit(){faults.commit?.(path);const bytes=Uint8Array.from(parts.flatMap(part=>[...part]));published.set(path,bytes);stages.delete(path);},async abort(){stages.delete(path);}};}};
 return {filesystem,published,stages,readers,get opens(){return opens;},get reads(){return reads;}};
}
const frontend=(filesystem:VirtualFileSystem,arithmetic:PixelArithmetic='aarch64')=>new FFmpeg({filesystem,budget,backend:createMediaBackend({pixelArithmetic:arithmetic})});
it('matches complete native single-input complex-graph files with scoped output clocks',async()=>{
 const arithmetic=referencePixelArithmetic(),directory=mkdtempSync(join(tmpdir(),'edge-single-clock-'));let checked=0;
 try{for(const rate of ['25','30','30000/1001','50/2'])for(const count of [5,1,0])for(const before of [[],['-ss','0.02']])for(const after of [[],['-ss','0.02','-t','0.08']])for(const clock of [[],['-r','20','-fps_mode','cfr'],['-r','30000/1001','-enc_time_base','filter'],['-fps_mode','passthrough','-enc_time_base','1/1000'],['-fps_mode','vfr','-enc_time_base','filter'],['-fps_mode','cfr','-enc_time_base','1/(25*2)']])for(const format of ['rawvideo','framecrc'])for(const graph of ['[0:v]null[o]','[0:v]hflip[o]','[0:v]split[a][b];[a][b]hstack[o]','[0:v][0:v]hstack[o]']){
 const bytes=data(10,count),io=memory(new Map([['/a',bytes]])),path=join(directory,'a'),nativePath=join(directory,'out');writeFileSync(path,bytes);const output=['-map','[o]',...after,...clock,'-bitexact','-f',format],native=spawnSync('.build/reference/ffmpeg',['-v','error','-nostdin','-y','-filter_complex_threads','1',...before,...input(path,rate),'-filter_complex',graph,...output,'-c:v','rawvideo','-threads:v','1',nativePath],{encoding:'utf8',timeout:10000}),actual=await frontend(io.filesystem,arithmetic).exec([...before,...input('/a',rate),'-filter_complex',graph,...output,'/out']),context=JSON.stringify({rate,count,before,after,clock,format,graph});
 expect(native.error,context).toBeUndefined();expect(native.status,context+' '+native.stderr).toBe(0);expect(actual.exitCode,context+' '+JSON.stringify(actual.diagnostics)).toBe(0);expect(io.published.get('/out'),context).toEqual(new Uint8Array(readFileSync(nativePath)));expect([...io.readers.values()]).toEqual([1]);expect(io.stages.size).toBe(0);checked++;
 }expect(checked).toBe(2304);}finally{rmSync(directory,{recursive:true,force:true});}
},120000);
