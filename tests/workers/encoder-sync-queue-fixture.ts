import {evaluateEncoderSync} from '../helpers/encoder-sync-queue.js';
import type {EncoderSyncCase} from '../helpers/encoder-sync-queue.js';
const maximumBodyBytes=256*1024;
function validCase(value:unknown):value is EncoderSyncCase {
 if(!value||typeof value!=='object')return false;
 const row=value as Record<string,unknown>;
 return Array.isArray(row.limiting)&&row.limiting.length>0&&row.limiting.length<=32&&row.limiting.every(flag=>typeof flag==='boolean')&&typeof row.bufferUs==='string'&&/^\d{1,20}$/.test(row.bufferUs)&&Array.isArray(row.ops)&&row.ops.length<=1024&&row.ops.every(op=>Array.isArray(op)&&op.length>0&&op.length<=8&&op.every(value=>typeof value==='string'?value.length<=32:typeof value==='number'&&Number.isSafeInteger(value)));
}
export default {async fetch(request:Request):Promise<Response>{
 const length=request.headers.get('content-length');if(length!==null&&Number(length)>maximumBodyBytes)return new Response('Fixture body too large',{status:413});
 const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
 if(reader){try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maximumBodyBytes){await reader.cancel();return new Response('Fixture body too large',{status:413});}chunks.push(next.value);}}finally{reader.releaseLock();}}
 const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
 try{
  const cases:unknown=JSON.parse(new TextDecoder().decode(body));if(!Array.isArray(cases)||cases.length>4||!cases.every(validCase))return new Response('Invalid encoder queue batch',{status:400});
  const digests=[];for(const row of cases){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(evaluateEncoderSync(row))));digests.push([...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join(''));}return Response.json(digests);
 }catch{return new Response('Invalid encoder queue fixture operation',{status:400});}
}};
