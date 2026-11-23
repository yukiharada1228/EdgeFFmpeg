import {synchronizeFrames,stackVideoFrames} from '@edge-ffmpeg/avfilter';
export default {async fetch(request:Request){
 const rows=await request.json() as {a:string[];b:string[];ab:string;bb:string;shortest:boolean}[];
 if(!Array.isArray(rows)||rows.length>128)return new Response('Invalid batch',{status:400});
 const results=[];
 for(const row of rows){const rational=(text:string)=>{const [a,b]=text.split('/');return {num:BigInt(a!),den:BigInt(b!)};},ab=rational(row.ab),bb=rational(row.bb);
 const source=(positions:string[],offset:number,timeBase:typeof ab)=>({timeBase,frames:{async *[Symbol.asyncIterator](){for(const [index,value]of positions.entries())yield {pts:value==='-9223372036854775808'?null:{value:BigInt(value),timeBase},value:offset+index};}}});
 const events=[];for await(const event of synchronizeFrames([source(row.a,10,ab),source(row.b,100,bb)],{shortest:row.shortest,maxPendingFrames:4,maxResidentBytes:4,timestamp:frame=>frame.pts,retain(value){return {value,bytes:1,release(){}};}})){const frame=stackVideoFrames(event.frames.map(frame=>({width:1,height:1,pixelFormat:'gray',planes:[Uint8Array.of(frame.value)],linesizes:[1],metadata:{},pts:event.pts})),'horizontal',{maxFrameBytes:8});events.push({pts:String(frame.pts!.value),values:[...frame.planes[0]!]});}results.push(events);
 }
 return Response.json(results);
}};
