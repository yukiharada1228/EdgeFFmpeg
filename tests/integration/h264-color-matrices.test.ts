import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {loadH264Mp4Corpus,verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
it('matches native automatic H264 VUI matrix selection through the actual Node CLI',()=>{
 verifyH264Reference();const corpus=loadH264Mp4Corpus(),directory=mkdtempSync(join(tmpdir(),'edge-h264-matrices-')),module=resolve('.build/codecs/openh264/openh264.wasm');let checked=0;
 try{writeFileSync(join(directory,'source.mp4'),Buffer.from(corpus.inputs.find(row=>row.id==='moving-high-cabac-temporal-normal')!.data,'base64'));
  for(const [matrix,name]of [[0,'gbr'],[1,'bt709'],[2,'unknown'],[4,'fcc'],[5,'bt470bg'],[6,'smpte170m'],[7,'smpte240m'],[9,'bt2020nc'],[10,'bt2020c']] as const){
   const patch=spawnSync('.build/reference/ffmpeg',['-v','error','-y','-i',join(directory,'source.mp4'),'-map','0:v:0','-c:v','copy','-bsf:v',`h264_metadata=matrix_coefficients=${matrix}`,'-f','mp4',join(directory,'input.mp4')],{encoding:'utf8',timeout:15000});expect(patch.status,patch.stderr).toBe(0);
   const probe=spawnSync('.build/reference/ffprobe',['-v','error','-show_entries','stream=color_space','-of','json',join(directory,'input.mp4')],{encoding:'utf8',timeout:15000});expect(probe.status,probe.stderr).toBe(0);expect(JSON.parse(probe.stdout).streams[0].color_space??'unknown').toBe(name);
   for(const cpu of [[],['-cpuflags','0']])for(const processing of [['-pix_fmt','rgb24'],['-vf','scale=48:32','-pix_fmt','rgb24']]){
    const args=['-y',...cpu,'-f','mp4','-i','/input.mp4','-an','-c:v','rawvideo','-fps_mode','passthrough','-frames:v','4',...processing,'-f','rawvideo','/actual.raw'];
    const native=spawnSync('.build/reference/ffmpeg',['-v','error',...args.map(value=>value==='/input.mp4'?join(directory,'input.mp4'):value==='/actual.raw'?join(directory,'native.raw'):value)],{encoding:'utf8',timeout:15000});if(matrix===10)expect(native.status,name).not.toBe(0);else expect(native.status,name+native.stderr).toBe(0);
    const previous=matrix===10?readFileSync(join(directory,'actual.raw')):null;
    const actual=spawnSync(process.execPath,['tools/cli/run.mjs','--root',directory,'--h264-wasm',module,'--',...args],{encoding:'utf8',timeout:15000});if(matrix===10){expect(actual.status,name).not.toBe(0);expect(actual.stderr).toContain('color-matrix conversion');expect(readFileSync(join(directory,'actual.raw')).equals(previous!)).toBe(true);}else{expect(actual.status,name+actual.stderr).toBe(0);expect(readFileSync(join(directory,'actual.raw')).equals(readFileSync(join(directory,'native.raw'))),name+cpu+processing).toBe(true);}checked++;
   }
  }expect(checked).toBe(36);
 }finally{rmSync(directory,{recursive:true,force:true});}verifyH264Reference();
},180000);
