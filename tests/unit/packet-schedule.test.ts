import {expect,it} from 'vitest';
import {schedulePacketSections,resamplePacketSchedule,slicePacketSchedule,appendPacketSection} from '../../packages/avformat/src/packet-schedule.js';
it('queries and clips large rational packet schedules without enumerating prior frames',()=>{
  const count=9007199254740993n,source=schedulePacketSections([{samples:count*512n,span:512n}]),converted=resamplePacketSchedule(source,8000,16001);
  expect(converted.packetCount).toBe(count+1n);const before=converted.samplesForPackets(count-1n);expect(before).toBe((((count-1n)*512n-16n)*16001n+7999n)/8000n);
  const clipped=slicePacketSchedule(converted,before+1n,1000n);expect(clipped.sampleCount).toBe(1000n);expect(clipped.packetCount).toBe(1n);expect(clipped.samplesForPackets(1n)).toBe(1000n);expect(converted.samplesForPackets(1n<<63n)).toBe(converted.sampleCount);expect(Object.isFrozen(converted)).toBe(true);
  const appended=appendPacketSection(clipped,13n,7n);expect(appended.packetCount).toBe(3n);expect(appended.samplesForPackets(2n)).toBe(1007n);expect(slicePacketSchedule(appended,1001n,10n).samplesForPackets(1n)).toBe(6n);
});
it('handles zero-output input packets startup overflow and malformed schedule parameters',()=>{
  const source=schedulePacketSections([{samples:65n,span:1n}]),converted=resamplePacketSchedule(source,1,8000);expect(converted.samplesForPackets(1n)).toBe(16064n);expect(converted.samplesForPackets(2n)).toBe(20160n);
  expect(resamplePacketSchedule(schedulePacketSections([{samples:21n,span:7n}]),8000,16000).packetCount).toBe(0n);expect(slicePacketSchedule(source,100n,1n).sampleCount).toBe(0n);expect(()=>source.samplesForPackets(-1n)).toThrow('limit');expect(()=>slicePacketSchedule(source,-1n,1n)).toThrow('selection');expect(()=>resamplePacketSchedule(converted,8000,16000)).toThrow('Repeated');expect(()=>appendPacketSection(source,-1n,1n)).toThrow('section');
});
