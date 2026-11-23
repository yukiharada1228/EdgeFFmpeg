import {FFmpeg} from '@edge-ffmpeg/core';
import {createMediaBackend} from '@edge-ffmpeg/avformat';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';
import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {loadH264Mp4Corpus,verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
it('connects H264 decode to bounded spatial filters, scaling and pixel conversion through Node CLI',()=>{
 const corpus=loadH264Mp4Corpus(),directory=mkdtempSync(join(tmpdir(),'edge-h264-processing-')),module=resolve('.build/codecs/openh264/openh264.wasm');verifyH264Reference();
 const small=corpus.inputs.filter(row=>['manual','multi','cabac-0','moving-main-cavlc-spatial-none','moving-high-cabac-temporal-normal'].includes(row.id));
 const transforms=[['-vf','hflip'],['-vf','vflip'],['-vf','transpose=1'],['-vf','hflip,vflip'],['-vf','scale=48:32'],['-s','48x32'],['-pix_fmt','nv12'],['-pix_fmt','nv21'],['-pix_fmt','yuv444p'],['-pix_fmt','rgb24'],['-pix_fmt','gray'],['-vf','hflip,scale=48:32','-pix_fmt','nv12']];let checked=0;
 try{for(const input of [...small,...corpus.inputs.filter(row=>row.id.startsWith('hd-'))]){writeFileSync(join(directory,'input.mp4'),Buffer.from(input.data,'base64'));
  for(const cpu of [[],['-cpuflags','0']])for(const transform of input.id.startsWith('hd-')?[['-vf','scale=48:32'],['-s','48x32']]:transforms){
   const args=['-y',...cpu,'-f','mp4','-i','/input.mp4','-map','0:v:0','-an','-c:v','rawvideo','-fps_mode','passthrough','-frames:v','4',...transform,'-f','rawvideo','/actual.raw'];
   const nativeArgs=args.map(value=>value==='/input.mp4'?join(directory,'input.mp4'):value==='/actual.raw'?join(directory,'native.raw'):value);
   const native=spawnSync('.build/reference/ffmpeg',['-v','error',...nativeArgs],{encoding:'utf8',timeout:15000});expect(native.status,input.id+transform+native.stderr).toBe(0);
   const actual=spawnSync(process.execPath,['tools/cli/run.mjs','--root',directory,'--h264-wasm',module,'--',...args],{encoding:'utf8',timeout:15000});expect(actual.status,input.id+transform+actual.stderr).toBe(0);
   const expected=readFileSync(join(directory,'native.raw')),bytes=readFileSync(join(directory,'actual.raw'));if(!bytes.equals(expected)){writeFileSync('.build/h264-processing-native.raw',expected);writeFileSync('.build/h264-processing-actual.raw',bytes);writeFileSync('.build/h264-processing-failure.mp4',Buffer.from(input.data,'base64'));}expect(bytes.equals(expected),input.id+' '+transform.join(' ')+' '+bytes.length+'/'+expected.length).toBe(true);checked++;
  }
 }expect(checked).toBe(128);}finally{rmSync(directory,{recursive:true,force:true});}verifyH264Reference();
},180000);

it('aborts processing-budget failures without replacing existing output and reserves processing before input I/O',async()=>{
 const corpus=loadH264Mp4Corpus(),directory=mkdtempSync(join(tmpdir(),'edge-h264-processing-budget-'));
 const h264={module:new WebAssembly.Module(readFileSync('.build/codecs/openh264/openh264.wasm')),maxMemoryBytes:67108864,maxPacketBytes:1048576,maxFrameBytes:4194304,maxDisplayBytes:16777216,maxNalUnits:16384,maxProcessingBytes:1};
 const args=['-y','-f','mp4','-i','/input.mp4','-an','-c:v','rawvideo','-fps_mode','passthrough','-vf','hflip','-f','rawvideo','/actual.raw'];
 try{writeFileSync(join(directory,'input.mp4'),Buffer.from(corpus.inputs.find(row=>row.id==='manual')!.data,'base64'));writeFileSync(join(directory,'actual.raw'),'old output');
  const filesystem=await createNodeFileSystem({root:directory,maxReadBytes:1048576,maxWriteBytes:1048576});
  const budget={maxResidentBytes:134217728,maxBufferBytes:1048576,maxCpuTimeMs:60000,maxPendingPackets:32};
  const result=await new FFmpeg({filesystem,backend:createMediaBackend({h264}),budget}).exec(args);
  expect(result.diagnostics[0]?.code).toBe('resource-budget');expect(readFileSync(join(directory,'actual.raw'),'utf8')).toBe('old output');expect(readdirSync(directory).sort()).toEqual(['actual.raw','input.mp4']);
  let reads=0;const noIo={async openRead():Promise<never>{reads++;throw Error('Unexpected input');},async openWrite():Promise<never>{throw Error('Unexpected output');}};
  const reserved=await new FFmpeg({filesystem:noIo,backend:createMediaBackend({h264:{...h264,maxProcessingBytes:134217728}}),budget}).exec(args);
  expect(reserved.diagnostics[0]?.code).toBe('resource-budget');expect(reads).toBe(0);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

it('retains H264 matrix metadata and matches native color conversion and spatial processing',()=>{
 const corpus=loadH264Mp4Corpus(),directory=mkdtempSync(join(tmpdir(),'edge-h264-matrix-')),module=resolve('.build/codecs/openh264/openh264.wasm');
 try{writeFileSync(join(directory,'source.mp4'),Buffer.from(corpus.inputs.find(row=>row.id==='moving-high-cabac-temporal-normal')!.data,'base64'));
  const patch=spawnSync('.build/reference/ffmpeg',['-v','error','-y','-i',join(directory,'source.mp4'),'-map','0:v:0','-c:v','copy','-bsf:v','h264_metadata=matrix_coefficients=1','-f','mp4',join(directory,'input.mp4')],{encoding:'utf8',timeout:15000});expect(patch.status,patch.stderr).toBe(0);
  const probe=spawnSync('.build/reference/ffprobe',['-v','error','-show_entries','stream=color_space','-of','json',join(directory,'input.mp4')],{encoding:'utf8',timeout:15000});expect(probe.status,probe.stderr).toBe(0);expect(JSON.parse(probe.stdout).streams[0].color_space).toBe('bt709');
  for(const transform of [['-pix_fmt','rgb24'],['-vf','hflip']]){
   const args=['-y','-f','mp4','-i','/input.mp4','-an','-c:v','rawvideo','-fps_mode','passthrough','-frames:v','4',...transform,'-f','rawvideo','/actual.raw'];
   const actual=spawnSync(process.execPath,['tools/cli/run.mjs','--root',directory,'--h264-wasm',module,'--',...args],{encoding:'utf8',timeout:15000});
   {expect(actual.status,actual.stderr).toBe(0);const native=spawnSync('.build/reference/ffmpeg',['-v','error',...args.map(value=>value==='/input.mp4'?join(directory,'input.mp4'):value==='/actual.raw'?join(directory,'native.raw'):value)],{encoding:'utf8',timeout:15000});expect(native.status,native.stderr).toBe(0);expect(readFileSync(join(directory,'actual.raw')).equals(readFileSync(join(directory,'native.raw')))).toBe(true);}
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
});
