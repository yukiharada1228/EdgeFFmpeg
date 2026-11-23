import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions} from '@edge-ffmpeg/avformat';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import type {ExpressionNumericProfile} from '@edge-ffmpeg/avutil';
import type {TimedVideoOutputEvent} from '@edge-ffmpeg/avfilter';
export interface TimedVideoCase {pixelFormat:string;filter:string;frames:number}
export function timedVideoArgv(row:TimedVideoCase):string[]{return ['-y','-f','rawvideo','-pixel_format',row.pixelFormat,'-video_size','3x2','-framerate','25','-i','/input/one','-filter_complex',`[0:v]${row.filter}[x]`,'-map','[x]','-frames:v',String(row.frames),'-fps_mode','passthrough','-enc_time_base','filter','-c:v','rawvideo','-bitexact','-f','framecrc','/output/out'];}
export function timedVideoInput(row:TimedVideoCase){return Uint8Array.from({length:pixelLayout(row.pixelFormat,3,2).bytes*4},(_,index)=>index%251);}
export async function runTimedVideoCase(row:TimedVideoCase,numericProfile:ExpressionNumericProfile,filesystem:VirtualFileSystem,storage:TimedVideoBackendOptions['storage']){
 const ffmpeg=new FFmpeg({filesystem,backend:createTimedVideoBackend({storage,limits:{numericProfile,maxEvents:128}}),budget:{maxResidentBytes:32*1024*1024,maxBufferBytes:4096,maxPendingPackets:32,maxCpuTimeMs:10000}});
 return ffmpeg.exec(timedVideoArgv(row));
}
export async function evaluateMemoryTimedVideo(row:TimedVideoCase,profile:ExpressionNumericProfile){
 const input=timedVideoInput(row),published=new Map<string,Uint8Array>(),stores:{values:Map<number,TimedVideoOutputEvent>;closed:number}[]=[];let pending=0;
 const filesystem:VirtualFileSystem={async openRead(path){if(path!=='/input/one')throw new Error('Unknown fixture input');return {size:BigInt(input.length),async readAt(offset,length,signal){signal?.throwIfAborted();return input.slice(Number(offset),Number(offset)+length);}};},async openWrite(path){const chunks:Uint8Array[]=[];pending++;let ended=false;const end=()=>{if(!ended){ended=true;pending--;}};return {async write(bytes){chunks.push(bytes.slice());},async commit(){const bytes=new Uint8Array(chunks.reduce((total,chunk)=>total+chunk.length,0));let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}published.set(path,bytes);end();},async abort(){chunks.length=0;end();}};}};
 const storage:TimedVideoBackendOptions['storage']=()=>{const store={values:new Map<number,TimedVideoOutputEvent>(),closed:0};stores.push(store);return {async append(index,value){store.values.set(index,structuredClone(value));},async read(index){const value=store.values.get(index);if(!value)throw new Error('Missing fixture event');return structuredClone(value);},async discardBefore(index){for(const key of store.values.keys())if(key<index)store.values.delete(key);},async close(){store.closed++;store.values.clear();}};};
 const result=await runTimedVideoCase(row,profile,filesystem,storage);
 return {exitCode:result.exitCode,outputs:result.outputs,diagnostics:result.diagnostics,text:new TextDecoder().decode(published.get('/output/out')),pending,storesClosed:stores.every(store=>store.closed===1&&store.values.size===0)};
}
