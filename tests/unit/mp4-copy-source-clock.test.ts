import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {openMp4,planMp4Copy,muxMp4} from '@edge-ffmpeg/containers';

it('validates source duration after AAC output clock conversion and rolls back changes',async()=>{
 const inputs=JSON.parse(readFileSync('compat/behavior-specs/mp4-demux/inputs.json','utf8')) as {id:string;input:string}[];
 const bytes=Buffer.from(inputs.find(row=>row.id==='audio-1')!.input,'base64');
 const type=bytes.indexOf(Buffer.from('mdhd'));expect(type).toBeGreaterThan(0);
 const body=type+4,scaleAt=body+(bytes[body]===1?20:12),rate=bytes.readUInt32BE(scaleAt);
 bytes.writeUInt32BE(rate*2,scaleAt);
 const source=await openMp4({size:BigInt(bytes.length),async readAt(at,n){return bytes.subarray(Number(at),Number(at)+n);}},{maxReadBytes:17,maxMoovBytes:1048576,maxIndexBytes:1048576,maxPacketBytes:1048576,maxSamples:4096,maxTracks:8,maxBoxes:8192,maxDepth:32});
 const plan=planMp4Copy(source,{maxSamples:4096,maxIndexBytes:1048576}),track=plan[0]!,header=[...source.interleavedPacketHeaders()][0]!;
 expect(track.sourceTimeBase).toEqual({num:1n,den:BigInt(rate*2)});
 expect(track.info.timeBase).toEqual({num:1n,den:BigInt(rate)});
 expect(Object.isFrozen(track.sourceTimeBase)).toBe(true);
 expect(track.samples[0]!.sourceDuration).toBe(header.duration);
 expect(BigInt(track.samples[0]!.duration)*2n).toBe(header.duration);
 let committed=0,aborted=0,changed=false;const previous=Uint8Array.of(19,29);let published:Uint8Array=previous,staged:Uint8Array[]=[];
 async function* altered(){for await(const packet of source.interleavedPackets()){if(!changed){changed=true;yield {...packet,duration:packet.duration!+1n};}else yield packet;}}
 await expect(muxMp4({async write(part){staged.push(part.slice());},async commit(){committed++;published=Buffer.concat(staged);},async abort(){aborted++;staged=[];}},plan,altered(),{maxSamples:4096,maxIndexBytes:1048576,maxMetadataBytes:1048576,maxPacketBytes:1048576,maxWriteBytes:17})).rejects.toMatchObject({code:'invalid-data',message:'MP4 mux packet does not match sample plan'});
 expect([committed,aborted,staged.length]).toEqual([0,1,0]);expect(published).toBe(previous);
});
