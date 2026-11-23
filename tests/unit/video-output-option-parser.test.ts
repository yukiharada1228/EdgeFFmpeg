import {it,expect} from 'vitest';import {parseVideoOutputOptions} from '../../packages/avformat/src/video-output/output-options.js';
const option=(name:string,value:string)=>({name,value});
it('selects automatic synchronization by output muxer and explicit rate',()=>{
 expect(parseVideoOutputOptions([],'rawvideo').mode).toBe('cfr');expect(parseVideoOutputOptions([],'framecrc').mode).toBe('vfr');
 expect(parseVideoOutputOptions([option('-r:v:0','ntsc')],'framecrc')).toMatchObject({mode:'cfr',outputFrameRate:{num:30000n,den:1001n}});
});
it('keeps unrelated output options and applies the last matching option',()=>{
 const result=parseVideoOutputOptions([option('-map','[o]'),option('-r','25'),option('-r:v','30'),option('-fps_mode','CFR'),option('-enc_time_base','filter'),option('-enc_time_base:v','2:100')],'framecrc');expect(result).toMatchObject({mode:'cfr',outputFrameRate:{num:30n,den:1n},encoderTimeBase:{num:1n,den:50n},remaining:[option('-map','[o]')]});
});
it('supports filter/demux keywords and zero resets to the default encoder clock',()=>{
 expect(parseVideoOutputOptions([option('-enc_time_base','demux')],'rawvideo').encoderTimeBase).toBe('demux');expect(parseVideoOutputOptions([option('-enc_time_base','filter'),option('-enc_time_base','0/25')],'rawvideo').encoderTimeBase).toBeUndefined();
});
it('rejects non-CFR rate conflicts and invalid options before source execution',()=>{
 for(const mode of ['vfr','passthrough'])expect(()=>parseVideoOutputOptions([option('-r','25'),option('-fps_mode',mode)],'framecrc')).toThrow(/contradicts/);
 for(const item of [option('-fps_mode','vscfr'),option('-enc_time_base','1/0'),option('-enc_time_base','-1')])expect(()=>parseVideoOutputOptions([item],'rawvideo')).toThrow();
});

it('uses native-bounded floating ratio conversion for decimal encoder clocks',()=>{
 expect(parseVideoOutputOptions([option('-enc_time_base','4e-2')],'framecrc').encoderTimeBase).toEqual({num:1n,den:25n});
 expect(parseVideoOutputOptions([option('-enc_time_base','1e-300')],'framecrc').encoderTimeBase).toBeUndefined();
});

it('ignores nonmatching string values before parsing them',()=>{
 const result=parseVideoOutputOptions([option('-r:a','bad'),option('-fpsmax:v:1','bad'),option('-enc_time_base:a','bad'),option('-fps_mode:s','bad'),option('-map','[o]')],'framecrc');expect(result).toEqual({mode:'vfr',remaining:[option('-map','[o]')]});
});
it('parses only the last applicable string in each option family',()=>{
 const result=parseVideoOutputOptions([option('-r','bad'),option('-r:v','30'),option('-fps_mode','bad'),option('-fps_mode','cfr'),option('-enc_time_base','bad'),option('-enc_time_base','filter')],'framecrc');expect(result).toMatchObject({mode:'cfr',outputFrameRate:{num:30n,den:1n},encoderTimeBase:'filter'});
});
it('still validates numeric frame counts when unused or overwritten',()=>{
 expect(()=>parseVideoOutputOptions([option('-frames:a','bad')],'framecrc')).toThrow();expect(()=>parseVideoOutputOptions([option('-frames:v','bad'),option('-frames:v','2')],'framecrc')).toThrow();expect(parseVideoOutputOptions([option('-frames:a','2')],'framecrc').remaining).toEqual([]);
});
