// SPDX-License-Identifier: LGPL-2.1-or-later
// Adapts pinned fftools/sync_queue.c video-frame queue semantics. See ../../NOTICE.
import {rescale} from '@edge-ffmpeg/avutil';import type {Rational} from '@edge-ffmpeg/avutil';
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n,U64=(1n<<64n)-1n,EOF=-541478725;
export interface VideoEncoderSyncFrame<T>{readonly payload:T;readonly pts:bigint|null;readonly duration:bigint;readonly timeBase:Readonly<Rational>;readonly bytes:number;release():void}
export interface VideoEncoderSyncQueueOptions {readonly bufferUs:bigint;readonly maxFrames:number;readonly maxBytes:number}
export function createVideoEncoderSyncQueue<T>(limiting:readonly boolean[],options:VideoEncoderSyncQueueOptions){
 const settings={...options};limiting=[...limiting];if(!limiting.length||limiting.length>32||limiting.some(value=>typeof value!=='boolean')||typeof settings.bufferUs!=='bigint'||settings.bufferUs<0n||settings.bufferUs>MAX||![settings.maxFrames,settings.maxBytes].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('Invalid encoder sync queue configuration');
 const streams=limiting.map(value=>({limiting:value,finished:false,head:MIN,tb:{num:1n,den:1n} as Rational,sent:0n,max:U64,queue:[] as VideoEncoderSyncFrame<T>[]}));let head=-1,headFinished=-1,finished=false,resident=0,count=0,disposed=false;let disposalError:AggregateError|undefined;const cleanupErrors:unknown[]=[];const haveLimiting=limiting.some(Boolean);
 const active=()=>{if(disposed)throw new Error('Encoder sync queue disposed');},stream=(index:number)=>{if(!Number.isInteger(index)||index<0||index>=streams.length)throw new Error('Invalid encoder sync stream');return streams[index]!;},signed=(value:bigint)=>{if(typeof value!=='bigint'||value<MIN||value>MAX)throw new Error('Invalid encoder sync timestamp');};
 const compare=(a:bigint,at:Rational,b:bigint,bt:Rational)=>{const left=a*at.num*bt.den,right=b*bt.num*at.den;return left<right?-1:left>right?1:0;},scale=(value:bigint,from:Rational,to:Rational)=>{const result=rescale(value,from,to);return result<MIN||result>MAX?MIN:result;},end=(frame:VideoEncoderSyncFrame<T>)=>BigInt.asIntN(64,(frame.pts??MIN)+frame.duration);
 const finish=(index:number)=>{let st=stream(index);st.finished=true;if(st.limiting&&st.head!==MIN){if(headFinished<0||compare(st.head,st.tb,streams[headFinished]!.head,streams[headFinished]!.tb)<0)headFinished=index;st=streams[headFinished]!;for(const other of streams)if(other!==st&&other.head!==MIN&&compare(st.head,st.tb,other.head,other.tb)<=0)other.finished=true;}if(streams.every(item=>item.finished))finished=true;};
 const updateHead=()=>{if(head<0){let first=-1;for(const [index,st]of streams.entries())if(st.limiting){if(st.head===MIN)return;if(first<0)first=index;}head=first;}for(const [index,st]of streams.entries())if(st.limiting&&st.head!==MIN&&compare(st.head,st.tb,streams[head]!.head,streams[head]!.tb)<0)head=index;};
 const update=(index:number,pts:bigint)=>{const st=stream(index);if(pts===MIN||st.head!==MIN&&st.head>=pts)return;st.head=pts;if(headFinished>=0&&compare(streams[headFinished]!.head,streams[headFinished]!.tb,pts,st.tb)<=0)finish(index);if(st.limiting&&(head<0||head===index))updateHead();};
 const receiveOne=(index:number):{code:number|'again';frame?:VideoEncoderSyncFrame<T>}=>{const st=stream(index),frame=st.queue[0];if(frame){const pts=end(frame);if(pts===MIN||!haveLimiting||head>=0&&compare(pts,st.tb,streams[head]!.head,streams[head]!.tb)<=0){st.queue.shift();resident-=frame.bytes;count--;return {code:index,frame};}}return {code:finished||st.finished&&!st.queue.length?EOF:'again'};};
 const receiveInternal=(index:number)=>{if(index>=0)return receiveOne(index);let eof=0;for(let input=0;input<streams.length;input++){const result=receiveOne(input);if(result.code===EOF)eof++;else if(result.code!=='again')return result;}return {code:eof===streams.length?EOF:'again' as const};};
 const heartbeat=(index:number)=>{if(index<0){let pts=MIN;for(const [input,st]of streams.entries())if(st.head!==MIN&&(pts===MIN||compare(pts,streams[index]!.tb,st.head,st.tb)<0)){pts=st.head;index=input;}if(index<0)return false;}const st=stream(index);let tail=MIN;for(const frame of st.queue){tail=end(frame);if(tail!==MIN)break;}if(tail===MIN||tail>=st.head||scale(BigInt.asIntN(64,st.head-tail),st.tb,{num:1n,den:1000000n})<settings.bufferUs)return false;tail=BigInt.asIntN(64,tail+1n);for(const [input,other]of streams.entries()){if(other===st||other.finished||other.head!==MIN&&compare(tail,st.tb,other.head,other.tb)<=0)continue;let pts=scale(tail,st.tb,other.tb);if(other.head!==MIN)pts=pts>BigInt.asIntN(64,other.head+1n)?pts:BigInt.asIntN(64,other.head+1n);update(input,pts);}return true;};
 return {
  get cleanupErrors(){return Object.freeze([...cleanupErrors]);},
  snapshot(){return Object.freeze({finished,head,headFinished,streams:Object.freeze(streams.map(st=>Object.freeze({limiting:st.limiting,finished:st.finished,head:String(st.head),timeBase:Object.freeze({num:String(st.tb.num),den:String(st.tb.den)}),sent:String(st.sent),max:String(st.max),queued:st.queue.length}))),residentBytes:resident,queued:count});},
  limit(index:number,max:bigint){active();const st=stream(index);if(typeof max!=='bigint'||max<0n||max>U64)throw new Error('Invalid encoder frame limit');st.max=max;if(st.sent>=max)finish(index);},
  send(index:number,frame:VideoEncoderSyncFrame<T>|null){
   active();const st=stream(index);if(frame===null){finish(index);return 0;}if(st.finished)return EOF;
   const pts=frame.pts,duration=frame.duration;signed(pts??MIN);signed(duration);
   const sourceClock=frame.timeBase,tb={num:sourceClock.num,den:sourceClock.den},bytes=frame.bytes,release=frame.release;
   if(typeof tb.num!=='bigint'||typeof tb.den!=='bigint'||tb.num<1n||tb.den<1n||tb.num>2147483647n||tb.den>2147483647n||typeof release!=='function'||!Number.isSafeInteger(bytes)||bytes<0)throw new Error('Invalid encoder sync frame');
   if(count>=settings.maxFrames||bytes>settings.maxBytes-resident)throw new Error('Encoder sync queue budget exceeded');
   const changed=tb.num!==st.tb.num||tb.den!==st.tb.den;if(changed&&st.queue.length)throw new Error('Encoder sync timebase changed with pending frames');
   const owned:VideoEncoderSyncFrame<T>={payload:frame.payload,pts,duration,bytes,timeBase:tb,release:release.bind(frame)};
   if(changed){if(st.head!==MIN)st.head=scale(st.head,st.tb,tb);st.tb={...tb};}
   st.queue.push(owned);resident+=bytes;count++;update(index,end(owned));st.sent=BigInt.asUintN(64,st.sent+1n);if(st.sent>=st.max)finish(index);return 0;
  },
  receive(index=-1){active();if(!Number.isInteger(index)||index< -1||index>=streams.length)throw new Error('Invalid encoder receive stream');let result=receiveInternal(index);if(result.code==='again'&&heartbeat(index))result=receiveInternal(index);return result;},
  dispose(){if(disposed){if(disposalError)throw disposalError;return;}disposed=true;for(const st of streams)for(const frame of st.queue.splice(0))try{frame.release();}catch(error){cleanupErrors.push(error);}count=resident=0;if(cleanupErrors.length){disposalError=new AggregateError([...cleanupErrors],'Encoder sync frame release failed');throw disposalError;}}
 };
}
