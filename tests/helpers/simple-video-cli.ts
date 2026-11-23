import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions} from '@edge-ffmpeg/avformat';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import type {ExpressionNumericProfile} from '@edge-ffmpeg/avutil';
import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
export interface SimpleVideoCase {backend?:'media'|'timed';id:string;argv:string[];inputs:{path:string;bytes:number[]}[]}
export async function evaluateSimpleVideoCase(data:SimpleVideoCase,numericProfile:ExpressionNumericProfile){
 const input=new Map(data.inputs.map(row=>[row.path,Uint8Array.from(row.bytes)])),published=new Map<string,string>(),stores:{closed:number;values:Map<number,TimedVideoOutputEvent>}[]=[],reads:Record<string,number>={};let pending=0;
 const filesystem:VirtualFileSystem={async openRead(path){const bytes=input.get(path);if(!bytes)throw new Error('Missing input');reads[path]=(reads[path]??0)+1;return {size:BigInt(bytes.length),async readAt(offset,length,signal){signal?.throwIfAborted();return bytes.slice(Number(offset),Number(offset)+length);}};},async openWrite(path){const chunks:Uint8Array[]=[];pending++;let closed=false;const close=()=>{if(!closed){pending--;closed=true;}};return {async write(bytes){chunks.push(bytes.slice());},async commit(){published.set(path,chunks.map(chunk=>new TextDecoder().decode(chunk)).join(''));close();},async abort(){chunks.length=0;close();}};}};
 const storage:TimedVideoBackendOptions['storage']=()=>{const store={closed:0,values:new Map<number,TimedVideoOutputEvent>()};stores.push(store);return {async append(index,value){store.values.set(index,structuredClone(value));},async read(index){const value=store.values.get(index);if(!value)throw new Error('Missing event');return structuredClone(value);},async discardBefore(index){for(const key of store.values.keys())if(key<index)store.values.delete(key);},async close(){store.closed++;store.values.clear();}};};
 const ffmpeg=new FFmpeg({filesystem,backend:data.backend==='media'?createMediaBackend({pixelArithmetic:numericProfile==='linux-x64'?'x86_64':'aarch64'}):createTimedVideoBackend({storage,limits:{numericProfile,maxEvents:128}}),budget:{maxResidentBytes:32*1024*1024,maxBufferBytes:4096,maxCpuTimeMs:10000,maxPendingPackets:32}}),result=await ffmpeg.exec(data.argv);
 return {exitCode:result.exitCode,outputs:result.outputs,diagnostics:result.diagnostics,rows:Object.fromEntries(published),pending,storesClosed:stores.every(store=>store.closed===1&&store.values.size===0),reads};
}

