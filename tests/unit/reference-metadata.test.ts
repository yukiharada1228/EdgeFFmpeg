import {it,expect} from 'vitest';import {readFileSync} from 'node:fs';
import {muxWav,muxFrameCrc,muxRawVideoFrameCrc} from '@edge-ffmpeg/containers';import type {ReferenceMetadataProfile} from '@edge-ffmpeg/containers';import type {MediaPacket} from '@edge-ffmpeg/core';import {collectingOutput} from '../helpers/output.js';
async function* empty():AsyncIterable<MediaPacket>{}
const profile='ffmpeg-9.0.2' as const,audio={codec:'pcm_s16le',channels:1,sampleRate:8000} as const,video={width:2,height:2,pixelFormat:'gray',frameRate:{num:25n,den:1n}};
type Row={group:string;argv:string[];inputs:{base64:string}[];outputs:{base64:string}[]};
function native(format:string,bitexact=false){const rows=JSON.parse(readFileSync('compat/behavior-specs/reference-metadata/cases.json','utf8')) as Row[];const row=rows.find(r=>r.group==='audio'&&r.argv[1]==='s16le'&&r.argv[5]==='1'&&r.inputs[0]!.base64===''&&r.argv.at(-2)===format&&r.argv.includes('-bitexact')===bitexact&&!r.argv.includes('-fflags'));if(!row)throw Error('Missing Native metadata control');return Buffer.from(row.outputs[0]!.base64,'base64');}
it('serializes the selected reference identity with bounded writes while preserving legacy low-level WAV output',async()=>{
 const wav=collectingOutput();await muxWav(wav.output,audio,empty(),{sampleCount:0n,maxWriteBytes:1,metadataProfile:profile});expect(Buffer.from(wav.bytes())).toEqual(native('wav'));expect(wav.lengths.every(n=>n<=1)).toBe(true);
 const legacy=collectingOutput();await muxWav(legacy.output,audio,empty(),{sampleCount:0n,maxWriteBytes:1});expect(Buffer.from(legacy.bytes())).toEqual(native('wav',true));
 const crc=collectingOutput();await muxFrameCrc(crc.output,{codec:audio.codec,sampleRate:8000,channelLayout:'mono'},empty(),{maxWriteBytes:1,metadataProfile:profile});expect(Buffer.from(crc.bytes())).toEqual(native('framecrc'));expect(crc.lengths.every(n=>n<=1)).toBe(true);
});
it('rejects unknown reference metadata profiles before output and aborts every owned mux transaction',async()=>{
 const invalid='unregistered-target' as ReferenceMetadataProfile;
 for(const kind of ['wav','audio-crc','video-crc']){const sink=collectingOutput();const promise=kind==='wav'?muxWav(sink.output,audio,empty(),{sampleCount:0n,maxWriteBytes:1,metadataProfile:invalid}):kind==='audio-crc'?muxFrameCrc(sink.output,{codec:audio.codec,sampleRate:8000,channelLayout:'mono'},empty(),{maxWriteBytes:1,metadataProfile:invalid}):muxRawVideoFrameCrc(sink.output,video,empty(),{frameCount:0n,maxWriteBytes:1,metadataProfile:invalid});await expect(promise).rejects.toThrow('Unsupported reference metadata profile');expect(sink.aborted).toBe(true);expect(sink.committed).toBe(false);expect(sink.lengths).toEqual([]);}
});
it('snapshots reference WAV metadata before asynchronous writes and preserves cancellation precedence',async()=>{
 const sink=collectingOutput(),options:{sampleCount:bigint;maxWriteBytes:number;metadataProfile?:ReferenceMetadataProfile}={sampleCount:0n,maxWriteBytes:1,metadataProfile:profile};
 await muxWav({...sink.output,async write(bytes){delete options.metadataProfile;await sink.output.write(bytes);}},audio,empty(),options);expect(Buffer.from(sink.bytes())).toEqual(native('wav'));
 const controller=new AbortController();controller.abort(new Error('cancelled'));for(const kind of ['wav','audio-crc','video-crc']){const cancelled=collectingOutput(),bad='invalid' as ReferenceMetadataProfile;const promise=kind==='wav'?muxWav(cancelled.output,audio,empty(),{sampleCount:0n,maxWriteBytes:1,metadataProfile:bad,signal:controller.signal}):kind==='audio-crc'?muxFrameCrc(cancelled.output,{codec:audio.codec,sampleRate:8000,channelLayout:'mono'},empty(),{maxWriteBytes:1,metadataProfile:bad,signal:controller.signal}):muxRawVideoFrameCrc(cancelled.output,video,empty(),{frameCount:0n,maxWriteBytes:1,metadataProfile:bad,signal:controller.signal});await expect(promise).rejects.toThrow('cancelled');expect(cancelled.aborted).toBe(true);expect(cancelled.lengths).toEqual([]);}
});

it('retains high WAV channel masks in the legacy low-level profile while applying Native serialization only to the selected profile',async()=>{
 for(const channelMask of [0x40000,0x40001,0x60000,0x80000000]) {
  const channels=channelMask.toString(2).replaceAll('0','').length;
  for(const metadataProfile of [undefined,profile]) {
   const sink=collectingOutput();
   await muxWav(sink.output,{...audio,channels,channelMask},empty(),{sampleCount:0n,maxWriteBytes:3,...(metadataProfile===undefined?{}:{metadataProfile}),bitexact:true});
   const bytes=sink.bytes(),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
   expect(view.getUint16(20,true)).toBe(65534);
   expect(view.getUint32(40,true)).toBe(metadataProfile===undefined?channelMask:0);
   expect(sink.committed).toBe(true);expect(sink.aborted).toBe(false);
  }
 }
});
