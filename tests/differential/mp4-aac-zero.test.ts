import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {openMp4} from '@edge-ffmpeg/containers';
import {loadMp4AacZero} from '../helpers/mp4-aac-zero.js';
it('matches Native zero-frequency AAC indexes metadata and payloads',async()=>{
 const fixture=loadMp4AacZero(),failures:unknown[]=[];
 for(const row of fixture.inputs)try{
  const expected=fixture.results.find(r=>r.id===row.id)!.input,bytes=Buffer.from(row.input,'base64'),source=await openMp4({size:BigInt(bytes.length),async readAt(at,n){return bytes.subarray(Number(at),Number(at)+n);}},{maxReadBytes:7,maxMoovBytes:1048576,maxIndexBytes:1048576,maxPacketBytes:1048576,maxSamples:4096,maxTracks:8,maxBoxes:8192,maxDepth:32}),packets=[];
  for await(const p of source.interleavedPackets())packets.push({stream_index:p.streamIndex,pts:p.pts?.toString()??null,dts:p.dts?.toString()??null,duration:p.duration?.toString()??null,pos:p.position.toString(),flags:p.flags,size:p.data.length,sha256:createHash('sha256').update(p.data).digest('hex'),skipSamples:p.skipSamples?{skipSamples:p.skipSamples.skipSamples.toString(),discardPadding:p.skipSamples.discardPadding.toString()}:null});
  expect(packets,row.id).toEqual(expected.packets.map(p=>({...p,pts:p.pts?.toString()??null,dts:p.dts?.toString()??null,duration:String(p.duration),pos:String(p.pos),skipSamples:p.skipSamples?{skipSamples:String(p.skipSamples.skipSamples),discardPadding:String(p.skipSamples.discardPadding)}:null})));
  expect(source.info.tracks.map(t=>({codec:'aac',id:t.id,default:t.defaultDisposition?1:0,timeBase:t.timeBase.num+'/'+t.timeBase.den,sampleRate:t.sampleRate,channels:t.codecChannels??t.containerChannels,start:t.startTime?.toString()??null,duration:t.duration.toString(),count:t.sampleCount.toString()})),row.id).toEqual(expected.streams.map(s=>({codec:s.codec,id:s.id,default:s.default,timeBase:s.timeBase,sampleRate:s.sampleRate,channels:s.channels,start:s.start?.toString()??null,duration:s.duration?.toString()??null,count:String(s.count)})));
  expect(source.info.startTimeUs?.toString()??null,row.id).toBe(expected.formatStartUs?.toString()??null);
 }catch(error){failures.push({id:row.id,error:String(error)});}
 writeFileSync('.build/aac-zero-canonical-index-result.json',JSON.stringify({cases:fixture.inputs.length,failures},null,2)+'\n');expect(failures).toEqual([]);
},60000);
