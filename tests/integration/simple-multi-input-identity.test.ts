import {it,expect} from 'vitest';import {FFmpeg} from '@edge-ffmpeg/core';import {createMediaBackend} from '@edge-ffmpeg/avformat';import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
it('preserves each accepted input generation when automatic raw inputs share a virtual path',async()=>{
 const root=await mkdtemp(join(tmpdir(),'simple-input-identity-'));try{
  await writeFile(join(root,'input'),new Uint8Array([1,2,3,4,5,6,7,8]));const fs=await createNodeFileSystem({root,maxReadBytes:4096,maxWriteBytes:4096});let opens=0;
  const filesystem={...fs,async openRead(path:string){if(++opens===2)await writeFile(join(root,'input'),new Uint8Array([8,7,6,5,4,3,2,1]));return fs.openRead(path);}};
  const args=['-y',...[0,1].flatMap(()=>['-f','rawvideo','-pixel_format','gray','-video_size','2x2','-framerate','25','-i','/input']),'-c:v','rawvideo','-bitexact','-f','rawvideo','/output'];
  const result=await new FFmpeg({filesystem,backend:createMediaBackend()}).exec(args);
  expect(result.exitCode).toBe(1);expect(result.outputs).toEqual([]);expect(result.diagnostics.at(-1)?.message).toContain('Input changed');expect(await readdir(root)).toEqual(['input']);
 }finally{await rm(root,{recursive:true,force:true});}
});
