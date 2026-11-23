import {createSetptsStream} from '@edge-ffmpeg/avfilter';
export async function evaluateSetptsSink(){
 const options={numericProfile:'linux-x64' as const,timeBase:{num:1n,den:25n},frameRate:{num:25n,den:1n},maxFrameBytes:16};
 const failure=new Error('upstream'),pipe=createSetptsStream(()=>({async *[Symbol.asyncIterator](){yield {kind:'end' as const,status:'error' as const,pts:2n,error:failure};}}),options);
 let committed=false,identity=false;try{for await(const event of pipe.openFrames())void event;committed=true;}catch(error){identity=error===failure;}
 let opens=0;const idle=createSetptsStream(()=>{opens++;throw new Error('unexpected');},options);await idle.openFrames()[Symbol.asyncIterator]().return?.();
 let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});let returns=0;
 const waiting=createSetptsStream(signal=>({[Symbol.asyncIterator](){return {async next(){entered();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));throw new Error('unexpected');},async return(){returns++;return {done:true as const,value:undefined};}};}}),options),iterator=waiting.openFrames()[Symbol.asyncIterator](),pending=iterator.next().then(()=>false,()=>true);
 await ready;await iterator.return?.();
 return {committed,identity,opens,idleStatus:(await idle.completion).status,pendingRejected:await pending,returns,waitingStatus:(await waiting.completion).status};
}
