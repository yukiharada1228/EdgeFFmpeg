import {expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {decodePcm,encodePcm} from '@edge-ffmpeg/avcodec';
import type {PcmCodec} from '@edge-ffmpeg/avutil';
const formats=[['u8',1],['s8',1],['s16le',2],['s16be',2],['s24le',3],['s24be',3],['s32le',4],['s32be',4],['u16le',2],['u16be',2],['u24le',3],['u24be',3],['u32le',4],['u32be',4],['f32le',4],['f32be',4],['f64le',8],['f64be',8],['alaw',1],['mulaw',1]] as const;
const added=new Set(['s8','s16be','s24be','s32be','u16le','u16be','u24le','u24be','u32le','u32be','f32be','f64be']);
const native=resolve('.build/reference/ffmpeg');
function fixture(raw:string,width:number,count:number){
  const data=Uint8Array.from({length:width*count},(_,i)=>(i*37+13)&255),view=new DataView(data.buffer);
  if(raw.startsWith('f'))for(let i=0;i<count;i++){if(width===4)view.setFloat32(i*4,(i%65-32)/32,raw.endsWith('le'));else view.setFloat64(i*8,(i%65-32)/32,raw.endsWith('le'));}
  return data;
}
it('matches all twenty raw PCM representations in a native scalar conversion matrix',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-pcm-repr-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});
    for(const [source,width]of formats){
      const path=join(root,`${source}.raw`);writeFileSync(path,fixture(source,width,64));
      for(const [target]of formats){
        const input=['-cpuflags','0','-f',source,'-ar','8000','-ac','2'],expected=execFileSync(native,['-v','error',...input,'-i',path,'-f',target,'-']);
        const output=`/${source}-${target}.raw`,result=await ffmpeg.exec([...input,'-i',`/${source}.raw`,'-f',target,output]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,output.slice(1))).equals(expected),`${source}->${target}`).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches added PCM representations through copy and stateful filtering with framecrc timing',async()=>{
  const root=mkdtempSync(join(tmpdir(),'edgeffmpeg-pcm-repr-time-'));
  try{
    const filesystem=await createNodeFileSystem({root,maxReadBytes:128,maxWriteBytes:128}),ffmpeg=new FFmpeg({filesystem,backend:createMediaBackend(),budget:{maxResidentBytes:65536,maxBufferBytes:128,maxPendingPackets:2,maxCpuTimeMs:1000}});
    for(const [raw,width]of formats){if(!added.has(raw))continue;const path=join(root,`${raw}.raw`);writeFileSync(path,fixture(raw,width,2051*2));
      for(const copy of [true,false]){
        const input=['-cpuflags','0','-ss','0.001','-f',raw,'-ar','8000','-ac','2'],tail=['-ss','0.01','-t','0.1','-frames:a','2',...(copy?['-c:a','copy']:['-af','volume=0.5:precision=fixed,asetnsamples=7:p=1','-c:a',`pcm_${raw}`]),'-bitexact','-f','framecrc'];
        const expected=execFileSync(native,['-v','error',...input,'-i',path,...tail,'-']),output=`/${raw}-${copy}.crc`,result=await ffmpeg.exec([...input,'-i',`/${raw}.raw`,...tail,output]);expect(result.exitCode,JSON.stringify(result.diagnostics)).toBe(0);expect(readFileSync(join(root,output.slice(1))).equals(expected),`${raw}/${copy}`).toBe(true);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('matches native unsigned16 and signed8 complete domains and preserves floating endian payload bits',()=>{
  const linear=new Uint8Array(131072),view=new DataView(linear.buffer);for(let i=0;i<65536;i++)view.setInt16(i*2,i-32768,true);
  for(const raw of ['s8','u16le','u16be'] as const){
    const codec=`pcm_${raw}` as const,packet=encodePcm({sampleRate:8000,channels:1,channelLayout:'mono',sampleFormat:'s16',samples:65536,planes:[linear],pts:null},codec,{maxFrameBytes:linear.length});
    const expected=execFileSync(native,['-v','error','-f','s16le','-ar','8000','-ac','1','-i','pipe:0','-f',raw,'-'],{input:linear});expect(Buffer.from(packet.data)).toEqual(expected);
    const count=raw==='s8'?256:65536,width=raw==='s8'?1:2,data=new Uint8Array(count*width),words=new DataView(data.buffer);for(let i=0;i<count;i++){if(width===1)data[i]=i;else words.setUint16(i*2,i,raw.endsWith('le'));}
    const actual=decodePcm({streamIndex:0,data,pts:null,dts:null,duration:null,timeBase:{num:1n,den:8000n},flags:1},{codec,channels:1,sampleRate:8000},{maxFrameBytes:linear.length});
    const target=raw==='s8'?'u8':'s16le',decoded=execFileSync(native,['-v','error','-f',raw,'-ar','8000','-ac','1','-i','pipe:0','-f',target,'-'],{input:data});expect(Buffer.from(actual.planes[0]!)).toEqual(decoded);
  }
  for(const bits of [32,64]){
    const words=bits===32?[0n,0x80000000n,0x7f800000n,0xff800000n,0x7f812345n,0xffc54321n]:[0n,0x8000000000000000n,0x7ff0000000000000n,0xfff0000000000000n,0x7ff0123456789abcn,0xfff8123456789abcn];
    const data=new Uint8Array(words.length*bits/8),view=new DataView(data.buffer);words.forEach((word,i)=>{if(bits===32)view.setUint32(i*4,Number(word),false);else view.setBigUint64(i*8,word,false);});
    const codec=`pcm_f${bits}be` as PcmCodec,frame=decodePcm({streamIndex:0,data,pts:null,dts:null,duration:null,timeBase:{num:1n,den:8000n},flags:1},{codec,channels:1,sampleRate:8000},{maxFrameBytes:128});
    const expected=execFileSync(native,['-v','error','-f',`f${bits}be`,'-ar','8000','-ac','1','-i','pipe:0','-f',`f${bits}le`,'-'],{input:data});expect(Buffer.from(frame.planes[0]!)).toEqual(expected);expect(encodePcm(frame,codec,{maxFrameBytes:128}).data).toEqual(data);
  }
},30000);
