import {it,expect} from 'vitest';import {parseVideoOutputOptions} from '../../packages/avformat/src/video-output/output-options.js';
const option=(name:string,value:string)=>({name,value});
it('selects CFR for maximum-rate output independently of muxer defaults',()=>{
 const parsed=parseVideoOutputOptions([option('-fpsmax:v:0','ntsc')],'framecrc');expect(parsed.mode).toBe('cfr');expect(parsed.outputMaxFrameRate).toEqual({num:30000n,den:1001n});expect(parsed.outputFrameRate).toBeUndefined();
});
it('retains the final maximum-rate assignment and unrelated file options',()=>{
 const parsed=parseVideoOutputOptions([option('-map','[o]'),option('-fpsmax','60'),option('-fpsmax:v','20')],'rawvideo');expect(parsed.outputMaxFrameRate).toEqual({num:20n,den:1n});expect(parsed.remaining).toEqual([option('-map','[o]')]);
});
it('rejects rate, mode and stream-selector contradictions before I/O',()=>{
 expect(()=>parseVideoOutputOptions([option('-r','25'),option('-fpsmax','30')],'rawvideo')).toThrow(/combine/);
 for(const mode of ['vfr','passthrough'])expect(()=>parseVideoOutputOptions([option('-fpsmax','30'),option('-fps_mode',mode)],'framecrc')).toThrow(/contradicts/);
 expect(()=>parseVideoOutputOptions([option('-fpsmax:v:08','30')],'framecrc')).toThrow(/stream/);expect(()=>parseVideoOutputOptions([option('-fpsmax','0')],'framecrc')).toThrow();
});

it('ignores a nonmatching maximum-rate string without parsing its value',()=>{const result=parseVideoOutputOptions([option('-fpsmax:a','bad')],'framecrc');expect(result.mode).toBe('vfr');expect(result.outputMaxFrameRate).toBeUndefined();expect(result.remaining).toEqual([]);});
