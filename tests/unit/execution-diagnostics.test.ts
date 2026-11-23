import {expect,it} from 'vitest';
import {FFmpeg,ExecutionError,ExecutionExit} from '@edge-ffmpeg/core';
import type {ExecutionDiagnostic,VirtualFileSystem} from '@edge-ffmpeg/core';
const filesystem:VirtualFileSystem={async openRead(){throw Error('Unexpected read');},async openWrite(){throw Error('Unexpected write');}};
const argv=['-i','/input','/output'];
it('retains immutable nonfatal diagnostics alongside successful published outputs',async()=>{
 let late:((diagnostic:ExecutionDiagnostic)=>void)|undefined;
 const message={code:'demux-read-error',message:'Is a directory'};
 const result=await new FFmpeg({filesystem,backend:{async execute(_command,context){late=context.reportDiagnostic;context.reportDiagnostic?.(message);message.message='mutated';return ['/output'];}}}).exec(argv);
 expect(result).toEqual({exitCode:0,outputs:['/output'],diagnostics:[{code:'demux-read-error',message:'Is a directory'}]});
 expect(Object.isFrozen(result.diagnostics)).toBe(true);expect(Object.isFrozen(result.diagnostics[0])).toBe(true);
 expect(()=>late?.({code:'late',message:'late'})).not.toThrow();expect(result.diagnostics).toHaveLength(1);
});
it('preserves preceding diagnostics and terminal semantics for failure refusal and cancellation',async()=>{
 for(const kind of ['failure','refusal','cancel'] as const){
  const controller=new AbortController();
  const result=await new FFmpeg({filesystem,backend:{async execute(_command,context){context.reportDiagnostic?.({code:'prior',message:'Earlier read diagnostic'});if(kind==='cancel')controller.abort();if(kind==='refusal')throw new ExecutionExit('output-exists','Existing output');throw new ExecutionError('demux-read-error','Is a directory',{exitCode:235});}}}).exec(argv,{signal:controller.signal});
  expect(result.exitCode).toBe(kind==='failure'?235:kind==='refusal'?0:1);expect(result.outputs).toEqual([]);
  expect(result.diagnostics.map(item=>item.code)).toEqual(['prior',kind==='failure'?'demux-read-error':kind==='refusal'?'output-exists':'cancelled']);
 }
});
it('bounds retained diagnostics without changing a successful execution status',async()=>{
 const result=await new FFmpeg({filesystem,budget:{maxResidentBytes:1024,maxBufferBytes:256,maxCpuTimeMs:1000,maxPendingPackets:8},backend:{async execute(_command,context){for(let i=0;i<1000;i++)context.reportDiagnostic?.({code:'read-error',message:'Message'});return ['/output'];}}}).exec(argv);
 expect(result.exitCode).toBe(0);expect(result.outputs).toEqual(['/output']);expect(result.diagnostics.map(item=>item.code)).toEqual(['read-error','diagnostics-truncated']);
});
