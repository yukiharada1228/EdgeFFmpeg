import {evaluateNumberRational} from '../helpers/number-rational.js';
import type {NumberRationalCase} from '../helpers/number-rational.js';
const maximumBodyBytes=64*1024;
function validCase(value:unknown):value is NumberRationalCase {
 if(!value||typeof value!=='object')return false;const row=value as Record<string,unknown>;
 return typeof row.bits==='string'&&/^[0-9a-fA-F]{16}$/.test(row.bits)&&typeof row.max==='number'&&Number.isInteger(row.max)&&row.max>=1&&row.max<=2147483647;
}
export default {async fetch(request:Request):Promise<Response>{
 const length=request.headers.get('content-length');if(length!==null&&Number(length)>maximumBodyBytes)return new Response('Fixture body too large',{status:413});
 const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
 if(reader){try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maximumBodyBytes){await reader.cancel();return new Response('Fixture body too large',{status:413});}chunks.push(next.value);}}finally{reader.releaseLock();}}
 const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
 try{
  const cases:unknown=JSON.parse(new TextDecoder().decode(body));if(!Array.isArray(cases)||cases.length>128||!cases.every(validCase))return new Response('Invalid bounded rational batch',{status:400});
  return Response.json(cases.map(evaluateNumberRational));
 }catch{return new Response('Invalid bounded rational fixture operation',{status:400});}
}};
