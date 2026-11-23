import {expect,it} from 'vitest';
import {pixelLayout,parseVideoFrameRate} from '@edge-ffmpeg/avutil';
import {decodeRawVideo,encodeRawVideo} from '@edge-ffmpeg/avcodec';
import {openRawVideo,muxRawVideo,muxRawVideoFrameCrc} from '@edge-ffmpeg/containers';
import {collectingOutput} from '../helpers/output.js';
const format={width:5,height:3,pixelFormat:'yuv420p',frameRate:{num:30000n,den:1001n}};
it('describes odd chroma planes with exact offsets and rejects impossible dimensions before allocation',()=>{
  expect(pixelLayout('yuv420p',5,3)).toMatchObject({bytes:27,planes:[{rowBytes:5,height:3,offset:0,bytes:15},{rowBytes:3,height:2,offset:15,bytes:6},{rowBytes:3,height:2,offset:21,bytes:6}]});expect(pixelLayout('nv12',5,3).planes[1]).toMatchObject({rowBytes:6,height:2,bytes:12});expect(pixelLayout('yuva420p',5,3).bytes).toBe(42);expect(pixelLayout('gray8',5,3).pixelFormat).toBe('gray');expect(Object.isFrozen(pixelLayout('rgba',5,3).planes)).toBe(true);
  for(const [pixel,width,height]of [['unknown',1,1],['rgb24',0,1],['rgba',2147483647,2147483647]] as const)expect(()=>pixelLayout(pixel,width,height)).toThrow();
  expect(parseVideoFrameRate('29.97')).toEqual({num:2997n,den:100n});expect(parseVideoFrameRate('ntsc')).toEqual(format.frameRate);expect(parseVideoFrameRate('60000/2002')).toEqual(format.frameRate);for(const text of ['0','-1','1/0','1+2','1e3','1001001/999983'])expect(()=>parseVideoFrameRate(text)).toThrow();
});
it('decodes owned disjoint video planes and encodes visible rows without stride padding',()=>{
  const data=Uint8Array.from({length:27},(_,i)=>i),packet={streamIndex:0,data,pts:9007199254740993n,dts:9007199254740993n,duration:1n,timeBase:{num:1001n,den:30000n},flags:1},frame=decodeRawVideo(packet,format,{maxFrameBytes:64});
  expect(frame.linesizes).toEqual([5,3,3]);expect(frame.planes[0]!.buffer).not.toBe(data.buffer);expect(frame.planes.map(plane=>plane.byteOffset)).toEqual([0,15,21]);data.fill(99);expect(frame.planes[0]![0]).toBe(0);expect(encodeRawVideo(frame,format.frameRate,{maxFrameBytes:64})).toMatchObject({pts:9007199254740993n,duration:1n,timeBase:packet.timeBase,data:Uint8Array.from({length:27},(_,i)=>i)});
  const planes=frame.planes.map((plane,index)=>{const rows=index===0?3:2,rowBytes=index===0?5:3,stride=rowBytes+2,result=new Uint8Array(stride*rows).fill(255);for(let row=0;row<rows;row++)result.set(plane.subarray(row*rowBytes,(row+1)*rowBytes),row*stride);return result;});
  const padded={...frame,planes,linesizes:[7,5,5]};expect(encodeRawVideo(padded,format.frameRate,{maxFrameBytes:64}).data).toEqual(Uint8Array.from({length:27},(_,i)=>i));expect(()=>encodeRawVideo({...padded,linesizes:[-7,5,5]},format.frameRate,{maxFrameBytes:64})).toThrow('stride');expect(()=>encodeRawVideo(padded,format.frameRate,{maxFrameBytes:32})).toThrow('aggregate');expect(()=>decodeRawVideo({...packet,data:new Uint8Array(26)},format,{maxFrameBytes:64})).toThrow('size');
});
it('assembles finite video frames from short reads and preserves bigint ranges without reading ahead',async()=>{
  const bytes=Uint8Array.from({length:81},(_,i)=>i),reads:{offset:bigint;length:number}[]=[],video=await openRawVideo({size:81n,async readAt(offset,length){reads.push({offset,length});return bytes.slice(Number(offset),Number(offset)+Math.min(length,2));}},{...format,maxReadBytes:4,maxFrameBytes:27});
  const iterator=video.packets(1n,1n)[Symbol.asyncIterator](),first=await iterator.next();expect(first.value).toMatchObject({pts:1n,duration:1n,data:bytes.slice(27,54)});expect(reads.every(value=>value.offset>=27n&&value.offset<54n&&value.length<=4)).toBe(true);await iterator.return?.();expect(video.info.frameCount).toBe(3n);
  await expect(openRawVideo({size:28n,async readAt(){throw new Error('unexpected');}},{...format,maxReadBytes:4,maxFrameBytes:27})).rejects.toThrow('Incomplete');
  const huge=9007199254740993n,large=await openRawVideo({size:huge*27n,async readAt(){return new Uint8Array(27);}},{...format,maxReadBytes:27,maxFrameBytes:27});expect((await large.packets(huge-1n,1n)[Symbol.asyncIterator]().next()).value?.pts).toBe(huge-1n);
});
it('streams raw video and framecrc with bounded writes, cancellation and staged failure handling',async()=>{
  const bytes=new Uint8Array(54),video=await openRawVideo({size:54n,async readAt(offset,length){return bytes.slice(Number(offset),Number(offset)+length);}},{...format,maxReadBytes:8,maxFrameBytes:27}),sink=collectingOutput();
  await muxRawVideo(sink.output,format,video.packets(),{frameCount:2n,maxWriteBytes:5});expect(sink.bytes()).toEqual(bytes);expect(sink.lengths.every(value=>value<=5)).toBe(true);expect(sink.committed).toBe(true);
  const crc=collectingOutput();await muxRawVideoFrameCrc(crc.output,format,video.packets(),{frameCount:2n,maxWriteBytes:4,bitexact:true});expect(new TextDecoder().decode(crc.bytes())).toContain('#tb 0: 1001/30000\n#media_type 0: video\n');
  const failed=collectingOutput();await expect(muxRawVideo(failed.output,format,video.packets(),{frameCount:3n,maxWriteBytes:5})).rejects.toThrow('count');expect(failed.aborted).toBe(true);expect(failed.committed).toBe(false);
  const signal=AbortSignal.abort(new Error('stop')),cancelled=collectingOutput();await expect(muxRawVideo(cancelled.output,format,video.packets(),{frameCount:2n,maxWriteBytes:5,signal})).rejects.toThrow('stop');expect(cancelled.aborted).toBe(true);
});
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
it('preflights video commands and simultaneous frame storage before opening output or reading payloads',async()=>{
  for(const after of [['-vf','scale=iw/2:ih/2'],['-ar','50'],['-vf','scale=2:2:flags=neighbor'],['-c:v','h264']]){
    let reads=0,writes=0,opens=0;const filesystem={async openRead(){opens++;return {size:27n,async readAt(){reads++;return new Uint8Array(27);}};},async openWrite(){writes++;return collectingOutput().output;}};
    const result=await new FFmpeg({filesystem,backend:createMediaBackend()}).exec(['-f','rawvideo','-s','5x3','-i','/input.raw',...after,'-f','rawvideo','/output.raw']);expect(result.diagnostics[0]?.code).toBe('unsupported-command');expect(reads).toBe(0);expect(writes).toBe(0);expect(opens).toBe(0);
  }
  let reads=0,writes=0;const sink=collectingOutput(),filesystem={async openRead(){return {size:27n,async readAt(){reads++;return new Uint8Array(27);}};},async openWrite(){writes++;return sink.output;}},frontend=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:100,maxBufferBytes:64,maxCpuTimeMs:1000,maxPendingPackets:2}});
  const encoded=await frontend.exec(['-f','rawvideo','-s','5x3','-i','/input.raw','-f','rawvideo','/output.raw']);expect(encoded.diagnostics[0]?.code).toBe('resource-budget');expect(reads).toBe(0);expect(writes).toBe(0);
  const copied=await frontend.exec(['-f','rawvideo','-s','5x3','-i','/input.raw','-c:v','copy','-f','rawvideo','/output.raw']);expect(copied.exitCode).toBe(0);expect(sink.committed).toBe(true);expect(sink.bytes().length).toBe(27);
});
it('propagates consumer backpressure and aborts on truncated reads or output failures',async()=>{
  let reads=0,release=()=>{},notify=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;}),blocked=new Promise<void>(resolve=>{notify=resolve;}),video=await openRawVideo({size:54n,async readAt(_offset,length){reads++;return new Uint8Array(length);}},{...format,maxReadBytes:27,maxFrameBytes:27}),sink=collectingOutput();
  const work=muxRawVideo({...sink.output,async write(bytes){notify();await gate;await sink.output.write(bytes);}},format,video.packets(),{frameCount:2n,maxWriteBytes:27});await blocked;expect(reads).toBe(1);release();await work;expect(reads).toBe(2);
  const short=await openRawVideo({size:27n,async readAt(){return new Uint8Array();}},{...format,maxReadBytes:4,maxFrameBytes:27}),failed=collectingOutput();await expect(muxRawVideo(failed.output,format,short.packets(),{frameCount:1n,maxWriteBytes:4})).rejects.toThrow('read');expect(failed.aborted).toBe(true);
  const bad=collectingOutput();await expect(muxRawVideo({...bad.output,async write(){throw new Error('disk failed');}},format,video.packets(),{frameCount:2n,maxWriteBytes:27})).rejects.toThrow('disk failed');expect(bad.aborted).toBe(true);
});
it('validates planned nonzero or negative video timestamps while preserving staged mux failure',async()=>{
 const video=await openRawVideo({size:54n,async readAt(_offset,length){return new Uint8Array(length);}},{...format,maxReadBytes:27,maxFrameBytes:27});
 async function* shifted(){for await(const packet of video.packets())yield {...packet,pts:packet.pts!-1n,dts:packet.dts!-1n};}
 const sink=collectingOutput();await muxRawVideoFrameCrc(sink.output,format,shifted(),{frameCount:2n,maxWriteBytes:8,bitexact:true,timestamp:index=>index-1n});expect(new TextDecoder().decode(sink.bytes())).toContain('0,         -1,         -1,        1,       27, 0x00000000\n');
 const failed=collectingOutput();await expect(muxRawVideo(failed.output,format,shifted(),{frameCount:2n,maxWriteBytes:8})).rejects.toThrow('timestamp');expect(failed.aborted).toBe(true);
 const overflow=collectingOutput();await expect(muxRawVideo(overflow.output,format,video.packets(),{frameCount:2n,maxWriteBytes:8,timestamp:()=>1n<<63n})).rejects.toThrow('timestamp plan');expect(overflow.aborted).toBe(true);
});
