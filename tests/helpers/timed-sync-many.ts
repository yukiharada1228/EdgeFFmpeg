import {createTimedSynchronization} from '@edge-ffmpeg/avfilter';import type {TimedSynchronizationInput as Event} from '@edge-ffmpeg/avfilter';
export interface ThreeCase {bases:string[];points:string[][];ends:string[];shortest:boolean;statuses:number[];offsets?:number[]}
export async function evaluateThreeCase(c:ThreeCase){
 const MIN=-(1n<<63n),errors=c.statuses.map((_,index)=>Object.freeze(Object.assign(new Error('EIO'),{input:index}))),sources=c.bases.map((text,index)=>{const [num,den]=text.split('/'),timeBase={num:BigInt(num!),den:BigInt(den!)};
 return {timeBase,open(){return {async *[Symbol.asyncIterator]():AsyncGenerator<Event<{pts:{value:bigint;timeBase:typeof timeBase}|null;value:number}>>{for(const [offset,point]of c.points[index]!.entries())yield {kind:'frame',value:{pts:BigInt(point)===MIN?null:{value:BigInt(point),timeBase},value:(c.offsets?.[index]??(index?index*100:10))+offset}};
 const pts=c.ends[index]==='N'?null:BigInt(c.ends[index]!);if(c.statuses[index])yield {kind:'end',status:'error',pts,error:errors[index]};else yield {kind:'end',status:'eof',pts};}};}};});
 const stream=createTimedSynchronization(sources,{shortest:c.shortest,maxResidentBytes:2*c.bases.length,maxPendingFrames:2*c.bases.length,maxOperatorSteps:1000,timestamp:value=>value.pts,retain(value){return {value,bytes:1,release(){}};}}),events=[];let end;
 for await(const event of stream){if(event.kind==='frame')events.push({pts:String(event.pts.value===MIN?MIN+1n:event.pts.value),values:event.values.map(frame=>frame.value)});else end=event;}
 const completed=await stream.completion;if(!end||completed.status!==(end.inputErrors.length?'error':'eof')||end.inputErrors.some(error=>!errors.includes(error as typeof errors[number])))throw new Error('Lost input status or identity');
 return {accepted:true,timeBase:{num:Number(stream.timeBase.num),den:Number(stream.timeBase.den)},events,eof:true,statusCode:-541478725,rawStatusPts:String(end.rawPts??MIN),effectiveStatusPts:String(end.pts??MIN),inputStatusPts:end.inputPts.map(point=>String(point??MIN))};
}
export default {async fetch(request:Request){const rows=await request.json() as ThreeCase[];if(!Array.isArray(rows)||rows.length>128)return new Response('Invalid batch',{status:400});const results=[];for(const row of rows)results.push(await evaluateThreeCase(row));return Response.json(results);}};
