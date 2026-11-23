import {it,expect} from 'vitest';import {ExecutionError} from '@edge-ffmpeg/core';import {ComplexVideoFailure} from '@edge-ffmpeg/avformat';
it('retains explicit backend failure status when cleanup succeeds and reports cleanup failure as generic',()=>{
 const cause=new ExecutionError('invalid-arguments','conflict',{exitCode:234}),clean=new ComplexVideoFailure(cause,[],[]),failed=new ComplexVideoFailure(cause,[],[new Error('cleanup')]);expect(clean.exitCode).toBe(234);expect(clean.cause).toBe(cause);expect(clean.publishedOutputs).toEqual([]);expect(failed.exitCode).toBe(1);expect(new ComplexVideoFailure(Object.assign(new Error('foreign'),{exitCode:234}),[],[]).exitCode).toBe(1);
});
