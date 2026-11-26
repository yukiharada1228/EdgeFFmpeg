import {expect,it,vi} from 'vitest';
import {videoJoinPlan,videoJoinFrameRate,videoJoinEvent,videoOperator,planTimedVideoGraph} from '@edge-ffmpeg/avfilter';
import type {VideoOperatorDescriptor,VideoJoinStep,VideoJoinExtension} from '@edge-ffmpeg/avfilter';
import {defineVideoOperator} from '../../packages/avfilter/src/video-ops/descriptor.js';
import {validateVideoOperator} from '../../packages/avfilter/src/video-ops/registry.js';
import {videoGraphClocks} from '../../packages/avformat/src/video-output/graph-clock.js';
// Base-rate joins through the test-only stand-ins of tests/helpers/video-join-stand-ins.ts.
vi.mock('../../packages/avfilter/src/video-ops/registry.js',async importOriginal=>(await import('../helpers/video-join-stand-ins.js')).withJoinStandIns(await importOriginal()));
const frame={width:1,height:1,pixelFormat:'gray',planes:[Uint8Array.of(7)],linesizes:[1],pts:{value:3n,timeBase:{num:1n,den:50n}},metadata:{}};
const join=(rule?:VideoOperatorDescriptor['join'])=>defineVideoOperator<VideoJoinStep>({name:'probejoin',role:'join',paths:['graph','stream','actor','timed'],examples:['split,probejoin'],...(rule?{join:rule}:{}),parse:()=>({inputs:2,outputs:1,configuration:{name:'probejoin',shortest:false}}),geometry:(_step,inputs)=>inputs[0]!,combine:frames=>frames[0]!});
it('resolves the vf_stack rule when a join declares none and follows step.shortest on every pad',()=>{
 expect(videoJoinPlan(join(),{name:'probejoin',shortest:false} as VideoJoinStep,3)).toEqual({rate:'common',props:'none',shortest:false});
 expect(videoJoinPlan(join(),{name:'probejoin',shortest:true} as VideoJoinStep,3)).toEqual({rate:'common',props:'none',shortest:true});
 for(const name of ['hstack','vstack']){const op=videoOperator(name)!;expect(op.join).toEqual({rate:'common'});expect(videoJoinPlan(op,{name,shortest:true} as VideoJoinStep,2)).toEqual({rate:'common',props:'none',shortest:true});}
});
it('resolves declared base rates and uniform after modes, and refuses mixed or invalid rules before output',()=>{
 const stop=(_step:unknown,inputs:number)=>Array.from({length:inputs},():VideoJoinExtension=>'stop');
 expect(videoJoinPlan(join({rate:'base'}),{name:'probejoin',shortest:false} as VideoJoinStep,2)).toEqual({rate:'base',props:'none',shortest:false});
 expect(videoJoinPlan(join({rate:'base',props:'base'}),{name:'probejoin',shortest:true} as VideoJoinStep,2)).toEqual({rate:'base',props:'base',shortest:true});
 expect(videoJoinPlan(join({rate:'base',after:stop}),{name:'probejoin',shortest:false} as VideoJoinStep,4)).toEqual({rate:'base',props:'none',shortest:true});
 expect(()=>videoJoinPlan(join({rate:'common',props:'base'}),{name:'probejoin',shortest:false} as VideoJoinStep,2)).toThrow('Invalid join rule');
 expect(()=>videoJoinPlan(join({rate:'base',props:'first' as 'base'}),{name:'probejoin',shortest:false} as VideoJoinStep,2)).toThrow('Invalid join rule');
 // vf_mix duration=first: input 0 EXT_STOP, every other input EXT_INFINITY.
 expect(()=>videoJoinPlan(join({rate:'base',after:(_step,inputs)=>Array.from({length:inputs},(_,pad):VideoJoinExtension=>pad?'infinity':'stop')}),{name:'probejoin',shortest:false} as VideoJoinStep,3)).toThrow('probejoin mixes EXT_STOP and EXT_INFINITY across its inputs, which is not implemented');
 expect(()=>videoJoinPlan(join({rate:'base',after:()=>['stop']}),{name:'probejoin',shortest:false} as VideoJoinStep,2)).toThrow('Invalid join rule for video filter probejoin');
 expect(()=>videoJoinPlan(join({rate:'base',after:()=>['stop','null' as VideoJoinExtension]}),{name:'probejoin',shortest:false} as VideoJoinStep,2)).toThrow('Invalid join rule');
 expect(()=>videoJoinPlan(join({rate:'first' as 'base'}),{name:'probejoin',shortest:false} as VideoJoinStep,2)).toThrow('Invalid join rule');
 expect(()=>videoJoinPlan(videoOperator('hflip')!,{name:'hflip'},1)).toThrow('Video filter hflip is not a join');
 expect(()=>videoJoinPlan(join(),{name:'probejoin',shortest:false} as VideoJoinStep,0)).toThrow('Invalid join input count');
});
it('takes base rates from input 0 and compares raw common rate fields',()=>{
 const rates=[{num:10n,den:1n},{num:25n,den:1n}];
 expect(videoJoinFrameRate('base',rates)).toEqual({num:10n,den:1n});expect(videoJoinFrameRate('base',[...rates].reverse())).toEqual({num:25n,den:1n});
 expect(videoJoinFrameRate('base',[{num:1n,den:0n},{num:25n,den:1n}])).toEqual({num:1n,den:0n});
 expect(videoJoinFrameRate('common',rates)).toEqual({num:1n,den:0n});
 expect(videoJoinFrameRate('common',[{num:50n,den:2n},{num:50n,den:2n}])).toEqual({num:50n,den:2n});
 expect(videoJoinFrameRate('common',[{num:25n,den:1n},{num:50n,den:2n}])).toEqual({num:1n,den:0n});
 expect(()=>videoJoinFrameRate('base',[])).toThrow('Join requires inputs');
});
it('keeps the base event duration value and interlacing under props base, and gives other outputs no duration',()=>{
 const base={kind:'frame' as const,frame,duration:2n,interlaced:true};
 expect(videoJoinEvent('base',base,frame)).toEqual({kind:'frame',frame,duration:2n,interlaced:true});
 expect(videoJoinEvent('base',{kind:'frame',frame,duration:1n},frame)).toEqual({kind:'frame',frame,duration:1n});
 expect(videoJoinEvent('none',base,frame)).toEqual({kind:'frame',frame,duration:0n});
});
it('validates join rules in the registry',()=>{
 expect(()=>validateVideoOperator(join({rate:'base'}))).not.toThrow();
 expect(()=>validateVideoOperator(join({rate:'vfr' as 'base'}))).toThrow('Invalid video operator descriptor probejoin: join rule needs role join');
 expect(()=>validateVideoOperator(join({rate:'base',after:'stop' as never}))).toThrow('join rule needs role join');
 expect(()=>validateVideoOperator(join({rate:'common',props:'base'}))).toThrow('props none or base (base only with rate base)');
 expect(()=>validateVideoOperator(join({rate:'base',props:'all' as 'base'}))).toThrow('join rule needs role join');
 expect(()=>validateVideoOperator(join({rate:'base',props:'base'}))).not.toThrow();
 const frameOp=defineVideoOperator({name:'probeframe',role:'frame',paths:['graph'],examples:['probeframe'],join:{rate:'base'},parse:()=>({inputs:1,outputs:1,configuration:{name:'probeframe'}}),frame:value=>value});
 expect(()=>validateVideoOperator(frameOp)).toThrow('Invalid video operator descriptor probeframe: join rule needs role join');
});
it('keeps the vf_stack clocks of hstack and vstack on the stream and timed planners',()=>{
 const source=(num:bigint,den=1n)=>({frameRate:{num,den},timeBase:{num:den,den:num}}),gray={format:'gray',width:2,height:2};
 expect(videoGraphClocks('[a][b]hstack[o]',[source(10n),source(25n)]).outputs[0]).toEqual({frameRate:{num:1n,den:0n},timeBase:{num:1n,den:50n},durationSource:null});
 expect(videoGraphClocks('[a][b]vstack[o]',[source(30000n,1001n),source(30000n,1001n)]).outputs[0]).toEqual({frameRate:{num:30000n,den:1001n},timeBase:{num:1001n,den:30000n},durationSource:null});
 const timed=planTimedVideoGraph('[a][b]hstack[o]',[{geometry:gray,...source(25n)},{geometry:gray,...source(10n)}],[null]);
 expect(timed.sinks[0]).toMatchObject({frameRate:{num:1n,den:0n},timeBase:{num:1n,den:50n}});expect(timed.clocks.at(-1)).toMatchObject({durationSource:null,demuxSource:null});
});
it('takes the base-rate clock of input 0 on the stream and timed planners, with its duration and decoder time base only under props base',()=>{
 const source=(num:bigint,den=1n)=>({frameRate:{num,den},timeBase:{num:den,den:num}}),gray={format:'gray',width:2,height:2};
 expect(videoGraphClocks('[a][b][c]nmaskedmerge[o]',[source(10n),source(25n),source(25n)]).outputs[0]).toEqual({frameRate:{num:10n,den:1n},timeBase:{num:1n,den:50n},durationSource:0});
 expect(videoGraphClocks('[a][b]nmix[o]',[source(30000n,1001n),source(25n)]).outputs[0]).toEqual({frameRate:{num:30000n,den:1001n},timeBase:{num:1n,den:30000n},durationSource:null});
 const sources=[{geometry:gray,...source(25n)},{geometry:gray,...source(10n)}];
 const based=planTimedVideoGraph('[a][b]nmix[o]',[...sources].reverse(),[null]);
 expect(based.sinks[0]).toMatchObject({frameRate:{num:10n,den:1n},timeBase:{num:1n,den:50n}});expect(based.clocks.at(-1)).toMatchObject({durationSource:null,demuxSource:null});
 const copied=planTimedVideoGraph('[a][b][c][d]nthreshold[o]',[...sources,...sources],[null]);
 expect(copied.sinks[0]).toMatchObject({frameRate:{num:25n,den:1n},timeBase:{num:1n,den:50n}});expect(copied.clocks.at(-1)).toMatchObject({durationSource:0});
 expect(()=>planTimedVideoGraph('[a][b]nmixfirst[o]',sources,[null])).toThrow('nmixfirst mixes EXT_STOP and EXT_INFINITY across its inputs');
 expect(()=>videoGraphClocks('[a][b]nmixfirst[o]',[source(25n),source(10n)])).toThrow('nmixfirst mixes EXT_STOP and EXT_INFINITY across its inputs');
});
