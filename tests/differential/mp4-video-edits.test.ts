import {loadMp4VideoEdits} from '../helpers/mp4-video-edits.js';
import {it,expect} from 'vitest';
import {writeFileSync} from 'node:fs';
import {openMp4} from '@edge-ffmpeg/containers';
it('matches native single video edit packet clocks and discard flags',async()=>{
 const {inputs,results}=loadMp4VideoEdits(),failures:{id:string;error:string}[]=[];
 for(const input of inputs){try{const row=results.find(r=>r.id===input.id)!,bytes=Buffer.from(input.input,'base64'),source=await openMp4({size:BigInt(bytes.length),async readAt(offset,length){return bytes.subarray(Number(offset),Number(offset)+length);}},{maxReadBytes:65536,maxMoovBytes:65536,maxIndexBytes:65536,maxPacketBytes:65536,maxSamples:1024,maxTracks:8,maxBoxes:2048,maxDepth:16});expect(source.info.tracks[0]!.duration,row.id).toBe(BigInt(row.streamFields.duration_ts));const actual=[];for await(const packet of source.packets(0))actual.push({pts:Number(packet.pts),dts:Number(packet.dts),duration:Number(packet.duration),flags:(packet.flags&1?'K':'_')+(packet.flags&4?'D':'_')+'_',pos:String(packet.position)});expect(actual,row.id).toEqual(row.packets);}catch(error){failures.push({id:input.id,error:String(error)});}}
 writeFileSync('.build/mp4-video-edits-result.json',JSON.stringify({checked:inputs.length,failures},null,2)+'\n');expect(failures).toEqual([]);
});
