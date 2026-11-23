import {createR2FileSystem,createR2SpoolStore} from '@edge-ffmpeg/storage-r2';
import {createTimedEventCodec} from '@edge-ffmpeg/avformat';
import type {R2Bucket} from '@cloudflare/workers-types';
import {runTimedVideoCase,timedVideoInput} from '../helpers/timed-video-backend.js';
import type {TimedVideoCase} from '../helpers/timed-video-backend.js';
const maximumBodyBytes=64*1024;
export default {async fetch(request:Request,env:{BUCKET:R2Bucket}):Promise<Response>{
 const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;if(reader){try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maximumBodyBytes){await reader.cancel();return new Response('Too large',{status:413});}chunks.push(next.value);}}finally{reader.releaseLock();}}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 let row:TimedVideoCase,profile:'darwin-arm64'|'linux-x64';try{const data=JSON.parse(new TextDecoder().decode(bytes)) as {row:TimedVideoCase;profile:typeof profile};row=data.row;profile=data.profile;if(!row||typeof row.pixelFormat!=='string'||typeof row.filter!=='string'||row.filter.length>4096||![0,1,4].includes(row.frames)||!['darwin-arm64','linux-x64'].includes(profile))throw new Error('Invalid request');timedVideoInput(row);}catch{return new Response('Invalid fixture case',{status:400});}
 const id=crypto.randomUUID(),source='source/'+id,output='result/'+id;await env.BUCKET.put(source+'/one',timedVideoInput(row));
 const codec=createTimedEventCodec({maxRecordBytes:8192,maxNodes:512,maxErrors:16});
 try{
  const filesystem=createR2FileSystem({bucket:env.BUCKET,mounts:{'/input':source,'/output':output},maxReadBytes:4096,output:{writableMounts:['/output'],stagingPrefix:'command-staging',partBytes:5*1024*1024,maxWriteBytes:4096,maxOutputBytes:65536}}),result=await runTimedVideoCase(row,profile,filesystem,()=>createR2SpoolStore(env.BUCKET,codec,{maxRecordBytes:8192,maxWrittenBytes:262144}));
  const object=await env.BUCKET.get(output+'/out'),text=object?await object.text():null,objects=(await env.BUCKET.list()).objects,temporary=objects.filter(object=>!object.key.startsWith(output+'/')&&!object.key.startsWith(source+'/')).length;
  return Response.json({exitCode:result.exitCode,outputs:result.outputs,diagnostics:result.diagnostics,text,temporary});
 }finally{codec.close();const objects=(await env.BUCKET.list()).objects;for(const object of objects)await env.BUCKET.delete(object.key);}
}};
