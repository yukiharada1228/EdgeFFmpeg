import {decodeBmp,encodeBmp} from '@edge-ffmpeg/avcodec';
export default {async fetch(request:Request){
 const bytes=new Uint8Array(await request.arrayBuffer()),packet={streamIndex:0,data:bytes,pts:0n,dts:0n,duration:1n,timeBase:{num:1n,den:25n},flags:1},options={maxFrameBytes:1048576,maxPacketBytes:1048576};
 const frame=decodeBmp(packet,options),roundtrip=encodeBmp(frame,options);
 return Response.json({width:frame.width,height:frame.height,pixelFormat:frame.pixelFormat,planes:frame.planes.map(p=>Array.from(p)),encoded:Array.from(roundtrip.data)});
}};
