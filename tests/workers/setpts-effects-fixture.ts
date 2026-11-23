import {createSetptsStream,createVideoPtsTransform} from '@edge-ffmpeg/avfilter';
import type {ExpressionPrint} from '@edge-ffmpeg/avutil';
export default {async fetch(){
 const timeBase={num:1n,den:25n},options={numericProfile:'linux-x64' as const,timeBase,frameRate:{num:25n,den:1n}},commands:ExpressionPrint[]=[],stage=createVideoPtsTransform({...options,expression:'print(N,48);PTS',logLevel:32,onPrint:entry=>commands.push(entry)});
 stage.process({pts:0n,duration:1n});stage.command('print(N,16);PTS');stage.process({pts:1n,duration:1n});stage.finish(2n);
 const prints:ExpressionPrint[]=[],stream=createSetptsStream(()=>({async *[Symbol.asyncIterator](){yield {kind:'frame' as const,duration:1n,frame:{width:1,height:1,pixelFormat:'gray',planes:[Uint8Array.of(7)],linesizes:[1],metadata:{},pts:{value:0n,timeBase}}};yield {kind:'end' as const,status:'eof' as const,pts:1n};}}),{...options,expression:'print(N,16);PTS',maxFrameBytes:8,onPrint:entry=>prints.push(entry)});
 for await(const event of stream.open()){void event;/* Evaluate requested frames and terminal status. */}
 const primary=new Error('input'),effect=new Error('effect'),failure=createSetptsStream(()=>({async *[Symbol.asyncIterator](){yield {kind:'end' as const,status:'error' as const,pts:0n,error:primary};}}),{...options,expression:'print(N);PTS',maxFrameBytes:8,onPrint(){throw effect;}});
 for await(const event of failure.open()){void event;/* Terminal input failure remains observable. */}
 const completed=await failure.completion;
 return Response.json({commands,prints,status:(await stream.completion).status,failure:{primary:completed.error===primary,effect:completed.secondaryErrors[0]===effect,status:completed.status}});
}};
