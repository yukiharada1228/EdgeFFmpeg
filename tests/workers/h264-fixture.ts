import module from './openh264.wasm';
import {evaluateH264} from '../helpers/h264.js';
import type {H264Case} from '../helpers/h264.js';
export default {async fetch(request:Request){
 const reader=request.body?.getReader(),parts:Uint8Array[]=[];let size=0;if(!reader)return new Response('Missing body',{status:400});
 try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>8388608){await reader.cancel();return new Response('Body limit',{status:413});}parts.push(next.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
 const row=JSON.parse(new TextDecoder().decode(bytes)) as H264Case;
 if(!Array.isArray(row.packets)||row.packets.length>64||row.packets.some(p=>typeof p!=='string'||p.length>1398104))return new Response('Invalid packets',{status:400});
 return Response.json(await evaluateH264(module,row));
}};
