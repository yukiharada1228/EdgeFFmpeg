import {createH264Decoder} from '@edge-ffmpeg/avcodec';
export interface H264ExpectedFrame {pts:string;duration:string;width:number;height:number;pixelFormat:string;colorRange:number;key:boolean;type:string;sha256:string}
export interface H264Case {id:string;packets:string[];inputSha256:string;initialReorderDelay:number;expected:H264ExpectedFrame[];resetTokens:string[];resourceProfile?:'hd'}
export async function evaluateH264(module:WebAssembly.Module,row:H264Case){
 const resources=row.resourceProfile==='hd'?{maxPacketBytes:1048576,maxFrameBytes:4194304,maxMemoryBytes:67108864,maxResidentBytes:134217728,maxDisplayBytes:16777216}:{maxPacketBytes:65536,maxFrameBytes:1048576,maxMemoryBytes:16777216,maxResidentBytes:33554432,maxDisplayBytes:1048576};
 const codec=createH264Decoder(module,{...resources,maxPendingPackets:16,maxNalUnits:64,initialReorderDelay:row.initialReorderDelay}),frames=[];
 try{
  for(const [i,encoded] of row.packets.entries()){
   const data=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
   frames.push(...codec.feed({streamIndex:0,data,pts:9007199254740993n+BigInt(i)*1001n,dts:BigInt(i)-1n,duration:2n,timeBase:{num:1n,den:90000n},flags:0}));data.fill(255);
  }
  for(;;){const frame=codec.flush();if(frame===null)break;frames.push(frame);}
 }finally{codec.close();}
 const actual:H264ExpectedFrame[]=[],resetTokens:string[]=[];
 for(const value of frames){
  const frame=value.frame,bytes=frame.width*frame.height+2*Math.ceil(frame.width/2)*Math.ceil(frame.height/2);
  if(!frame.pts||frame.pts.timeBase.num!==1n||frame.pts.timeBase.den!==90000n||frame.planes[0]!.buffer.byteLength!==bytes||frame.planes.some(p=>p.buffer!==frame.planes[0]!.buffer))throw Error('H264 frame ownership or clock mismatch');
  const owned=new Uint8Array(bytes);let at=0;for(const plane of frame.planes){owned.set(plane,at);at+=plane.length;}
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',owned));
  actual.push({pts:String(frame.pts.value),duration:String(value.duration),width:frame.width,height:frame.height,pixelFormat:frame.pixelFormat,colorRange:frame.metadata.colorRange as number,key:value.pictureOrder.key,type:value.pictureOrder.type,sha256:Array.from(digest,n=>n.toString(16).padStart(2,'0')).join('')});
  if(value.pictureOrder.reset)resetTokens.push(String(value.packetToken));
 }
 return {frames:actual,resetTokens,memoryBytes:codec.memoryBytes,queuedBytes:codec.queuedBytes,pendingPackets:codec.pendingPackets,closed:codec.isClosed};
}
