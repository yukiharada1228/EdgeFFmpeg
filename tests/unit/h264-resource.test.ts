import {it,expect} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {avcPacketToAnnexB,parseAvcConfiguration,createH264Decoder,H264InputError,H264ResourceError} from '@edge-ffmpeg/avcodec';
import {createH264DisplayPolicy} from '../../packages/avcodec/src/h264/display-policy.mjs';
const options={maxPacketBytes:65536,maxFrameBytes:1048576,maxMemoryBytes:16777216,maxResidentBytes:33554432,maxPendingPackets:16,maxNalUnits:64,maxDisplayBytes:1048576,initialReorderDelay:1};
// Inject native status codes through a minimal compatible ABI; no decoding is claimed.
function statusModule(status:number,handle=1,allocation=2048){
 const uint=(n:number)=>{const out:number[]=[];do{const b=n&127;n>>>=7;out.push(b|(n?128:0));}while(n);return out;},signed=(n:number)=>{const out:number[]=[];for(;;){const b=n&127;n>>=7;const done=n===0&&!(b&64)||n===-1&&!!(b&64);out.push(b|(done?0:128));if(done)return out;}},text=(s:string)=>{const bytes=[...new TextEncoder().encode(s)];return [...uint(bytes.length),...bytes];},section=(id:number,bytes:number[])=>[id,...uint(bytes.length),...bytes];
 const entries:[string,number][]=[['edge_abi_version',2],['edge_create',handle],['edge_decode_order',0],['edge_destroy',0],['edge_decode',status],['edge_info',4096],['edge_forbidden_thread_calls',0],['malloc',allocation],['free',0]],exports=[entries.length,...entries.flatMap(([name],i)=>[...text(name),0,...uint(i)])],bodies=entries.flatMap(([,value])=>{const body=[0,65,...signed(value),11];return [...uint(body.length),...body];});
 return new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0,...section(1,[1,96,0,1,127]),...section(2,[1,...text('env'),...text('memory'),2,1,...uint(256),...uint(1024)]),...section(3,[entries.length,...entries.map(()=>0)]),...section(7,exports),...section(10,[entries.length,...bodies])]));
}
it('distinguishes exhausted AVC byte and NAL limits from malformed input',()=>{
 const data=Uint8Array.of(1,101);let error:unknown;try{avcPacketToAnnexB(data,1,16,1,new Uint8Array(17));}catch(e){error=e;}
 expect(error).toBeInstanceOf(H264InputError);expect(error).toBeInstanceOf(H264ResourceError);expect((error as H264ResourceError).resource).toBe('packet-bytes');
 const configuration=Uint8Array.from([1,77,0,10,255,225,0,1,103,1,0,1,104]);expect(()=>parseAvcConfiguration(configuration,64,1)).toThrow(H264ResourceError);
 try{avcPacketToAnnexB(Uint8Array.of(2,101),1,16,1);}catch(e){expect(e).toBeInstanceOf(H264InputError);expect(e).not.toBeInstanceOf(H264ResourceError);return;}throw Error('Expected malformed input rejection');
});
it('classifies only positive SDK out-of-memory status bits and releases retained decoder state',()=>{
 const packet=Uint8Array.from([0,0,0,1,103,77,0,10,246,244,3,194,33,20,224,0,0,0,1,104,206,60,128,0,0,0,1,101,184]);
 for(const status of [4,-1,16384,16388]){const codec=createH264Decoder(statusModule(status),options);let error:unknown;try{codec.feed({streamIndex:0,data:packet,pts:0n,dts:0n,duration:1n,timeBase:{num:1n,den:25n},flags:1});}catch(e){error=e;}expect(error).toBeInstanceOf(H264InputError);expect(error instanceof H264ResourceError).toBe(status>0&&!!(status&16384));if(error instanceof H264ResourceError)expect(error.resource).toBe('wasm-memory');expect(codec.isClosed).toBe(true);expect([codec.memoryBytes,codec.pendingPackets,codec.queuedBytes]).toEqual([0,0,0]);}
 const flushing=createH264Decoder(statusModule(16384),options);expect(()=>flushing.flush()).toThrow(H264ResourceError);expect(flushing.isClosed).toBe(true);
});
it('reports display queue exhaustion with its own resource category and closes the queue',()=>{
 const policy=createH264DisplayPolicy<number>({initialDelay:2,maxQueuedFrames:17,maxQueuedBytes:1});let error:unknown;try{policy.feed({poc:0,key:true,reset:false,type:'I',restricted:true,reorder:2,bytes:2,value:1});}catch(e){error=e;}expect(error).toBeInstanceOf(H264ResourceError);expect((error as H264ResourceError).resource).toBe('display-bytes');expect(policy.isClosed).toBe(true);expect(policy.queuedBytes).toBe(0);
 const countPolicy=createH264DisplayPolicy<number>({initialDelay:2,maxQueuedFrames:1,maxQueuedBytes:4}),picture={poc:0,key:true,reset:false,type:'I' as const,restricted:true,reorder:2,bytes:1,value:1};countPolicy.feed(picture);let countError:unknown;try{countPolicy.feed({...picture,poc:2,key:false});}catch(e){countError=e;}expect(countError).toBeInstanceOf(H264ResourceError);expect((countError as H264ResourceError).resource).toBe('display-frames');expect(countPolicy.queuedBytes).toBe(0);
});
it('normalizes typed codec budget errors without matching diagnostic text',async()=>{
 const module=new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)),h264={module,maxMemoryBytes:67108864,maxPacketBytes:1048576,maxFrameBytes:4194304,maxDisplayBytes:16777216,maxNalUnits:16384},args=['-f','mp4','-i','/input.mp4','-an','-c:v','rawvideo','-fps_mode','passthrough','-f','rawvideo','/output.raw'];let opens=0;
 const filesystem={async openRead():Promise<never>{opens++;throw new H264InputError('H264 memory budget exceeded');},async openWrite():Promise<never>{throw Error('Unexpected output');}},backend=createMediaBackend({h264}),result=await new FFmpeg({filesystem,backend,budget:{maxResidentBytes:16777216,maxBufferBytes:1048576,maxCpuTimeMs:10000,maxPendingPackets:32}}).exec(args);
 expect(result.diagnostics[0]?.code).toBe('resource-budget');expect((result.error as Error).cause).toBeInstanceOf(H264ResourceError);expect(opens).toBe(0);
 const invalid=await new FFmpeg({filesystem,backend,budget:{maxResidentBytes:134217728,maxBufferBytes:1048576,maxCpuTimeMs:10000,maxPendingPackets:32}}).exec(args);expect(invalid.diagnostics[0]?.code).toBe('execution-failed');expect(invalid.diagnostics[0]?.message).toBe('H264 memory budget exceeded');expect(opens).toBe(1);
});
it('preserves host allocation causes and classifies native allocator failures',()=>{
 const module=statusModule(0),Original=WebAssembly.Memory,cause=new RangeError('Injected host memory exhaustion');let error:unknown;
 try{WebAssembly.Memory=new Proxy(Original,{construct(){throw cause;}});try{createH264Decoder(module,options);}catch(e){error=e;}}finally{WebAssembly.Memory=Original;}
 expect(error).toBeInstanceOf(H264ResourceError);expect((error as Error).cause).toBe(cause);expect((error as H264ResourceError).resource).toBe('wasm-memory');
 expect(()=>createH264Decoder(statusModule(0,0),options)).toThrow(H264ResourceError);
 const codec=createH264Decoder(statusModule(0,1,0),options),packet=Uint8Array.from([0,0,0,1,103,77,0,10,246,244,3,194,33,20,224,0,0,0,1,104,206,60,128,0,0,0,1,101,184]);expect(()=>codec.feed({streamIndex:0,data:packet,pts:0n,dts:0n,duration:1n,timeBase:{num:1n,den:25n},flags:1})).toThrow(H264ResourceError);expect(codec.isClosed).toBe(true);expect(codec.memoryBytes).toBe(0);
});
it('keeps invalid cropping distinct from frame-byte exhaustion',async()=>{
 const {inspectH264Sps}=await import('../../packages/avcodec/src/h264/sps.js');
 const sps=(right:number)=>{const bits:number[]=[],put=(value:number,count:number)=>{for(let i=count-1;i>=0;i--)bits.push((value>>>i)&1);},ue=(value:number)=>{const text=(value+1).toString(2);put(0,text.length-1);for(const bit of text)bits.push(Number(bit));};put(77,8);put(0,8);put(10,8);ue(0);ue(0);ue(0);ue(0);ue(1);put(0,1);ue(0);ue(0);put(1,1);put(1,1);put(1,1);ue(0);ue(right);ue(0);ue(0);put(0,1);put(1,1);while(bits.length%8)bits.push(0);return Uint8Array.from([103,...Array.from({length:bits.length/8},(_,i)=>bits.slice(i*8,i*8+8).reduce((value,bit)=>value*2+bit,0))]);};
 expect(()=>inspectH264Sps(sps(0),32)).toThrow(H264ResourceError);
 try{inspectH264Sps(sps(8),32);}catch(error){expect(error).toBeInstanceOf(H264InputError);expect(error).not.toBeInstanceOf(H264ResourceError);return;}throw Error('Expected invalid crop rejection');
});
