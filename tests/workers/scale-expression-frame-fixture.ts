import {evaluateScaleFrame} from '../helpers/scale-expression-frame.js';
import type {ScaleFrameCase} from '../helpers/scale-expression-frame.js';
const maximumBodyBytes=64*1024;
function validCase(value:unknown):value is ScaleFrameCase {
 if(!value||typeof value!=='object')return false;const row=value as Record<string,unknown>,text=(v:unknown)=>typeof v==='string'&&v.length<=4096&&!v.includes('\0');
 if(typeof row.format!=='string'||!['gray','rgb24','bgr24','rgba','bgra','argb','abgr','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','gbrp'].includes(row.format)||!Array.isArray(row.initial)||row.initial.length!==2||!row.initial.every(text)||!Array.isArray(row.ops)||row.ops.length>16)return false;
 return row.ops.every(op=>{if(!Array.isArray(op))return false;if(op[0]==='c')return op.length===3&&text(op[1])&&text(op[2]);return op[0]==='f'&&op.length===2&&typeof op[1]==='string'&&/^-?\d{1,20}$/.test(op[1])&&BigInt(op[1])>=-(1n<<63n)&&BigInt(op[1])<(1n<<63n);});
}
export default {async fetch(request:Request):Promise<Response>{
 const length=request.headers.get('content-length');if(length!==null&&Number(length)>maximumBodyBytes)return new Response('Fixture body too large',{status:413});
 const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
 if(reader){try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maximumBodyBytes){await reader.cancel();return new Response('Fixture body too large',{status:413});}chunks.push(next.value);}}finally{reader.releaseLock();}}
 const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
 try{
  const cases:unknown=JSON.parse(new TextDecoder().decode(body));if(!Array.isArray(cases)||cases.length>16||!cases.every(validCase))return new Response('Invalid scale expression batch',{status:400});
  return Response.json(cases.map(evaluateScaleFrame));
 }catch{return new Response('Invalid scale expression fixture operation',{status:400});}
}};
