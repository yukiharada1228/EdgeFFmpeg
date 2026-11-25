import {it,expect} from 'vitest';import {spawnSync} from 'node:child_process';import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {loadH264Mp4Corpus,verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
// Edge converts with the reference build's default pixel profile (x86_64 for the linux-x64 pin), resolved once.
let edgeEnvironment:NodeJS.ProcessEnv|undefined;const edgeEnv=()=>edgeEnvironment??={...process.env,EDGEFFMPEG_PIXEL_ARITHMETIC:referencePixelArithmetic()};
it('matches native full-range H264 raw and framecrc processing across matrices and arithmetic profiles',()=>{
 verifyH264Reference();const corpus=loadH264Mp4Corpus(),directory=mkdtempSync(join(tmpdir(),'edge-h264-fullrange-')),module=resolve('.build/codecs/openh264/openh264.wasm');let checked=0;
 try{for(const id of ['moving-main-cavlc-spatial-none','moving-high-cabac-temporal-normal','hd-high-cabac-temporal-normal']){writeFileSync(join(directory,'source.mp4'),Buffer.from(corpus.inputs.find(row=>row.id===id)!.data,'base64'));
  for(const matrix of id.startsWith('hd-')?[9]:[1,5,7,9]){const patch=spawnSync('.build/reference/ffmpeg',['-v','error','-y','-i',join(directory,'source.mp4'),'-map','0:v:0','-c:v','copy','-bsf:v',`h264_metadata=video_full_range_flag=1:matrix_coefficients=${matrix}`,'-f','mp4',join(directory,'input.mp4')],{encoding:'utf8',timeout:15000});expect(patch.status,patch.stderr).toBe(0);
   const probe=spawnSync('.build/reference/ffprobe',['-v','error','-show_entries','stream=color_range,pix_fmt','-of','json',join(directory,'input.mp4')],{encoding:'utf8',timeout:15000});expect(probe.status,probe.stderr).toBe(0);expect(JSON.parse(probe.stdout).streams[0]).toMatchObject({color_range:'pc',pix_fmt:'yuvj420p'});
   for(const cpu of [[],['-cpuflags','0']])for(const processing of id.startsWith('hd-')?[[],['-vf','scale=64:32','-pix_fmt','rgb24']]:[[],['-pix_fmt','yuv420p'],['-pix_fmt','rgb24'],['-pix_fmt','gbrp'],['-vf','hflip'],['-vf','scale=64:32'],['-vf','scale=64:32','-pix_fmt','rgb24'],['-vf','transpose=1,scale=64:32','-pix_fmt','bgra']])for(const format of ['rawvideo','framecrc']){
    const args=['-y',...cpu,'-f','mp4','-i','/input.mp4','-an','-c:v','rawvideo','-fps_mode','passthrough','-bitexact','-frames:v',id.startsWith('hd-')?'2':'4',...processing,'-f',format,'/actual.out'];
    const native=spawnSync('.build/reference/ffmpeg',['-v','error',...args.map(value=>value==='/input.mp4'?join(directory,'input.mp4'):value==='/actual.out'?join(directory,'native.out'):value)],{encoding:'utf8',timeout:15000});expect(native.status,id+matrix+processing+native.stderr).toBe(0);
    const actual=spawnSync(process.execPath,['tools/cli/run.mjs','--root',directory,'--h264-wasm',module,'--',...args],{encoding:'utf8',timeout:15000,env:edgeEnv()});expect(actual.status,id+matrix+processing+actual.stderr).toBe(0);expect(readFileSync(join(directory,'actual.out')).equals(readFileSync(join(directory,'native.out'))),id+matrix+cpu+processing+format).toBe(true);checked++;
   }
  }
 }expect(checked).toBe(264);}finally{rmSync(directory,{recursive:true,force:true});}verifyH264Reference();
},600000);
