import {it,expect} from 'vitest';
import {videoPacketDuration} from '../../packages/avformat/src/video-output/packet-duration.js';
it('preserves explicit packet duration and infers unknown durations from the stream average rate',()=>{
 expect(videoPacketDuration(5n,{num:25n,den:1n},{num:1n,den:150n})).toBe(5n);
 expect(videoPacketDuration(0n,{num:25n,den:1n},{num:1n,den:150n})).toBe(6n);
 expect(videoPacketDuration(-3n,{num:25n,den:1n},{num:1n,den:150n})).toBe(6n);
});
it('uses the strict one-millisecond threshold only when average frame rate is unknown',()=>{
 const unknown={num:0n,den:0n};
 expect(videoPacketDuration(0n,unknown,{num:1n,den:999n})).toBe(1n);
 expect(videoPacketDuration(0n,unknown,{num:1n,den:1000n})).toBe(0n);
 expect(videoPacketDuration(0n,unknown,{num:1n,den:1001n})).toBe(0n);
});
