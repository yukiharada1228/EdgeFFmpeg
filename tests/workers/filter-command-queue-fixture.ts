import {evaluateFilterCommandQueue} from '../helpers/filter-command-queue.js';
import type {FilterCommandQueueCase} from '../helpers/filter-command-queue.js';
const maximumBodyBytes=64*1024;
function validCase(value:unknown):value is FilterCommandQueueCase {
 if(!value||typeof value!=='object')return false;
 const row=value as Record<string,unknown>;
 if(typeof row.timeBase!=='string'||!['1/25','1001/30000'].includes(row.timeBase)||!Array.isArray(row.ops)||row.ops.length>64)return false;
 return row.ops.every(op=>{if(!Array.isArray(op))return false;if(op[0]==='e')return op.length===1;if(op[0]==='f')return op.length===2&&typeof op[1]==='string'&&/^-?\d{1,20}$/.test(op[1])&&BigInt(op[1])>=-(1n<<63n)&&BigInt(op[1])<(1n<<63n);if(op[0]!=='q'||op.length!==6)return false;return Number.isInteger(op[1])&&op[1]>=-1&&op[1]<=2&&Number.isInteger(op[2])&&op[2]>=-2147483648&&op[2]<=2147483647&&typeof op[3]==='string'&&op[3].length<=32&&(['NaN','Infinity','-Infinity'].includes(op[3])||/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(op[3]))&&['unknown','strip_fps','other'].includes(op[4])&&typeof op[5]==='string'&&op[5].length<=4096;});
}
export default {async fetch(request:Request):Promise<Response>{
 const length=request.headers.get('content-length');if(length!==null&&Number(length)>maximumBodyBytes)return new Response('Fixture body too large',{status:413});
 const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
 if(reader){try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maximumBodyBytes){await reader.cancel();return new Response('Fixture body too large',{status:413});}chunks.push(next.value);}}finally{reader.releaseLock();}}
 const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
 try{
  const cases:unknown=JSON.parse(new TextDecoder().decode(body));if(!Array.isArray(cases)||cases.length>4||!cases.every(validCase))return new Response('Invalid filter command queue batch',{status:400});
  return Response.json(cases.map(evaluateFilterCommandQueue));
 }catch{return new Response('Invalid filter command queue fixture operation',{status:400});}
}};
