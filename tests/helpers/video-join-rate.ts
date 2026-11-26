// Native differential cases of the shared join clock (packages/avfilter/src/video-join.ts): unequal input frame rates
// and lengths in both input orders, against the reference built from upstream/ffmpeg. A join operator's own
// differential test calls compareJoinRates with its declared props (docs/contributing/video-filter-registry.md, join).
import {expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import type {Rational} from '@edge-ffmpeg/avutil';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {ExecutionBackend} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import {collectingOutput} from './output.js';
export const ffmpeg=resolve('.build/reference/ffmpeg');
/** Input 0 at the first rate and every other input at the second, so swapping the pair covers both input orders. */
export const ratePairs=[['25','10'],['10','25'],['30000/1001','25'],['25','30000/1001']] as const;
/** Input 0's length first; every other input has the second. */
export const lengthPairs=[[5,2],[2,5]] as const;
export const rational=(text:string):Rational=>{const [num,den='1']=text.split('/');return {num:BigInt(num!),den:BigInt(den)};};
export const pattern=(frames:number,salt:number)=>{let seed=salt*7919+17;return Uint8Array.from({length:48*frames},(_,i)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return i%2?seed>>>24:(i*31+salt*17)&255;});};
export const raw=(rate:string,path:string)=>['-f','rawvideo','-pixel_format','gray','-video_size','8x6','-framerate',rate,'-i',path];
export const native=(args:readonly string[])=>{const result=spawnSync(ffmpeg,['-hide_banner','-nostats','-v','error','-cpuflags','0',...args,'-'],{maxBuffer:1<<24,timeout:20000});return {status:result.status,stdout:result.stdout};};
const memoryStore=()=>{const records=new Map<number,unknown>();return {async append(index:number,value:unknown){records.set(index,value);},async read(index:number){return records.get(index) as never;},async discardBefore(index:number){for(const key of records.keys())if(key<index)records.delete(key);},async close(){records.clear();}};};
const timed=(scheduler:'producer'|'pull')=>createTimedVideoBackend({storage:memoryStore,limits:{numericProfile:'linux-x64',maxEvents:64,scheduler}});
export const backends:Readonly<Record<string,()=>ExecutionBackend>>={stream:()=>createMediaBackend({pixelArithmetic:'scalar'}),actor:()=>timed('producer'),timed:()=>timed('pull')};
export const frontend=(files:ReadonlyMap<string,Uint8Array>,backend:ExecutionBackend,open:()=>ReturnType<typeof collectingOutput>['output'])=>new FFmpeg({filesystem:{async openRead(path){const input=files.get(path);if(!input)throw new Error('Missing '+path);return {size:BigInt(input.length),async readAt(offset,length){return input.slice(Number(offset),Number(offset)+Math.min(length,4096));}};},async openWrite(){return open();}},backend,budget:{maxResidentBytes:1<<22,maxBufferBytes:65536,maxPendingPackets:8,maxCpuTimeMs:20000}});
const muxers=[['framecrc',[]],['rawvideo',[]],['framecrc',['-enc_time_base','demux']]] as const;
/**
 * One join compared byte for byte with native on the stream, actor and timed backends, for every rate pair (input 0 at
 * the first rate, every other input at the second: 25/10, 10/25, 30000/1001 vs 25 and 25 vs 30000/1001), every length
 * pair (5/2 and 2/5 frames) and framecrc, rawvideo and framecrc with -enc_time_base demux. ours and theirs are the
 * filter tokens of each side (equal for a registered filter); props is the declared join props: under 'none' both
 * sides must refuse -enc_time_base demux before any output. fill gives constant planes of chosen inputs. Returns
 * [identical outputs, refusals]: [72, 0] under props 'base' and [48, 24] under 'none'.
 */
export async function compareJoinRates({ours,theirs=ours,inputs,props,fill={}}:{ours:string;theirs?:string;inputs:number;props:'none'|'base';fill?:Readonly<Record<number,number>>}):Promise<[number,number]>{
 const demux=props==='base';
 const root=mkdtempSync(join(tmpdir(),'edge-join-rate-'));let count=0,refused=0;
 try{
  for(const rates of ratePairs)for(const lengths of lengthPairs){
   const data=Array.from({length:inputs},(_,index)=>{const frames=index?lengths[1]:lengths[0],value=fill[index];return value===undefined?pattern(frames,index+inputs):new Uint8Array(48*frames).fill(value);}),files=new Map(data.map((value,index)=>[`/${index}`,value]));
   for(const [index,value]of data.entries())writeFileSync(join(root,`${index}.raw`),value);
   const graph=(filter:string)=>`${data.map((_,index)=>`[${index}:v]`).join('')}${filter}[o]`;
   for(const [muxer,extra]of muxers){
    const args=(filter:string,path:(index:number)=>string)=>[...data.flatMap((_,index)=>raw(index?rates[1]:rates[0],path(index))),'-filter_complex',graph(filter),'-map','[o]',...extra,'-f',muxer];
    const expected=native(args(theirs,index=>join(root,`${index}.raw`)));
    for(const [name,backend]of Object.entries(backends)){
     const sink=collectingOutput(),result=await frontend(files,backend(),()=>sink.output).exec(['-y',...args(ours,index=>`/${index}`),'/out']),label=`${theirs}/${rates}/${lengths}/${muxer}${extra.join('')}/${name}`;
     if(extra.length&&!demux){
      // Outputs from ff_get_video_buffer carry no decoder time base to the encoder.
      expect(expected.status,label).toBe(234);expect(expected.stdout.length,label).toBe(0);expect(result.exitCode,label).not.toBe(0);expect(sink.committed,label).toBe(false);expect(sink.bytes().length,label).toBe(0);
      expect(JSON.stringify(result.diagnostics),label).toContain('Demuxing timebase not available');refused++;continue;
     }
     expect(expected.status,label).toBe(0);expect(result.exitCode,label+JSON.stringify(result.diagnostics)).toBe(0);expect(Buffer.from(sink.bytes()),label).toEqual(expected.stdout);expect(expected.stdout.length,label).toBeGreaterThan(0);expect(sink.committed,label).toBe(true);count++;
    }
   }
  }
 }finally{rmSync(root,{recursive:true,force:true});}
 return [count,refused];
}
