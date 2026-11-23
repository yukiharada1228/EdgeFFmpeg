import {it,expect} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import type {TimedVideoBackendOptions} from '@edge-ffmpeg/avformat';
it('validates backend limits and requires explicit numeric semantics',()=>{
 const base:TimedVideoBackendOptions={storage:()=>{throw new Error('No storage expected');},limits:{numericProfile:'darwin-arm64',maxEvents:8}};
 for(const maxEvents of [0,-1,NaN,Infinity,1.5])expect(()=>createTimedVideoBackend({...base,limits:{...base.limits,maxEvents}})).toThrow('options');
 for(const numericProfile of [undefined,'unknown'])expect(()=>createTimedVideoBackend({...base,limits:{...base.limits,numericProfile}} as unknown as TimedVideoBackendOptions)).toThrow('numericProfile');
 expect(()=>createTimedVideoBackend({...base,limits:{...base.limits,scheduler:'unknown'}} as unknown as TimedVideoBackendOptions)).toThrow('scheduler');
 expect(()=>createTimedVideoBackend({...base,storage:null} as unknown as TimedVideoBackendOptions)).toThrow('options');
 expect(Object.isFrozen(createTimedVideoBackend(base))).toBe(true);
});
it('snapshots the accepted storage factory and scheduler before execution',async()=>{
 const failure=new Error('accepted storage'),options:TimedVideoBackendOptions={storage:()=>{throw failure;},limits:{numericProfile:'darwin-arm64',maxEvents:8,scheduler:'producer'}},backend=createTimedVideoBackend(options);
 options.storage=()=>{throw new Error('mutated storage');};options.limits.scheduler='invalid' as never;options.limits.maxEvents=0;
 const ffmpeg=new FFmpeg({filesystem:{async openRead(){return {size:6n,async readAt(){return new Uint8Array(6);}};},async openWrite(){throw new Error('Unexpected write');}},backend,budget:{maxResidentBytes:32*1024*1024,maxBufferBytes:4096,maxCpuTimeMs:1000,maxPendingPackets:32}});
 const result=await ffmpeg.exec(['-y','-f','rawvideo','-pixel_format','gray','-video_size','3x2','-i','/input','-filter_complex','[0:v]crop=2:2[x]','-map','[x]','-f','framecrc','/output']);expect(result.exitCode).toBe(1);expect(result.error).toBe(failure);expect(result.outputs).toEqual([]);
});
it('rejects invalid graphs and observes pre-start cancellation before I/O',async()=>{
 let opens=0;const ffmpeg=new FFmpeg({filesystem:{async openRead(){opens++;throw new Error('Unexpected read');},async openWrite(){opens++;throw new Error('Unexpected write');}},backend:createTimedVideoBackend({storage:()=>{throw new Error('Unexpected store');},limits:{numericProfile:'darwin-arm64',maxEvents:8}}),budget:{maxResidentBytes:32*1024*1024,maxBufferBytes:4096,maxCpuTimeMs:1000,maxPendingPackets:32}});
 for(const graph of ['[0:v]crop=0:2[x]','[0:v]unknown[x]']){const result=await ffmpeg.exec(['-y','-f','rawvideo','-pixel_format','gray','-video_size','3x2','-i','/input','-filter_complex',graph,'-map','[x]','-f','framecrc','/output']);expect(result.exitCode).toBe(1);expect(result.outputs).toEqual([]);}
 const controller=new AbortController(),reason=new Error('cancelled');controller.abort(reason);const result=await ffmpeg.exec(['-i','/input','/output'],{signal:controller.signal});expect(result.diagnostics[0]?.code).toBe('cancelled');expect(result.error).toBe(reason);expect(opens).toBe(0);
});
