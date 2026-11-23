import {evaluateBoundedRational} from '../helpers/bounded-rational.js';
import type {BoundedRationalCase} from '../helpers/bounded-rational.js';
const maximumBodyBytes=64*1024;
function validCase(value:unknown):value is BoundedRationalCase {
 if(!Array.isArray(value)||value.length!==3||!value.every(part=>typeof part==='string'&&/^-?\d{1,19}$/.test(part)))return false;
 const [num,den,max]=value.map(BigInt) as [bigint,bigint,bigint],limit=9223372036854775807n;
 return num>=-limit&&num<=limit&&den>=-limit&&den<=limit&&max>=1n&&max<=2147483647n;
}
export default {async fetch(request:Request):Promise<Response>{
 const length=request.headers.get('content-length');if(length!==null&&Number(length)>maximumBodyBytes)return new Response('Fixture body too large',{status:413});
 const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
 if(reader){try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maximumBodyBytes){await reader.cancel();return new Response('Fixture body too large',{status:413});}chunks.push(next.value);}}finally{reader.releaseLock();}}
 const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
 try{
  const cases:unknown=JSON.parse(new TextDecoder().decode(body));if(!Array.isArray(cases)||cases.length>128||!cases.every(validCase))return new Response('Invalid bounded rational batch',{status:400});
  return Response.json(cases.map(evaluateBoundedRational));
 }catch{return new Response('Invalid bounded rational fixture operation',{status:400});}
}};
