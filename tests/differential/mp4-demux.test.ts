import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {openMp4} from '@edge-ffmpeg/containers';
interface Input {id:string;group:string;input:string}
interface Stream {index:number;codec_type:string;codec_tag_string:string;width?:number;height?:number;sample_rate?:string;initial_padding?:number;time_base:string;duration_ts:number;nb_frames:string}
interface Packet {stream_index:number;pts:number;dts:number;duration:number;pos:string;flags:string;data:string;side_data_list?:{side_data_type:string;skip_samples:number;discard_padding:number}[]}
interface Result {id:string;inputSha256:string;streams:Stream[];packets:Packet[]}
const canonical=new URL('../../compat/behavior-specs/mp4-demux/',import.meta.url),read=(name:string)=>readFileSync(new URL(name,canonical)),hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const inputs=JSON.parse(read('inputs.json').toString()) as Input[],results=JSON.parse(read('results.json').toString()) as Result[];
for(const group of [...new Set(inputs.map(row=>row.group))])it('matches pinned MP4 '+group+' packet bytes, clocks and interleave order',async()=>{
 const manifest=JSON.parse(read('manifest.json').toString()) as {sha256:Record<string,string>};for(const [name,digest]of Object.entries(manifest.sha256))expect(hash(read(name)),name).toBe(digest);
 const provenance=JSON.parse(read('provenance.json').toString()) as {reference:{commit:string};sources:Record<string,string>;caseCount:number};expect(provenance.reference.commit).toBe(JSON.parse(readFileSync('compat/upstream.lock.json','utf8')).commit);for(const [file,digest]of Object.entries(provenance.sources))expect(hash(readFileSync(file)),file).toBe(digest);expect(inputs).toHaveLength(85);expect(results).toHaveLength(85);
 for(const row of inputs.filter(row=>row.group===group)){
  const wanted=results.find(r=>r.id===row.id)!;expect(wanted,row.id).toBeDefined();const bytes=Buffer.from(row.input,'base64');expect(hash(bytes),row.id).toBe(wanted.inputSha256);const reads:{offset:bigint;length:number}[]=[];
  const source=await openMp4({size:BigInt(bytes.length),async readAt(offset,length){reads.push({offset,length});return new Uint8Array(bytes.subarray(Number(offset),Number(offset)+Math.min(length,3)));}},{maxReadBytes:17,maxMoovBytes:65536,maxIndexBytes:65536,maxPacketBytes:65536,maxSamples:1024,maxTracks:8,maxBoxes:1024,maxDepth:16});
  expect(source.info.tracks,row.id).toHaveLength(wanted.streams.length);for(const track of source.info.tracks){const stream=wanted.streams[track.index]!;expect(track.type).toBe(stream.codec_type);expect(track.codecTag).toBe(stream.codec_tag_string);expect(`${track.timeBase.num}/${track.timeBase.den}`).toBe(stream.time_base);expect(track.duration).toBe(BigInt(stream.duration_ts));expect(track.sampleCount).toBe(BigInt(stream.nb_frames));if(track.type==='video')expect([track.width,track.height]).toEqual([stream.width,stream.height]);else expect(track.sampleRate).toBe(Number(stream.sample_rate));if(stream.initial_padding)expect(track.initialPadding).toBe(BigInt(stream.initial_padding));}
  const packets=[];for await(const packet of source.interleavedPackets())packets.push(packet);expect(packets,row.id).toHaveLength(wanted.packets.length);
  for(const [i,actual]of packets.entries()){const expected=wanted.packets[i]!;expect([actual.streamIndex,actual.pts,actual.dts,actual.duration,actual.position,actual.flags],row.id).toEqual([expected.stream_index,BigInt(expected.pts),BigInt(expected.dts),BigInt(expected.duration),BigInt(expected.pos),(expected.flags.includes('K')?1:0)|(expected.flags.includes('D')?4:0)]);expect(Buffer.from(actual.data).toString('base64'),row.id).toBe(expected.data);const skip=expected.side_data_list?.find(s=>s.side_data_type==='Skip Samples');expect(actual.skipSamples,row.id).toEqual(skip?{skipSamples:BigInt(skip.skip_samples),discardPadding:BigInt(skip.discard_padding)}:undefined);}
  expect(reads.every(r=>r.length<=17)).toBe(true);
 }
});
