import{it,expect}from'vitest';
import{readFileSync}from'node:fs';
import{createHash}from'node:crypto';
import{createFlacDescriptorParser,parseFlacHeaderCandidate}from'@edge-ffmpeg/avcodec';
import type{FlacParserFlags,FlacHeaderCandidate}from'@edge-ffmpeg/avcodec';
import{flacTestCrc16}from'../helpers/flac-parser.js';
interface Row{at:number;input:number;used:number;size:number;duration:number;pts:string;dts:string;pos:string;offset:string;frameOffset:string;nextFrameOffset:string;currentOffset:string}
const base='compat/behavior-specs/flac-parser-flags/',raw=readFileSync(base+'cases.json'),fixture=JSON.parse(raw.toString())as{inputHex:string;cases:{inputHex?:string;chunk:number;flags:FlacParserFlags;schedule:number;trace:Row[]}[]};
it('verifies permanent native trace integrity',()=>{const provenance=JSON.parse(readFileSync(base+'provenance.json','utf8'))as{casesSha256:string};expect(createHash('sha256').update(raw).digest('hex')).toBe(provenance.casesSha256);});
for(const test of fixture.cases)it(`matches Native flags=${test.flags} chunk=${test.chunk} schedule=${test.schedule}`,async()=>{
 const data=Uint8Array.from(Buffer.from(test.inputHex??fixture.inputHex,'hex')),backing=new Uint8Array(data.length+64);backing.set(data);
 const candidates:FlacHeaderCandidate[]=[];let crc=0;
 for(let at=0;at<data.length;at++){
  const h=parseFlacHeaderCandidate(backing.subarray(at,at+17));if(h.kind==='candidate')candidates.push({offset:BigInt(at),header:h,prefixCrc16:crc});
  crc=flacTestCrc16(data.subarray(at,at+1),crc);
 }
 const parser=createFlacDescriptorParser({flags:test.flags,discover:r=>candidates.filter(c=>c.offset>=r.searchStart&&c.offset<r.searchEndExclusive),inspectCompleteHeader:r=>{const h=parseFlacHeaderCandidate(backing.subarray(Number(r.physicalOffset),Number(r.physicalOffset)+17));return h.kind==='candidate'?h:null;}});
 for(const[call,row]of test.trace.entries()){
  const pts=test.schedule===2?null:BigInt(test.schedule===1?1000+call:123),dts=test.schedule===2?null:BigInt(test.schedule===1?900+call:100),pos=test.schedule===2?-1n:BigInt(500+row.at);
  const result=await parser.parse({offset:BigInt(row.at),bytes:row.input,pts,dts,pos});
  expect({used:result.consumed,size:Number(result.packet?.bytes??0n),duration:result.parserDuration,pts:String(result.parserPts??-9223372036854775808n),dts:String(result.parserDts??-9223372036854775808n),pos:String(result.parserPos),offset:String(result.timestampOffset),nextFrameOffset:String(result.nextFrameOffset),currentOffset:String(result.currentOffset)},`call ${call}`).toEqual({used:row.used,size:row.size,duration:row.duration,pts:row.pts,dts:row.dts,pos:row.pos,offset:row.offset,nextFrameOffset:row.nextFrameOffset,currentOffset:row.currentOffset});
  if(result.packet)expect(String(result.frameOffset)).toBe(row.frameOffset);
 }
 expect(parser.metrics.sourcePayloadRetained).toBe(false);parser.close();
});
