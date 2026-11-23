import {it,expect} from 'vitest';import {FFmpeg,ExecutionExit} from '@edge-ffmpeg/core';import type {VirtualFileSystem} from '@edge-ffmpeg/core';
const filesystem:VirtualFileSystem={async openRead(){throw Error('Unexpected read');},async openWrite(){throw Error('Unexpected write');}};
it('represents graceful non-publication with a diagnostic without treating foreign errors as graceful',async()=>{
 const result=await new FFmpeg({filesystem,backend:{async execute(){throw new ExecutionExit('output-exists','Existing output');}}}).exec(['-i','/input','/output']);expect(result).toEqual({exitCode:0,outputs:[],diagnostics:[{code:'output-exists',message:'Existing output'}]});expect(Object.isFrozen(result)).toBe(true);
 const foreign=await new FFmpeg({filesystem,backend:{async execute(){throw Object.assign(new Error('Foreign'),{exitCode:0});}}}).exec(['-i','/input','/output']);expect(foreign.exitCode).toBe(1);
});
it('gives cancellation priority over graceful termination',async()=>{
 const controller=new AbortController(),result=await new FFmpeg({filesystem,backend:{async execute(){controller.abort();throw new ExecutionExit('output-exists','Existing output');}}}).exec(['-i','/input','/output'],{signal:controller.signal});expect(result.exitCode).toBe(1);expect(result.diagnostics[0]!.code).toBe('cancelled');
});
