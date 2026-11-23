import {it,expect} from 'vitest';import {OutputParentNotFoundError} from '@edge-ffmpeg/core';import {OutputGroupError} from '@edge-ffmpeg/avformat';import type {OutputEffect} from '@edge-ffmpeg/avformat';
it('preserves typed output-open status only when no publication or cleanup uncertainty exists',()=>{
 const original=new Error('missing parent'),cause=new OutputParentNotFoundError('/missing/out',original);expect(cause.exitCode).toBe(254);expect(cause.path).toBe('/missing/out');expect(cause.cause).toBe(original);
 for(const effects of [[],[{path:'/a',status:'aborted'}]] as readonly (readonly OutputEffect[])[])expect(new OutputGroupError('open',effects,cause).exitCode).toBe(254);
 for(const status of ['writing','prepared','published','uncertain','committing','cleanup-failed'] as const)expect(new OutputGroupError('unsafe',[{path:'/a',status}],cause).exitCode).toBe(1);expect(new OutputGroupError('cleanup',[],cause,[new Error('cleanup')]).exitCode).toBe(1);expect(new OutputGroupError('foreign',[],Object.assign(new Error('foreign'),{exitCode:254})).exitCode).toBe(1);
});
