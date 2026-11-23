import {expect,it} from 'vitest';import {FFmpeg} from '@edge-ffmpeg/core';import type {VirtualFileSystem} from '@edge-ffmpeg/core';import {executeComplexVideo} from '../../packages/avformat/src/complex-video.js';
const budget={maxResidentBytes:1024*1024,maxBufferBytes:65536,maxPendingPackets:4,maxCpuTimeMs:10000},argv=['-f','rawvideo','-pixel_format','gray','-s','3x2','-i','/input.raw','-filter_complex','[0:v]split[a][b];[a]hflip[left];[b]vflip[right]','-map','[left]','-f','rawvideo','/left.raw','-map','[right]','-f','rawvideo','/right.raw'];
function memory(input:Uint8Array,options:{write?:(path:string)=>Promise<void>;commit?:(path:string)=>Promise<void>;read?:(offset:bigint)=>void}={}){
 const published=new Map<string,Uint8Array>(),stages=new Map<string,Uint8Array[]>();let opens=0,reads=0;
 const filesystem:VirtualFileSystem={async openRead(){opens++;return {size:BigInt(input.length),async readAt(offset,length){reads++;options.read?.(offset);return input.slice(Number(offset),Number(offset)+Math.min(length,2));}};},async openWrite(path){opens++;const parts:Uint8Array[]=[];stages.set(path,parts);return {async write(bytes){await options.write?.(path);parts.push(bytes.slice());},async commit(){await options.commit?.(path);const all=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));let offset=0;for(const part of parts){all.set(part,offset);offset+=part.length;}published.set(path,all);stages.delete(path);},async abort(){stages.delete(path);}};}};
 return {filesystem,published,stages,get opens(){return opens;},get reads(){return reads;}};
}
const frontend=(fs:VirtualFileSystem,limits=budget)=>new FFmpeg({filesystem:fs,budget:limits,backend:{execute:executeComplexVideo}});
it('executes split branches with bounded reads and publishes all prepared outputs',async()=>{
 const io=memory(Uint8Array.of(1,2,3,4,5,6,11,12,13,14,15,16)),result=await frontend(io.filesystem).exec(argv);expect(result.exitCode,result.diagnostics[0]?.message).toBe(0);expect(result.outputs).toEqual(['/left.raw','/right.raw']);expect(io.published.get('/left.raw')).toEqual(Uint8Array.of(3,2,1,6,5,4,13,12,11,16,15,14));expect(io.published.get('/right.raw')).toEqual(Uint8Array.of(4,5,6,1,2,3,14,15,16,11,12,13));expect(io.stages.size).toBe(0);expect(io.reads).toBe(6);
});
it('applies output frame limits independently and still processes later frames for other outputs',async()=>{
 const io=memory(Uint8Array.of(1,2,3,4,5,6,11,12,13,14,15,16)),args=[...argv];args.splice(args.indexOf('/left.raw'),0,'-frames:v','1');const result=await frontend(io.filesystem).exec(args);expect(result.exitCode,result.diagnostics[0]?.message).toBe(0);expect(io.published.get('/left.raw')).toHaveLength(6);expect(io.published.get('/right.raw')).toHaveLength(12);
});
it('aborts every staged output when the source changes after one output has prepared',async()=>{
 const io=memory(Uint8Array.from({length:18},(_,i)=>i+1),{read(offset){if(offset>=6n)throw new Error('Input generation changed');}}),args=[...argv];args.splice(args.indexOf('/left.raw'),0,'-frames:v','1');const result=await frontend(io.filesystem).exec(args);expect(result.exitCode).toBe(1);expect(result.outputs).toEqual([]);expect(io.published.size).toBe(0);expect(io.stages.size).toBe(0);expect((result.error as {effects:{status:string}[]}).effects.every(effect=>effect.status==='aborted')).toBe(true);
});
it('reports confirmed publication if a later commit fails instead of hiding partial side effects',async()=>{
 const io=memory(Uint8Array.of(1,2,3,4,5,6),{async commit(path){if(path==='/right.raw')throw new Error('Lost publication acknowledgment');}}),result=await frontend(io.filesystem).exec(argv);expect(result.exitCode).toBe(1);expect(result.outputs).toEqual(['/left.raw']);expect((result.error as {effects:{path:string;status:string}[]}).effects).toEqual([{path:'/left.raw',status:'published'},{path:'/right.raw',status:'uncertain'}]);expect(io.published.has('/left.raw')).toBe(true);
});
it('reserves output queue slots before reading the next source frame under slow-sink backpressure',async()=>{
 let release!:()=>void,blocked=true,started!:()=>void,secondFrame!:()=>void;const observed=new Promise<void>(resolve=>{secondFrame=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;}),io=memory(Uint8Array.from({length:30},(_,i)=>i+1),{read(offset){if(offset===10n)secondFrame();},async write(path){if(path==='/left.raw'&&blocked){started();await gate;}}}),task=frontend(io.filesystem).exec(argv);
 await Promise.all([began,observed]);await new Promise(resolve=>setTimeout(resolve,0));expect(io.reads).toBe(6);expect(io.published.size).toBe(0);blocked=false;release();const result=await task;expect(result.exitCode,result.diagnostics[0]?.message).toBe(0);expect(io.published.get('/left.raw')).toHaveLength(30);
});
it('rejects invalid queue budgets and unbound maps before opening input or output handles',async()=>{
 const io=memory(Uint8Array.of(1,2,3,4,5,6));expect((await frontend(io.filesystem,{...budget,maxPendingPackets:1}).exec(argv)).exitCode).toBe(1);expect(io.opens).toBe(0);expect((await frontend(io.filesystem).exec(argv.slice(0,argv.indexOf('/left.raw')+1))).exitCode).toBe(1);expect(io.opens).toBe(0);
});
it('reads only the union of requested frame windows for independent output seeks',async()=>{
 const offsets:bigint[]=[],io=memory(Uint8Array.from({length:30},(_,i)=>i+1),{read(offset){offsets.push(offset);}}),args=[...argv];args.splice(args.indexOf('/left.raw'),0,'-frames:v','1');args.splice(args.indexOf('/right.raw'),0,'-ss','0.16','-frames:v','1');const result=await frontend(io.filesystem).exec(args);expect(result.exitCode,result.diagnostics[0]?.message).toBe(0);expect(offsets).toEqual([0n,2n,4n,24n,26n,28n]);expect(io.published.get('/right.raw')).toEqual(Uint8Array.of(28,29,30,25,26,27));
});
it('publishes zero-frame raw and framecrc outputs without reading a source frame',async()=>{
 const io=memory(new Uint8Array()),args=[...argv],left=args.indexOf('/left.raw');args[left-1]='framecrc';args.splice(left-2,0,'-bitexact');const result=await frontend(io.filesystem).exec(args);expect(result.exitCode,result.diagnostics[0]?.message).toBe(0);expect(io.reads).toBe(0);expect(io.published.get('/right.raw')).toHaveLength(0);expect(new TextDecoder().decode(io.published.get('/left.raw'))).toContain('#dimensions 0: 3x2');
});
it('cancels active output queues and drains in-flight writes before aborting all staged files',async()=>{
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;}),controller=new AbortController(),io=memory(Uint8Array.from({length:30},(_,i)=>i+1),{async write(path){if(path==='/left.raw'){started();await gate;}}}),task=frontend(io.filesystem).exec(argv,{signal:controller.signal});
 await began;controller.abort();release();const result=await task;expect(result.exitCode).toBe(1);expect(result.diagnostics[0]!.code).toBe('cancelled');expect(result.outputs).toEqual([]);expect(io.published.size).toBe(0);expect(io.stages.size).toBe(0);
});
