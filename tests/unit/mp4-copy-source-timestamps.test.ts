import {it,expect} from 'vitest';
import {openMp4,planMp4Copy,muxMp4} from '@edge-ffmpeg/containers';
import {loadMp4VideoEdits} from '../helpers/mp4-video-edits.js';
it('rejects altered source DTS after copy normalization and aborts staged output',async()=>{
 const row=loadMp4VideoEdits().inputs.find(row=>row.id==='multikey-100000-80')!,bytes=Buffer.from(row.input,'base64'),source=await openMp4({size:BigInt(bytes.length),async readAt(at,length){return bytes.subarray(Number(at),Number(at)+length);}},{maxReadBytes:65536,maxMoovBytes:1048576,maxIndexBytes:1048576,maxPacketBytes:1048576,maxSamples:1024,maxTracks:8,maxBoxes:8192,maxDepth:32}),plan=planMp4Copy(source,{maxSamples:1024,maxIndexBytes:1048576});
 expect(plan[0]!.samples[1]!.dts).toBe(1n);expect(plan[0]!.samples[1]!.sourceDts).toBe(0n);
 const previous=Uint8Array.of(17,31,47);let published:Uint8Array=previous;let staged:Uint8Array[]=[];let aborts=0,writes=0,commits=0;
 async function* altered(){let index=0;for await(const packet of source.interleavedPackets())yield index++===1?{...packet,dts:1n}:packet;}
 await expect(muxMp4({async write(part){writes++;staged.push(part.slice());},async commit(){commits++;published=Buffer.concat(staged);},async abort(){aborts++;staged=[];}},plan,altered(),{maxSamples:1024,maxIndexBytes:1048576,maxMetadataBytes:1048576,maxPacketBytes:1048576,maxWriteBytes:65536})).rejects.toMatchObject({code:'invalid-data',message:'MP4 mux packet does not match sample plan'});
 expect(writes).toBeGreaterThan(1);expect([commits,aborts,staged.length]).toEqual([0,1,0]);expect(published).toBe(previous);
});
