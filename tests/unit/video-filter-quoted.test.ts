import {expect,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
it('decodes separate graph and option quoting layers including native unclosed quotes',()=>{
 for(const text of ["format='rgba|gray'",String.raw`format=\'rgba|gray\'`,String.raw`format=rgba\|gray`])expect(compileVideoFilterChain(text).steps[0]).toMatchObject({name:'format',pixelFormats:['rgba','gray']});
 expect(compileVideoFilterChain("format=''").steps[0]).toMatchObject({pixelFormats:null});expect(compileVideoFilterChain("format=' '").steps[0]).toMatchObject({pixelFormats:['yuv420p']});expect(compileVideoFilterChain("scale=''").steps[0]).toMatchObject({width:null,height:null});expect(()=>compileVideoFilterChain("scale=' '")).toThrow();
 expect(compileVideoFilterChain("'null").steps).toEqual([{name:'null'}]);expect(compileVideoFilterChain("format='rgba").steps[0]).toMatchObject({pixelFormats:['rgba']});
 for(const text of [String.raw`format=pix_fmts=\' 0 \'`,String.raw`format=pix_fmts=\' gray \'`,'format="rgba"'])expect(()=>compileVideoFilterChain(text)).toThrow();
});
it('applies final string options before validating scale dimensions and default flags',()=>{
 expect(compileVideoFilterChain('format=bogus:pix_fmts=rgba').steps[0]).toMatchObject({pixelFormats:['rgba']});
 expect(compileVideoFilterChain('scale=w=bogus:h=7:w=13:flags=bogus:flags=bicubic').plan('rgba',5,3)).toMatchObject({width:13,height:7});
 expect(compileVideoFilterChain('scale=h=7').plan('rgba',5,3)).toMatchObject({width:5,height:7});expect(compileVideoFilterChain("scale='13,7'").steps).toEqual([{name:'scale',width:13,height:7}]);
 for(const text of ['scale=w=13:7','scale=13:7:flags=bicubic:flags=bogus','scale=size=13x7:w=13','scale=w=13'])expect(()=>compileVideoFilterChain(text)).toThrow();
});
it('bounds actual decoded nodes and accepts native terminal chain separators',()=>{
 for(const suffix of [',',',   ',';','; \t'])expect(compileVideoFilterChain('null'+suffix).steps).toEqual([{name:'null'}]);
 expect(compileVideoFilterChain(Array(32).fill("'null'").join(',')+',').steps).toHaveLength(32);
 expect(()=>compileVideoFilterChain(Array(33).fill("'null'").join(','))).toThrow('node limit');expect(()=>compileVideoFilterChain('null\0')).toThrow();expect(()=>compileVideoFilterChain('x'.repeat(4097))).toThrow('length');
 for(const text of ['null,;','null;null','[in]hflip[out];null'])expect(()=>compileVideoFilterChain(text)).toThrow();
});
it('rejects quoted intermediate expansion before opening input or output',async()=>{
 let opens=0;const frontend=new FFmpeg({filesystem:{async openRead(){opens++;throw new Error('Unexpected input');},async openWrite(){opens++;throw new Error('Unexpected output');}},backend:createMediaBackend(),budget:{maxResidentBytes:16384,maxBufferBytes:32,maxPendingPackets:2,maxCpuTimeMs:10000}}),result=await frontend.exec(['-f','rawvideo','-pixel_format','gray','-s','5x3','-i','/in','-vf',"format='rgba|bgra',format='gray'",'-f','rawvideo','/out']);expect(result.diagnostics[0]?.code).toBe('resource-budget');expect(opens).toBe(0);
});
