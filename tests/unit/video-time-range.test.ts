import {expect,it} from 'vitest';
import {rawVideoTimeRange} from '../../packages/avformat/src/video-time-range.js';
import {timeOptions} from '../../packages/avformat/src/time-range.js';
const rate={num:25n,den:1n},options={frameBytes:6,inputSeekSet:false,copy:false,outputSeekSet:false,maxFrames:null};
it('distinguishes native copy clock thresholds from decoded filter rounding and encoder deadlines',()=>{
 const input=timeOptions(),output={...timeOptions(),seek:20000n},copy=rawVideoTimeRange(17n,rate,input,output,{...options,copy:true,outputSeekSet:true}),encoded=rawVideoTimeRange(17n,rate,input,output,{...options,outputSeekSet:true});expect(copy.start).toBe(1n);expect(copy.ptsForFrame(0n)).toBe(0n);expect(encoded.ptsForFrame(0n)).toBe(1n);
 expect(rawVideoTimeRange(17n,rate,input,{...output,duration:1n},{...options,outputSeekSet:true}).frames).toBe(0n);expect(rawVideoTimeRange(17n,rate,input,{...output,seek:20001n,duration:1n},{...options,outputSeekSet:true}).frames).toBe(1n);
 expect(rawVideoTimeRange(17n,rate,{...input,duration:0n},timeOptions(),options).frames).toBe(17n);expect(rawVideoTimeRange(17n,rate,{...input,duration:0n},timeOptions(),{...options,copy:true}).frames).toBe(0n);
 expect(rawVideoTimeRange(17n,{num:30000n,den:1001n},input,{...timeOptions(),duration:33367n},{...options,copy:true}).frames).toBe(1n);expect(rawVideoTimeRange(17n,{num:30000n,den:1001n},input,{...timeOptions(),duration:33368n},{...options,copy:true}).frames).toBe(2n);
});
it('models EOF input fallback and explicit zero output seek without reading or enumerating prior frames',()=>{
 const input={...timeOptions(),seek:400000n},copy=rawVideoTimeRange(10n,rate,input,timeOptions(),{...options,copy:true});expect(copy.start).toBe(9n);expect(copy.frames).toBe(1n);expect(copy.ptsForFrame(0n)).toBe(-1n);expect(rawVideoTimeRange(10n,rate,input,timeOptions(),options).frames).toBe(0n);expect(rawVideoTimeRange(10n,rate,input,timeOptions(),{...options,copy:true,outputSeekSet:true}).frames).toBe(0n);
 const large=9007199254740993n,range=rawVideoTimeRange(large+17n,{num:1000000n,den:1n},{...timeOptions(),seek:large},timeOptions(),{...options,copy:true,maxFrames:3n});expect(range.start).toBe(large);expect(range.frames).toBe(3n);expect(range.ptsForFrame(2n)).toBe(2n);expect(Object.isFrozen(range)).toBe(true);expect(()=>range.ptsForFrame(3n)).toThrow('outside');
});
it('clips extended precision negative half-frame starts and validates time ranges before execution',()=>{
 const range=rawVideoTimeRange(9n,{num:1n,den:100n},timeOptions(),{...timeOptions(),seek:49999998n},{...options,outputSeekSet:true});expect(range.start).toBe(0n);expect(range.ptsForFrame(0n)).toBe(0n);expect(range.ptsForFrame(1n)).toBe(1n);
 expect(()=>rawVideoTimeRange(9n,rate,timeOptions(),{...timeOptions(),seek:20000n,stop:20000n},options)).toThrow('-to');expect(()=>rawVideoTimeRange(9n,rate,timeOptions(),{...timeOptions(),duration:-1n},options)).toThrow('Negative');expect(()=>rawVideoTimeRange(9n,rate,timeOptions(),timeOptions(),{...options,maxFrames:-1n})).toThrow('range');
});
