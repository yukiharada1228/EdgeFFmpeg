import {expect,it} from 'vitest';
import {clipPacketSections,packetSectionSamplesForFrames} from '../../packages/avformat/src/packet-sections.js';
it('clips semantic packet sections with partial first packets and bigint offsets without enumeration',()=>{
  const sections=[{samples:13n,span:5n},{samples:20n,span:7n}];expect(clipPacketSections(sections,1n,20n)).toEqual([{samples:12n,span:5n,firstPacketSamples:4n},{samples:8n,span:7n,firstPacketSamples:7n}]);expect(clipPacketSections(sections,14n,10n)).toEqual([{samples:10n,span:7n,firstPacketSamples:6n}]);expect(clipPacketSections(sections,100n,10n)).toEqual([]);expect(clipPacketSections(sections,0n,0n)).toEqual([]);
  const large=9007199254740993n;expect(clipPacketSections([{samples:large+20n,span:7n}],large,10n)).toEqual([{samples:10n,span:7n,firstPacketSamples:7n-large%7n}]);expect(Object.isFrozen(clipPacketSections(sections,1n,2n))).toBe(true);
});
it('validates finite selection and existing partial-packet metadata',()=>{
  expect(()=>clipPacketSections([{samples:3n,span:2n,firstPacketSamples:3n}],0n,1n)).toThrow('section');expect(()=>clipPacketSections([], -1n,1n)).toThrow('selection');expect(()=>clipPacketSections(Array(1),0n,1n)).toThrow('section');
  expect(clipPacketSections([{samples:10n,span:5n,firstPacketSamples:2n}],3n,4n)).toEqual([{samples:4n,span:5n,firstPacketSamples:4n}]);
});

it('counts limited packets across partial heads and section tails with bigint frame limits',()=>{
  const sections=[{samples:13n,span:5n,firstPacketSamples:4n},{samples:20n,span:7n}];expect([0n,1n,2n,3n,4n,5n,6n].map(limit=>packetSectionSamplesForFrames(sections,limit))).toEqual([0n,4n,9n,13n,20n,27n,33n]);expect(packetSectionSamplesForFrames(sections,9223372036854775807n)).toBe(33n);
  const large=9007199254740993n;expect(packetSectionSamplesForFrames([{samples:large*7n,span:7n}],large-1n)).toBe((large-1n)*7n);expect(()=>packetSectionSamplesForFrames(sections,-1n)).toThrow('limit');expect(()=>packetSectionSamplesForFrames([{samples:0n,span:1n}],1n)).toThrow('section');
});
