import {expect,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createWavBackend} from '@edge-ffmpeg/avformat';

for(const duration of [[],['-t','0']])for(const filter of ['aformat=sample_rates=16000','aformat=channel_layouts=mono'])it(`rejects PCM constraint mismatch before output opening: ${filter}/${duration.join(' ')}`,async()=>{
 const input=new Uint8Array([1,0,2,0,3,0,4,0]);let opens=0;
 const ffmpeg=new FFmpeg({backend:createWavBackend(),filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+length);}};},async openWrite(){opens++;throw Error('Constraint preflight must precede output opening');}}});
 const result=await ffmpeg.exec(['-f','s16le','-ar','8000','-ac','2','-i','/in.raw',...duration,'-af',filter,'-c:a','pcm_s16le','-f','s16le','/out']);
 expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.message).toMatch(/constraint|rate|layout/i);expect(opens).toBe(0);expect(result.outputs).toEqual([]);
});
it('preserves PCM bytes through matching identity constraints',async()=>{
 const input=new Uint8Array([1,0,2,0,3,0,4,0]),chunks:Uint8Array[]=[];let commits=0;
 const ffmpeg=new FFmpeg({backend:createWavBackend(),filesystem:{async openRead(){return {size:BigInt(input.length),async readAt(offset,length){return input.subarray(Number(offset),Number(offset)+length);}};},async openWrite(){return {async write(bytes){chunks.push(bytes.slice());},async commit(){commits++;},async abort(){chunks.length=0;}};}}});
 const result=await ffmpeg.exec(['-f','s16le','-ar','8000','-ac','2','-i','/in.raw','-af','aformat=r=8000:cl=stereo','-c:a','pcm_s16le','-f','s16le','/out']);
 expect(result.exitCode).toBe(0);expect(result.diagnostics).toEqual([]);expect(Buffer.concat(chunks)).toEqual(Buffer.from(input));expect(commits).toBe(1);
});
