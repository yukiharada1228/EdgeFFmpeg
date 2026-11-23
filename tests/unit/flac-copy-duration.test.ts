import {expect,it,vi} from 'vitest';
import {parseArgv} from '@edge-ffmpeg/cli';
import type {FlacDemuxPacket} from '@edge-ffmpeg/containers';
import {compileFlacCopyDuration,limitFlacCopyDuration} from '../../packages/avformat/src/flac-copy-duration.js';

const signal=()=>new AbortController().signal;
const command=(input:string[]=[],output:string[]=[])=>parseArgv([...input,'-i','/in.flac',...output,'-c:a','copy','/out.flac']);
const packet=(dts:bigint|null,den=8000n):FlacDemuxPacket=>({dts,pts:dts,duration:192n,timeBase:{num:1n,den},range:{kind:'frame',sourceOffset:0n,bytes:0n,parserDuration:192,codecPts:dts,parserFrameOffset:0n,parserRawIndex:0},chunks:{async *[Symbol.asyncIterator](){throw Error('Payload must remain unacquired');}}});
async function collect(packets:FlacDemuxPacket[],duration:bigint|null){const result:FlacDemuxPacket[]=[];for await(const item of limitFlacCopyDuration({async *[Symbol.asyncIterator](){yield* packets;}},duration,signal()))result.push(item);return result;}

it.each([
 [[],[],null],[['-t','0'],[],0n],[[],['-t','0'],0n],
 [['-t','0.03'],['-t','0.02'],20000n],[['-to','0.01'],[],10000n],
 [[],['-to','0.02','-t','0.03'],30000n],[[],['-t','0.03','-to','0.02'],30000n],
 [['-ss','0'],['-ss','0','-t','0.000001'],1n],
] as const)('compiles independent copy recording limits %j %j',(input,output,expected)=>{
 expect(compileFlacCopyDuration(command([...input],[...output]))).toBe(expected);
});

it.each(['-1','garbage','9223372036854.775807'])('rejects invalid or sentinel durations before I/O: %s',value=>{
 expect(()=>compileFlacCopyDuration(command([],['-t',value]))).toThrow();
});
it.each([command(['-ss','0.001']),command([],['-ss','0.001']),command([],['-ss','-1']),command(['-to','0']),command([],['-to','0'])])('rejects unsupported seek or invalid stop',value=>{expect(()=>compileFlacCopyDuration(value)).toThrow();});

it.each([[0n,0],[1n,1],[23999n,1],[24000n,1],[24001n,2],[1000000n,2],[null,2]] as const)('retains whole packets for %s microseconds',async(duration,count)=>{
 const packets=[packet(0n),packet(192n)];expect(await collect(packets,duration)).toEqual(packets.slice(0,count));
});

it('uses Native nearest microsecond DTS rather than an exact rational cutoff',async()=>{
 // 1/44100 seconds rounds to23us: exact-rational comparison would include it.
 const item=packet(1n,44100n);expect(await collect([item],23n)).toEqual([]);expect(await collect([item],24n)).toEqual([item]);
 // 1/128 seconds is exactly7812.5us and rounds away from zero.
 expect(await collect([packet(1n,128n)],7813n)).toEqual([]);
 expect(await collect([packet(-1n,128n)],1n)).toHaveLength(1);
});

it('does not round huge timestamps through Number',async()=>{
 const dts=9007199254740993n;expect(await collect([packet(dts,1000000n)],dts)).toEqual([]);
 expect(await collect([packet(dts,1000000n)],dts+1n)).toHaveLength(1);
});

it('does not acquire upstream at zero duration and closes on cutoff or consumer return',async()=>{
 const acquire=vi.fn(()=>{throw Error('must not acquire');});
 expect(await limitFlacCopyDuration({[Symbol.asyncIterator]:acquire},0n,signal()).next()).toMatchObject({done:true});expect(acquire).not.toHaveBeenCalled();
 for(const action of ['cutoff','return'] as const){let closed=false;const source={async *[Symbol.asyncIterator](){try{yield packet(0n);yield packet(192n);}finally{closed=true;}}};const iterator=limitFlacCopyDuration(source,action==='cutoff'?1n:null,signal());await iterator.next();if(action==='cutoff')expect(await iterator.next()).toMatchObject({done:true});else await iterator.return();expect(closed).toBe(true);}
});

it('rejects ambiguous timing only when a finite duration requires it',async()=>{
 await expect(collect([packet(null)],1n)).rejects.toThrow(/known packet DTS/);
 expect(await collect([packet(null)],null)).toHaveLength(1);
 const unknown={...packet(0n),timeBase:null};await expect(collect([unknown],1n)).rejects.toThrow(/time base/);
});

it('honors abort before acquiring or after a suspended packet',async()=>{
 const controller=new AbortController(),reason=Error('cancel copy');let closed=false;
 const source={async *[Symbol.asyncIterator](){try{yield packet(0n);yield packet(192n);}finally{closed=true;}}};
 const iterator=limitFlacCopyDuration(source,100000n,controller.signal);await iterator.next();controller.abort(reason);await expect(iterator.next()).rejects.toBe(reason);expect(closed).toBe(true);
 await expect(limitFlacCopyDuration(source,0n,controller.signal).next()).rejects.toBe(reason);
});
