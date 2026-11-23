import { expect, it } from 'vitest';
import { parseTimeDuration } from '@edge-ffmpeg/cli';
it('parses decimal, clock and unit durations without floating point', () => {
  for (const [value, expected] of [['0.2',200000n],['200ms',200000n],['200000us',200000n],['12:03:45',43425000000n],['1:2.5',62500000n],['0:1ms',1000n],['0.0000009',0n],['1.5us',1n],['1.',1000000n],['+0.1',100000n],['-0.1',-100000n],['9007199254.740993',9007199254740993n]] as const) expect(parseTimeDuration(value)).toBe(expected);
});
it('rejects invalid clock syntax and oversized duration values', () => {
  for (const value of ['.5','1e-3','0.1 ','00:99','99:00','0:60:00','+0:00:00.1','1x','', '9'.repeat(129),'9223372036854775808us']) expect(()=>parseTimeDuration(value)).toThrow();
});

import { parseFrameLimit } from '@edge-ffmpeg/cli';
it('parses output frame limits with bigint and native negative-as-unlimited semantics',()=>{
  expect(parseFrameLimit('0')).toBe(0n);expect(parseFrameLimit('+2')).toBe(2n);expect(parseFrameLimit('9007199254740993')).toBe(9007199254740993n);expect(parseFrameLimit('9223372036854775807')).toBe(9223372036854775807n);
  expect(parseFrameLimit('-1')).toBeNull();expect(parseFrameLimit('-9223372036854775808')).toBeNull();
  for(const value of ['','1.5','1e3','NaN',' 1','1 ','9223372036854775808','-9223372036854775809','0'.repeat(129)])expect(()=>parseFrameLimit(value)).toThrow();
});
