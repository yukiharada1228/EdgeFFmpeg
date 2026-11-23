import {expect,it} from 'vitest';
import {FFmpeg,ExecutionError} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
const filesystem:VirtualFileSystem={async openRead(){throw Error('Unexpected read');},async openWrite(){throw Error('Unexpected write');}};
it('preserves explicit failure statuses and keeps ordinary errors generic',async()=>{
 for(const [error,wanted]of [[new ExecutionError('invalid-arguments','sample rate not set',{exitCode:234}),234],[new ExecutionError('invalid-arguments','default'),1],[Object.assign(new Error('foreign error'),{exitCode:234}),1]] as const){
  const frontend=new FFmpeg({filesystem,backend:{async execute(){throw error;}}}),result=await frontend.exec(['-i','/input','/output']);
  expect(result.exitCode).toBe(wanted);expect(result.error).toBe(error);expect(result.outputs).toEqual([]);
 }
});
it('keeps cancellation distinct from a backend supplied exit status',async()=>{
 const controller=new AbortController(),frontend=new FFmpeg({filesystem,backend:{async execute(){controller.abort(new Error('cancelled'));throw new ExecutionError('invalid-arguments','late backend status',{exitCode:234});}}});
 const result=await frontend.exec(['-i','/input','/output'],{signal:controller.signal});
 expect(result.exitCode).toBe(1);expect(result.diagnostics[0]!.code).toBe('cancelled');
});
it('rejects success fractional and out of range failure statuses',()=>{
 for(const exitCode of [0,-1,1.5,256,Infinity,NaN])expect(()=>new ExecutionError('test','invalid',{exitCode})).toThrow(RangeError);
 expect(new ExecutionError('test','upper boundary',{exitCode:255}).exitCode).toBe(255);
});
