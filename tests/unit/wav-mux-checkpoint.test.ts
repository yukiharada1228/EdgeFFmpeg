import {expect,it} from 'vitest';
import {createWavMuxState,deserializeWavMuxState,muxWav,serializeWavMuxState,wavMuxPatches,WavError} from '@edge-ffmpeg/containers';
import type {WavMuxPatch,WavMuxSnapshot,WavOutputFormat,WavPcmCodec} from '@edge-ffmpeg/containers';
import type {MediaPacket} from '@edge-ffmpeg/core';
import {collectingOutput} from '../helpers/output.js';
const widths:Record<WavPcmCodec,number>={pcm_u8:1,pcm_s16le:2,pcm_s24le:3,pcm_s32le:4,pcm_f32le:4,pcm_f64le:8,pcm_alaw:1,pcm_mulaw:1};
const profile='ffmpeg-9.0.2' as const;
const packet=(data:Uint8Array,start:bigint,samples:bigint,rate:number,scale=1n):MediaPacket=>({streamIndex:0,data,pts:start*scale,dts:start*scale,duration:samples*scale,timeBase:{num:1n,den:BigInt(rate)*scale},flags:1});
const concat=(chunks:readonly Uint8Array[])=>{const bytes=new Uint8Array(chunks.reduce((size,chunk)=>size+chunk.length,0));let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;};
function patch(bytes:Uint8Array,patches:readonly WavMuxPatch[]):Uint8Array{const result=bytes.slice();for(const {offset,bytes:value} of patches)result.set(value,Number(offset));return result;}
async function finite(format:WavOutputFormat,data:Uint8Array,samples:bigint,bitexact:boolean):Promise<Uint8Array>{
 const sink=collectingOutput();async function* packets(){if(samples)yield packet(data,0n,samples,format.sampleRate);}
 await muxWav(sink.output,format,packets(),{sampleCount:samples,maxWriteBytes:5,metadataProfile:profile,bitexact});return sink.bytes();
}
/** Continue across a canonical snapshot round trip before every operation, as a fresh runtime would. */
function continued(format:WavOutputFormat,data:Uint8Array,samples:bigint,bitexact:boolean,split:number){
 const block=format.channels*widths[format.codec],options={metadataProfile:profile,bitexact},chunks:Uint8Array[]=[],resume=(snapshot:WavMuxSnapshot)=>createWavMuxState(format,options,deserializeWavMuxState(serializeWavMuxState(snapshot)));
 let state=createWavMuxState(format,options);chunks.push(state.start());
 for(let sample=0n;sample<samples;){state=resume(state.snapshot());const count=samples-sample<BigInt(split)?samples-sample:BigInt(split);chunks.push(state.write(packet(data.subarray(Number(sample)*block,Number(sample+count)*block),sample,count,format.sampleRate,sample%2n?3n:1n)));sample+=count;}
 state=resume(state.snapshot());const trailer=state.finish();chunks.push(trailer.bytes);const terminal=resume(state.snapshot()).snapshot();
 return {raw:concat(chunks),trailer,terminal,state};
}
it('reproduces the finite native-profile muxer byte for byte across every codec, layout and profile with restores between packets',async()=>{
 const layouts:readonly {channels:number;channelMask?:number|bigint|null}[]=[{channels:1},{channels:1,channelMask:4},{channels:2,channelMask:3},{channels:2,channelMask:null},{channels:3},{channels:2,channelMask:0x40000n},{channels:6,channelMask:0x3f},{channels:2,channelMask:0x80000000}];
 let checked=0;
 for(const codec of Object.keys(widths) as WavPcmCodec[])for(const layout of layouts)for(const sampleRate of [8000,96000])for(const bitexact of [false,true])for(const samples of [0n,1n,7n]){
  const format={codec,sampleRate,...layout},block=layout.channels*widths[codec],data=Uint8Array.from({length:Number(samples)*block},(_,index)=>(index*37+11)&255);
  const expected=await finite(format,data,samples,bitexact),{raw,trailer,terminal,state}=continued(format,data,samples,bitexact,3),headerBytes=terminal.layout.headerBytes;
  expect(patch(raw,trailer.patches)).toEqual(expected);expect(raw.length).toBe(expected.length);expect(BigInt(terminal.bytes)).toBe(BigInt(expected.length));expect(state).toMatchObject({finished:true,samples,bytes:BigInt(expected.length)});
  expect(trailer.bytes.length).toBe(Number(samples*BigInt(block)&1n));expect(trailer.patches.map(entry=>entry.offset)).toEqual([4n,...(terminal.layout.factOffset===null?[]:[BigInt(terminal.layout.factOffset)]),BigInt(headerBytes-4)]);expect(wavMuxPatches(terminal)).toEqual(trailer.patches);
  // Pre-trailer header: identical to the final header except the native placeholders in the rewritten fields.
  const view=new DataView(raw.buffer);expect(view.getUint32(4,true)).toBe(0xffffffff);expect(view.getUint32(headerBytes-4,true)).toBe(0xffffffff);if(terminal.layout.factOffset!==null)expect(view.getUint32(terminal.layout.factOffset,true)).toBe(0);
  for(let i=0;i<raw.length;i++)if(raw[i]!==expected[i])expect(trailer.patches.some(entry=>BigInt(i)>=entry.offset&&BigInt(i)<entry.offset+4n),codec+' byte '+i).toBe(true);
  expect(raw.subarray(headerBytes)).toEqual(expected.subarray(headerBytes));checked++;
 }
 expect(checked).toBe(768);
});
it('writes the native zero-packet fact count and encodes canonical strict snapshots',()=>{
 const state=createWavMuxState({codec:'pcm_alaw',channels:1,sampleRate:8000},{metadataProfile:profile,bitexact:true}),header=state.start();expect(header.length).toBe(58);
 const trailer=state.finish(),fact=trailer.patches[1]!;expect(fact.offset).toBe(46n);expect([...fact.bytes]).toEqual([1,0,0,0]);expect(trailer.bytes.length).toBe(0);
 const bytes=serializeWavMuxState(state.snapshot());expect(new TextDecoder().decode(bytes)).toBe('{"version":1,"kind":"wav-mux","format":{"codec":"pcm_alaw","channels":1,"sampleRate":8000,"channelMask":"0"},"metadataProfile":"ffmpeg-9.0.2","bitexact":true,"layout":{"headerBytes":58,"factOffset":46,"dataSizeOffset":54},"bytes":"58","samples":"0","finished":true}');
 expect(deserializeWavMuxState(bytes)).toEqual(state.snapshot());
 const text=new TextDecoder().decode(bytes),encode=(value:string)=>new TextEncoder().encode(value),mutate=(from:string,to:string)=>{expect(text.includes(from),from).toBe(true);return encode(text.replace(from,to));};
 for(const invalid of [encode(' '+text),encode(text+'\n'),Uint8Array.of(0xef,0xbb,0xbf,...bytes),mutate('"version":1','"version":2'),mutate('"kind":"wav-mux"','"kind":"wav"'),mutate('"bytes":"58"','"bytes":"058"'),mutate('"bytes":"58"','"bytes":58'),mutate('"bytes":"58"','"bytes":"60"'),mutate('"samples":"0"','"samples":"1"'),mutate('"channelMask":"0"','"channelMask":"-1"'),mutate('"channelMask":"0"','"channelMask":"18446744073709551616"'),mutate('"factOffset":46','"factOffset":null'),mutate('"headerBytes":58','"headerBytes":60'),mutate('"metadataProfile":"ffmpeg-9.0.2"','"metadataProfile":"ffmpeg-8"'),mutate('"codec":"pcm_alaw"','"codec":"pcm_s16be"'),mutate('"bitexact":true','"bitexact":"true"'),mutate('"finished":true','"finished":true,"extra":0'),mutate('{"version":1,"kind":"wav-mux"','{"kind":"wav-mux","version":1'),new Uint8Array([0xff,0xfe]),new Uint8Array(1025),encode('[]'),encode('null')])
  expect(()=>deserializeWavMuxState(invalid)).toThrow();
 // Unknown, null or absent snapshot profiles are invalid data with the codec's error type, not a bare RangeError.
 const {metadataProfile:_profile,...unprofiled}=state.snapshot();void _profile;
 for(const snapshot of [{...state.snapshot(),metadataProfile:'ffmpeg-8'},{...state.snapshot(),metadataProfile:null},unprofiled] as never[]){expect(()=>serializeWavMuxState(snapshot)).toThrow(expect.objectContaining({code:'invalid-data',message:expect.stringMatching(/metadata profile/)}));expect(()=>createWavMuxState({codec:'pcm_alaw',channels:1,sampleRate:8000},{metadataProfile:profile,bitexact:true},snapshot)).toThrow(WavError);}
 expect(()=>deserializeWavMuxState(mutate('"metadataProfile":"ffmpeg-9.0.2"','"metadataProfile":"ffmpeg-8"'))).toThrow(expect.objectContaining({code:'invalid-data'}));
});
it('restores only a matching configuration and keeps a rejected packet from changing state',()=>{
 const format={codec:'pcm_s16le',channels:2,sampleRate:8000,channelMask:3} as const,options={metadataProfile:profile},state=createWavMuxState(format,options);state.start();state.write(packet(new Uint8Array(8),0n,2n,8000));const snapshot=state.snapshot();
 for(const [other,otherOptions] of [[{...format,channels:1},options],[{...format,channelMask:0},options],[{...format,sampleRate:16000},options],[{...format,codec:'pcm_s24le'},options],[format,{...options,bitexact:true}]] as const)expect(()=>createWavMuxState(other,otherOptions,snapshot)).toThrow(/mismatch|disagrees/);
 // Number and bigint forms of one mask serialize to the same effective decimal and restore interchangeably.
 expect(createWavMuxState({...format,channelMask:3n},options,snapshot).snapshot()).toEqual(snapshot);
 for(const bad of [packet(new Uint8Array(6),2n,1n,8000),packet(new Uint8Array(8),3n,2n,8000),{...packet(new Uint8Array(8),2n,2n,8000),streamIndex:1},packet(new Uint8Array(8),2n,3n,8000),packet(new Uint8Array(),2n,0n,8000),{...packet(new Uint8Array(8),2n,2n,8000),pts:null}]){expect(()=>state.write(bad)).toThrow(WavError);expect(state.snapshot()).toEqual(snapshot);}
 expect(()=>state.start()).toThrow('already emitted');state.write(packet(new Uint8Array(4),2n,1n,8000));state.finish();for(const call of [()=>state.finish(),()=>state.write(packet(new Uint8Array(4),3n,1n,8000)),()=>state.start()])expect(call).toThrow(WavError);
 const fresh=createWavMuxState(format,options);expect(()=>fresh.write(packet(new Uint8Array(4),0n,1n,8000))).toThrow('not started');expect(()=>fresh.finish()).toThrow('not started');expect(()=>wavMuxPatches(fresh.snapshot())).toThrow('finished');expect(fresh.snapshot()).toMatchObject({bytes:'0',samples:'0',finished:false});
 const odd=createWavMuxState({codec:'pcm_u8',channels:1,sampleRate:8000},options);odd.start();odd.write(packet(new Uint8Array(3),0n,3n,8000));const open=odd.snapshot();
 expect(()=>createWavMuxState({codec:'pcm_u8',channels:1,sampleRate:8000},options,{...open,finished:true})).toThrow('disagree');expect(()=>wavMuxPatches(open)).toThrow('finished');expect(odd.finish().bytes).toEqual(new Uint8Array(1));
});
it('fails explicitly for unsupported profiles, codecs and RF64-sized continuations without mutating state',()=>{
 expect(()=>createWavMuxState({codec:'pcm_s16le',channels:1,sampleRate:8000},{} as never)).toThrow(expect.objectContaining({code:'unsupported'}));
 expect(()=>createWavMuxState({codec:'pcm_s16be' as WavPcmCodec,channels:1,sampleRate:8000},{metadataProfile:profile})).toThrow(expect.objectContaining({code:'unsupported'}));
 expect(()=>createWavMuxState({codec:'pcm_s16le',channels:1,sampleRate:8000},{metadataProfile:'ffmpeg-8' as never})).toThrow();
 for(const format of [{codec:'pcm_s16le',channels:0,sampleRate:8000},{codec:'pcm_s16le',channels:1,sampleRate:0},{codec:'pcm_s16le',channels:1,sampleRate:8000,channelMask:-1},{codec:'pcm_s16le',channels:1,sampleRate:8000,channelMask:'3'}] as const)expect(()=>createWavMuxState(format as WavOutputFormat,{metadataProfile:profile})).toThrow(WavError);
 const format={codec:'pcm_s16le',channels:1,sampleRate:8000} as const,options={metadataProfile:profile,bitexact:true},samples=0x7fffff00n,near={...createWavMuxState(format,options).snapshot(),bytes:String(44n+samples*2n),samples:String(samples)};
 const state=createWavMuxState(format,options,deserializeWavMuxState(serializeWavMuxState(near)));expect(()=>state.write(packet(new Uint8Array(512),samples,256n,8000))).toThrow(expect.objectContaining({code:'unsupported',message:expect.stringMatching(/RF64/)}));expect(state.snapshot()).toEqual(near);
 state.write(packet(new Uint8Array(2),samples,1n,8000));expect(wavMuxPatches({...state.snapshot(),finished:true,bytes:String(44n+(samples+1n)*2n)}).map(entry=>[...entry.bytes])).toEqual([[0x26,0xfe,0xff,0xff],[0x02,0xfe,0xff,0xff]]);
 expect(()=>serializeWavMuxState({...near,bytes:String(44n+0x80000000n*2n),samples:'2147483648'})).toThrow('RF64');
 const controller=new AbortController(),live=createWavMuxState(format,{...options,signal:controller.signal});live.start();controller.abort(Error('stop'));expect(()=>live.write(packet(new Uint8Array(2),0n,1n,8000))).toThrow('stop');expect(()=>createWavMuxState(format,{...options,signal:controller.signal})).toThrow('stop');
});
