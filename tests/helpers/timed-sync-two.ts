import {createTimedSynchronization} from '@edge-ffmpeg/avfilter';
export default {async fetch(request:Request){
 const cases=await request.json() as {a:string[];b:string[];endA:string;endB:string;shortest:boolean;statuses:number[];ab?:string;bb?:string}[];if(!Array.isArray(cases)||cases.length>128)return new Response('Invalid batch',{status:400});
 const results=[],MIN=-(1n<<63n);
 for(const c of cases){const parse=(text:string)=>{const [num,den]=text.split('/');return {num:BigInt(num!),den:BigInt(den!)};},ab=parse(c.ab??'1/25'),bb=parse(c.bb??'1/25');
 const source=(points:string[],end:string,status:number,offset:number,timeBase:typeof ab)=>({timeBase,open(){return {async *[Symbol.asyncIterator](){for(const [i,point]of points.entries())yield {kind:'frame' as const,value:{pts:BigInt(point)===MIN?null:{value:BigInt(point),timeBase},value:offset+i}};if(status)yield {kind:'end' as const,pts:end==='N'?null:BigInt(end),status:'error' as const,error:new Error('EIO')};else yield {kind:'end' as const,pts:end==='N'?null:BigInt(end),status:'eof' as const};}};}});
 const stream=createTimedSynchronization([source(c.a,c.endA,c.statuses[0]!,10,ab),source(c.b,c.endB,c.statuses[1]!,100,bb)],{shortest:c.shortest,maxResidentBytes:4,timestamp:value=>value.pts,retain(value){return {value,bytes:1,release(){}};}}),events=[];let end;
 for await(const event of stream){if(event.kind==='frame')events.push({pts:String(event.pts.value===MIN?MIN+1n:event.pts.value),values:event.values.map(frame=>frame.value)});else end=event;}
 results.push({accepted:true,timeBase:{num:Number(stream.timeBase.num),den:Number(stream.timeBase.den)},events,eof:true,statusCode:-541478725,rawStatusPts:String(end?.rawPts??MIN),effectiveStatusPts:String(end?.pts??MIN),inputStatusPts:end?.inputPts.map(point=>String(point??MIN))});
 }
 return Response.json(results);
}};
