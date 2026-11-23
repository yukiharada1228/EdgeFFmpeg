import {describe,it,expect} from 'vitest';
import {createFlacDescriptorParser,parseFlacHeaderCandidate} from '@edge-ffmpeg/avcodec';
import {createFlacCandidateGraph,scoreFlacCandidateSequence} from '../../packages/avcodec/src/flac/graph.js';
import {crc8Atm} from '../../packages/avcodec/src/flac/header.js';
import type {FlacFrameHeader,FlacHeaderCandidate} from '@edge-ffmpeg/avcodec';
const base:FlacFrameHeader={kind:'candidate',variable:false,number:0n,channels:2,channelMode:0,bitsPerSample:16,sampleRate:48000,blockSamples:192,headerBytes:6,inspectedBytes:7,subframeType:0,needsStreamInfo:false};
const candidate=(header:FlacFrameHeader):FlacHeaderCandidate=>({offset:0n,header,prefixCrc16:0});
const invalid:Partial<FlacFrameHeader>[]=[
 {number:-1n},{number:0x80000000n},{number:1 as unknown as bigint},{variable:0 as unknown as boolean},
 ...[0,-1,65537,1.5,NaN,Infinity].map(blockSamples=>({blockSamples})),
 ...[0,9,-1,1.5,NaN,Infinity].map(channels=>({channels})),
 ...[-1,1,15,17,33,NaN,Infinity].map(bitsPerSample=>({bitsPerSample})),
 ...[-1,0.5,65536,65539,655351,NaN,Infinity].map(sampleRate=>({sampleRate})),
];
describe('FLAC descriptor header domains',()=>{
 for(const [index,patch] of invalid.entries())it(`rejects invalid header ${index} at every descriptor boundary`,async()=>{
  const header={...base,...patch};
  expect(()=>scoreFlacCandidateSequence([candidate(header)])).toThrow(TypeError);
  expect(()=>scoreFlacCandidateSequence([],{lastHeader:header})).toThrow(TypeError);
  const graph=createFlacCandidateGraph();
  expect(()=>graph.append(candidate(header))).toThrow(TypeError);
  graph.append(candidate(base));
  expect(()=>graph.rescore({lastHeader:header})).toThrow(TypeError);
  expect(graph.rescore().headers).toHaveLength(1);graph.close();
  // Exercise discovery on physical intake and on EOF padding: neither may
  // publish a frame carrying invalid duration or codecPts.
  for(const eof of [false,true]){
   const parser=createFlacDescriptorParser({discover:request=>request.padding===eof?[{...candidate(header),offset:request.searchStart}]:[]});
   if(eof)await parser.parse({offset:0n,bytes:20});
   await expect(parser.parse({offset:eof?20n:0n,bytes:eof?0:20})).rejects.toThrow(TypeError);
   expect(parser.metrics.failed).toBe(true);
   await expect(parser.parse({offset:20n,bytes:0})).rejects.toThrow('failed');parser.close();
  }
 });
 it('accepts all bps choices, inherited fields and numeric domain boundaries',()=>{
  const patches:Partial<FlacFrameHeader>[]=[{number:0x7fffffffn,variable:true},{blockSamples:1},{blockSamples:65536},{channels:1},{channels:8},
   ...[0,8,12,16,20,24,32].map(bitsPerSample=>({bitsPerSample})),
   ...[0,1,65535,65540,655350,88200,176400,192000,255000].map(sampleRate=>({sampleRate}))];
  for(const patch of patches){const header={...base,...patch};expect(scoreFlacCandidateSequence([candidate(header)],{lastHeader:header}).headers).toHaveLength(1);const graph=createFlacCandidateGraph();graph.append(candidate(header));expect(graph.rescore({lastHeader:header}).headers).toHaveLength(1);graph.close();}
 });
 it('preserves parsed overlong numbers and inherited zero rate and bps through EOF',async()=>{
  // Six-byte overlong zero; block code 7 encodes the maximum 65536 samples.
  const bytes=[255,249,112,112,252,128,128,128,128,128,255,255];
  bytes.push(crc8Atm(Uint8Array.from(bytes)),0);
  const header=parseFlacHeaderCandidate(Uint8Array.from(bytes));expect(header.kind).toBe('candidate');
  if(header.kind!=='candidate')throw Error('Missing candidate');
  expect(header).toMatchObject({number:0n,blockSamples:65536,sampleRate:0,bitsPerSample:0,channels:8});
  const parser=createFlacDescriptorParser({discover:request=>request.padding?[]:[candidate(header)]});
  await parser.parse({offset:0n,bytes:32});
  await expect(parser.parse({offset:32n,bytes:0})).resolves.toMatchObject({packet:{kind:'frame',parserDuration:65536,codecPts:0n}});parser.close();
 });
});
