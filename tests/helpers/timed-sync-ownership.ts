import {createTimedSynchronization} from '@edge-ffmpeg/avfilter';import type {TimedSynchronizationInput as Event} from '@edge-ffmpeg/avfilter';
export async function evaluateOwnership(){
 const base={num:1n,den:25n};type Frame={pts:{value:bigint;timeBase:typeof base};value:number};const declared={...base},descriptorBase={...base},shared:Frame={pts:{value:0n,timeBase:declared},value:10};let closes=0;
 const a={timeBase:descriptorBase,open(){return {async *[Symbol.asyncIterator]():AsyncGenerator<Event<Frame>>{try{for(let i=0;i<3;i++){shared.pts={value:BigInt(i*2),timeBase:declared};shared.value=10+i;yield {kind:'frame',value:shared};}yield {kind:'end',status:'eof',pts:9n};}finally{closes++;}}};}},b={timeBase:base,open(){return {async *[Symbol.asyncIterator]():AsyncGenerator<Event<Frame>>{try{for(let i=0;i<2;i++)yield {kind:'frame',value:{pts:{value:BigInt(1+2*i),timeBase:base},value:100+i}};yield {kind:'end',status:'eof',pts:9n};}finally{closes++;}}};}},sources=[a,b],settings={shortest:false,maxResidentBytes:4,timestamp:(frame:Frame)=>frame.pts,retain(frame:Frame){return {value:{...frame,pts:{...frame.pts,timeBase:{...frame.pts.timeBase}}},bytes:1,release(){}};}},stream=createTimedSynchronization(sources,settings);
 descriptorBase.den=30n;sources[0]=b;sources.push(b);a.open=()=>{throw new Error('Changed source factory');};settings.maxResidentBytes=0;
 const rows=[];for await(const event of stream)if(event.kind==='frame')rows.push([String(event.pts.value),event.values.map(frame=>frame.value)]);
 return {rows,closes,status:(await stream.completion).status};
}
