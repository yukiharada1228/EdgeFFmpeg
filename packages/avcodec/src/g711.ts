import { rescale } from '@edge-ffmpeg/avutil';
import type { AudioFrameData, MediaPacket } from '@edge-ffmpeg/avutil';
import { convertAudioFrame } from '@edge-ffmpeg/swresample';
export type G711Codec='pcm_alaw'|'pcm_mulaw';
export interface G711Format {readonly codec:G711Codec;readonly channels:number;readonly sampleRate:number;readonly channelLayout?:string}
export interface G711Options {readonly maxFrameBytes:number;readonly signal?:AbortSignal}
export class G711Error extends Error {}
export function isG711Codec(codec:string):codec is G711Codec{return codec==='pcm_alaw'||codec==='pcm_mulaw';}
function validate(codec:G711Codec,channels:number,rate:number,bytes:number,options:G711Options){
  options.signal?.throwIfAborted();
  if(!isG711Codec(codec)||!Number.isSafeInteger(channels)||channels<1||!Number.isSafeInteger(rate)||rate<1)throw new G711Error('Invalid G.711 codec or audio dimensions');
  if(!Number.isSafeInteger(bytes)||bytes<1||!Number.isSafeInteger(options.maxFrameBytes)||options.maxFrameBytes<1||bytes>options.maxFrameBytes)throw new G711Error('G.711 frame exceeds allocation limit');
}
/** Independent segmented logarithmic reconstruction, with the A-law bit toggle. */
function expand(code:number,codec:G711Codec):number{
  if(codec==='pcm_alaw'){
    const value=code^0x55,segment=(value>>4)&7,mantissa=value&15;
    const magnitude=segment===0?mantissa*16+8:(mantissa*16+264)*2**(segment-1);
    return value&128?magnitude:-magnitude;
  }
  const value=code^255,segment=(value>>4)&7,mantissa=value&15;
  const biased=(mantissa*8+132)*2**segment;
  return value&128?132-biased:biased-132;
}
const magnitudes={
  pcm_alaw:Object.freeze(Array.from({length:128},(_,index)=>expand(index^0xd5,'pcm_alaw'))),
  pcm_mulaw:Object.freeze(Array.from({length:128},(_,index)=>expand(index^0xff,'pcm_mulaw')))
};
/** Native signed-16 profile: quantize to four-unit input bins, then select the
 * nearest reconstruction magnitude. Midpoint ties select the larger level.
 */
function compress(sample:number,codec:G711Codec):number{
  const magnitude=Math.abs((sample>>2)*4),levels=magnitudes[codec];
  let low=0,high=127;
  while(low<high){const middle=(low+high)>>1;if(magnitude*2>=levels[middle]!+levels[middle+1]!)low=middle+1;else high=middle;}
  const mask=codec==='pcm_alaw'?(sample<0?0x55:0xd5):(sample<0?0x7f:0xff);
  return low^mask;
}
/** One code byte per channel/sample, expanded to owned packed little-endian s16. */
export function decodeG711(packet:MediaPacket,format:G711Format,options:G711Options):AudioFrameData{
  const count=packet.data.length;validate(format.codec,format.channels,format.sampleRate,count*2,options);
  if(count%format.channels!==0||packet.timeBase.num<=0n||packet.timeBase.den<=0n)throw new G711Error('Invalid G.711 packet alignment or time base');
  const data=new Uint8Array(count*2),view=new DataView(data.buffer);
  for(let index=0;index<count;index++){if((index&4095)===0)options.signal?.throwIfAborted();view.setInt16(index*2,expand(packet.data[index]!,format.codec),true);}
  return {sampleRate:format.sampleRate,channels:format.channels,channelLayout:format.channelLayout??(format.channels===1?'mono':format.channels===2?'stereo':'unspecified'),sampleFormat:'s16',samples:count/format.channels,planes:[data],pts:packet.pts===null?null:{value:packet.pts,timeBase:{...packet.timeBase}}};
}
/** Owns output bytes; cross-format input uses the documented scalar PCM conversion profile. */
export function encodeG711(frame:AudioFrameData,codec:G711Codec,options:G711Options):MediaPacket{
  const count=frame.samples*frame.channels;validate(codec,frame.channels,frame.sampleRate,count,options);
  if(!Number.isSafeInteger(frame.samples)||frame.samples<1)throw new G711Error('Invalid G.711 sample count');
  const input=frame.sampleFormat==='s16'||frame.sampleFormat==='s16p'?frame:convertAudioFrame(frame,'s16',options),planar=input.sampleFormat==='s16p';
  if(input.planes.length!==(planar?frame.channels:1))throw new G711Error(planar?'Invalid G.711 encoder input plane count':'Invalid packed G.711 encoder input');
  for(let channel=0;channel<input.planes.length;channel++){options.signal?.throwIfAborted();const plane=input.planes[channel];if(!(plane instanceof Uint8Array)||plane.length!==(planar?frame.samples:count)*2)throw new G711Error(planar?'Invalid G.711 encoder input plane size':'Invalid packed G.711 encoder input');}
  const views=input.planes.map(plane=>new DataView(plane.buffer,plane.byteOffset,plane.byteLength)),data=new Uint8Array(count);
  // Read channel planes directly; already-s16 input needs no repacking scratch.
  for(let index=0;index<count;index++){if((index&4095)===0)options.signal?.throwIfAborted();const channel=planar?index%frame.channels:0,sample=planar?Math.floor(index/frame.channels):index;data[index]=compress(views[channel]!.getInt16(sample*2,true),codec);}
  const timeBase={num:1n,den:BigInt(frame.sampleRate)},pts=frame.pts===null?null:rescale(frame.pts.value,frame.pts.timeBase,timeBase);
  return {streamIndex:0,data,pts,dts:pts,duration:BigInt(frame.samples),timeBase,flags:1};
}
