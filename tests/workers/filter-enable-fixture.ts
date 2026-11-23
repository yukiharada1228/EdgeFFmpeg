import {evaluateFilterEnable} from '../helpers/filter-enable.js';
import type {FilterEnableCase} from '../helpers/filter-enable.js';
const maximumBodyBytes=32*1024;
function validCase(value:unknown):value is FilterEnableCase {
 if(!value||typeof value!=='object')return false;
 const row=value as Record<string,unknown>;
 return typeof row.graph==='string'&&['hflip','vflip','hflip,vflip'].includes(row.graph)&&Array.isArray(row.ops)&&row.ops.length<=16&&row.ops.every(op=>Array.isArray(op)&&(op[0]==='f'?op.length===2&&typeof op[1]==='string'&&/^-?\d{1,20}$/.test(op[1]):op[0]==='c'&&op.length===3&&Number.isInteger(op[1])&&op[1]>=0&&op[1]<(row.graph as string).split(',').length&&typeof op[2]==='string'&&op[2].length<=4096));
}
export default {async fetch(request:Request):Promise<Response>{
 const length=request.headers.get('content-length');if(length!==null&&Number(length)>maximumBodyBytes)return new Response('Fixture body too large',{status:413});
 const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
 if(reader){try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maximumBodyBytes){await reader.cancel();return new Response('Fixture body too large',{status:413});}chunks.push(next.value);}}finally{reader.releaseLock();}}
 const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
 try{
  const cases:unknown=JSON.parse(new TextDecoder().decode(body));if(!Array.isArray(cases)||cases.length>4||!cases.every(validCase))return new Response('Invalid encoder queue batch',{status:400});
  return Response.json(cases.map(evaluateFilterEnable));
 }catch{return new Response('Invalid encoder queue fixture operation',{status:400});}
}};
