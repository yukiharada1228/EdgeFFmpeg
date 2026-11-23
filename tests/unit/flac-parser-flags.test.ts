import{it,expect}from'vitest';
import{createFlacDescriptorParser,PARSER_FLAG_COMPLETE_FRAMES,PARSER_FLAG_USE_CODEC_TS}from'@edge-ffmpeg/avcodec';
import type{FlacCompleteHeader,FlacParserFlags}from'@edge-ffmpeg/avcodec';
const header={variable:false,number:3n,blockSamples:192};
it('exports Native flags and rejects unsupported modes and missing trusted inspection',()=>{
 expect([PARSER_FLAG_COMPLETE_FRAMES,PARSER_FLAG_USE_CODEC_TS]).toEqual([1,4096]);
 expect(()=>createFlacDescriptorParser({flags:2 as FlacParserFlags,discover:()=>[]})).toThrow('Unsupported');
 expect(()=>createFlacDescriptorParser({flags:1,discover:()=>[]})).toThrow('trusted');
});
it('separates caller position, source coordinates, codec timestamp and stale parser duration',async()=>{
 let calls=0;const p=createFlacDescriptorParser({flags:4097,discover:()=>{throw Error('unused');},inspectCompleteHeader:r=>{expect(r.maxInspectedBytes).toBe(17);return calls++?null:header;}});
 expect(await p.parse({offset:0n,bytes:7,pts:100n,dts:90n,pos:500n})).toMatchObject({packet:{sourceOffset:0n,bytes:7n,codecPts:576n},parserPts:576n,parserDts:90n,parserPos:500n,parserDuration:192,currentOffset:507n});
 expect(await p.parse({offset:7n,bytes:1,pts:200n,dts:190n,pos:900n})).toMatchObject({packet:{bytes:1n,codecPts:null,parserDuration:192},parserPts:200n,parserDts:190n,parserPos:900n,parserDuration:192});
 expect(await p.parse({offset:8n,bytes:0})).toMatchObject({packet:null,parserDuration:192,parserPts:null,parserDts:null,parserPos:-1n});expect(calls).toBe(2);
 await expect(p.parse({offset:8n,bytes:1})).rejects.toThrow('after EOF');p.close();
});
it('bounds and validates trusted descriptor domains and poisons callback failures',async()=>{
 for(const bad of [{...header,number:-1n},{...header,number:0x80000000n},{...header,variable:1},{...header,blockSamples:65537}]){
  const p=createFlacDescriptorParser({flags:1,discover:()=>[],inspectCompleteHeader:()=>bad as FlacCompleteHeader});await expect(p.parse({offset:0n,bytes:1})).rejects.toThrow('Invalid trusted');expect(p.metrics.failed).toBe(true);p.close();
 }
 const p=createFlacDescriptorParser({discover:()=>[]});
 for(const input of [{pts:-0x8000000000000000n},{dts:0x8000000000000000n},{pos:-0x8000000000000001n}])await expect(p.parse({offset:0n,bytes:1,...input})).rejects.toThrow('Invalid parser');expect(p.metrics.calls).toBe(0);p.close();
});
it('enforces close and busy semantics across trusted async inspection',async()=>{
 let resolve!:(h:null)=>void;const p=createFlacDescriptorParser({flags:1,discover:()=>[],inspectCompleteHeader:()=>new Promise(r=>resolve=r)}),pending=p.parse({offset:0n,bytes:1});
 await expect(p.parse({offset:0n,bytes:1})).rejects.toThrow('Concurrent');p.close();resolve(null);await expect(pending).rejects.toThrow('closed during header inspection');expect(p.metrics.failed).toBe(true);
});
