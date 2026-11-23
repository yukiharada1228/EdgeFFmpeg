import {expect,it} from 'vitest';
import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
function formats(value:string){const step=compileVideoFilterChain('format=pix_fmts='+value).steps[0]!;if(step.name!=='format')throw new Error('Unexpected node');return step.pixelFormats;}
it('normalizes declared numeric IDs and pinned little-endian aliases',()=>{
 for(const [value,expected]of [['0','yuv420p'],['+2','rgb24'],['03','bgr24'],['0x1a','rgba'],['034','bgra'],['4294967321','argb'],['-4294967269','abgr'],['71','gbrp'],['rgb32','bgra'],['bgr32','rgba'],['GRAY8','gray'],['Y8','gray']])expect(formats(value!)).toEqual([expected]);
});
it('bounds integer work while retaining saturated LP64 and signed32 semantics',()=>{
 expect(formats('-9223372036854775808')).toEqual(['yuv420p']);expect(formats('-9223372036854775809')).toEqual(['yuv420p']);expect(formats('-'+'9'.repeat(2048))).toEqual(['yuv420p']);expect(formats('0'.repeat(2048)+'2')).toEqual(['rgb24']);
 for(const value of ['9223372036854775807','9223372036854775808','9'.repeat(2048)+'x','-'+'9'.repeat(2048)+'x','08','0b10','0x','+','2tail','1'])expect(()=>formats(value)).toThrow();expect(()=>formats('0'.repeat(4097))).toThrow('length');
});
it('distinguishes explicit empty candidates from unconstrained filter defaults and canonical duplicates',()=>{
 expect(formats('')).toEqual(['yuv420p']);expect(formats('rgba|')).toEqual(['rgba','yuv420p']);expect(formats('|Y8')).toEqual(['yuv420p','gray']);expect(compileVideoFilterChain('format=').steps[0]).toMatchObject({name:'format',pixelFormats:null});
 for(const value of ['0|yuv420p','8|gray8','2|0x2','|0','||'])expect(()=>formats(value)).toThrow('Duplicated');
});
it('uses native ASCII option whitespace while preserving candidate-level validation',()=>{
 expect(compileVideoFilterChain(' \tformat \r= pix_fmts \t= rgb32 \n').steps[0]).toMatchObject({name:'format',pixelFormats:['bgra']});expect(formats(' |gray')).toEqual(['yuv420p','gray']);
 for(const description of ['\u00a0format=0','format=2\u00a0','format=2 |gray','format=gray| rgba','\vnull','\fnull'])expect(()=>compileVideoFilterChain(description)).toThrow();
});

it('rejects numeric candidate errors and intermediate expansion before opening files',async()=>{
 const cases=[...['format=0|yuv420p','format=8|gray8','format=2junk','format=08','format=0b10'].map(description=>({description,buffer:65536,code:'unsupported-command'})),{description:'format=26|28,format=8',buffer:32,code:'resource-budget'}];
 for(const test of cases){let opens=0;const frontend=new FFmpeg({filesystem:{async openRead(){opens++;throw new Error('Unexpected input');},async openWrite(){opens++;throw new Error('Unexpected output');}},backend:createMediaBackend(),budget:{maxResidentBytes:1048576,maxBufferBytes:test.buffer,maxPendingPackets:2,maxCpuTimeMs:10000}}),result=await frontend.exec(['-f','rawvideo','-pixel_format','gray','-s','5x3','-i','/in','-vf',test.description,'-f','rawvideo','/out']);expect(result.exitCode).not.toBe(0);expect(result.diagnostics[0]?.code).toBe(test.code);expect(opens).toBe(0);}
});
