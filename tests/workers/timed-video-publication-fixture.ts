import {evaluatePublication} from '../helpers/timed-video-publication.js';
const scenarios=['ok','read-error','cancel-read','open-output-error','write-error','commit-error','ack-lost','uncertain-ack','cancel-after-left','store-close-error','abort-error'];
export default {async fetch(request:Request):Promise<Response>{
 const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;if(reader){try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>256){await reader.cancel();return new Response('Too large',{status:413});}chunks.push(next.value);}}finally{reader.releaseLock();}}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}let scenario:unknown;try{scenario=JSON.parse(new TextDecoder().decode(bytes));}catch{return new Response('Invalid scenario',{status:400});}if(typeof scenario!=='string'||!scenarios.includes(scenario))return new Response('Invalid scenario',{status:400});
 return Response.json(await evaluatePublication(scenario));
}};
