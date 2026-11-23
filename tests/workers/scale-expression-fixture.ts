import {evaluateScaleExpression} from '../helpers/scale-expression.js';
import type {ScaleExpressionCase} from '../helpers/scale-expression.js';
const maximumBodyBytes=64*1024;
function validCase(value:unknown):value is ScaleExpressionCase {
 if(!value||typeof value!=='object')return false;const row=value as Record<string,unknown>,text=(v:unknown)=>typeof v==='string'&&v.length<=4096&&!v.includes('\0');
 if(!Array.isArray(row.initial)||row.initial.length!==2||!row.initial.every(text)||!Array.isArray(row.ops)||row.ops.length>16||!row.ops.every(op=>Array.isArray(op)&&op.length===2&&op.every(text)))return false;
 if(row.options!==undefined){if(!row.options||typeof row.options!=='object')return false;const opt=row.options as Record<string,unknown>;if(Object.keys(opt).some(key=>!['sar','forceOriginalAspectRatio','forceDivisibleBy','resetSar'].includes(key)))return false;if(opt.sar!==undefined&&(typeof opt.sar!=='number'||!Number.isFinite(opt.sar)||opt.sar<0||opt.sar>2))return false;if(opt.forceOriginalAspectRatio!==undefined&&![0,1,2].includes(opt.forceOriginalAspectRatio as number))return false;if(opt.forceDivisibleBy!==undefined&&(!Number.isInteger(opt.forceDivisibleBy)||Number(opt.forceDivisibleBy)<1||Number(opt.forceDivisibleBy)>256))return false;if(opt.resetSar!==undefined&&typeof opt.resetSar!=='boolean')return false;}return true;
}
export default {async fetch(request:Request):Promise<Response>{
 const length=request.headers.get('content-length');if(length!==null&&Number(length)>maximumBodyBytes)return new Response('Fixture body too large',{status:413});
 const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
 if(reader){try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maximumBodyBytes){await reader.cancel();return new Response('Fixture body too large',{status:413});}chunks.push(next.value);}}finally{reader.releaseLock();}}
 const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
 try{
  const cases:unknown=JSON.parse(new TextDecoder().decode(body));if(!Array.isArray(cases)||cases.length>16||!cases.every(validCase))return new Response('Invalid scale expression batch',{status:400});
  return Response.json(cases.map(evaluateScaleExpression));
 }catch{return new Response('Invalid scale expression fixture operation',{status:400});}
}};
