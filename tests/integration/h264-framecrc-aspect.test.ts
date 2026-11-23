import {it,expect} from 'vitest';import {spawnSync} from 'node:child_process';import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {loadH264Mp4Corpus,verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
it('matches native H264 framecrc aspect and geometry through empty and transformed output',()=>{
 verifyH264Reference();const corpus=loadH264Mp4Corpus(),directory=mkdtempSync(join(tmpdir(),'edge-h264-framecrc-aspect-')),module=resolve('.build/codecs/openh264/openh264.wasm');let checked=0;
 try{writeFileSync(join(directory,'source.mp4'),Buffer.from(corpus.inputs.find(row=>row.id==='moving-high-cabac-temporal-normal')!.data,'base64'));
  for(const aspect of [null,'16:9']){
   if(aspect){const patch=spawnSync('.build/reference/ffmpeg',['-v','error','-y','-i',join(directory,'source.mp4'),'-map','0:v:0','-c:v','copy','-aspect',aspect,'-f','mp4',join(directory,'input.mp4')],{encoding:'utf8',timeout:15000});expect(patch.status,patch.stderr).toBe(0);}else writeFileSync(join(directory,'input.mp4'),readFileSync(join(directory,'source.mp4')));
   for(const transform of [[],['-vf','transpose=1'],['-vf','scale=64:32'],['-vf','transpose=1,scale=64:32'],['-vf','scale=64:32','-pix_fmt','rgb24']])for(const limit of [0,3]){
    const args=['-y','-f','mp4','-i','/input.mp4','-an','-c:v','rawvideo','-fps_mode','passthrough','-bitexact',...transform,'-frames:v',String(limit),'-f','framecrc','/actual.crc'];
    const native=spawnSync('.build/reference/ffmpeg',['-v','error',...args.map(value=>value==='/input.mp4'?join(directory,'input.mp4'):value==='/actual.crc'?join(directory,'native.crc'):value)],{encoding:'utf8',timeout:15000});expect(native.status,String(aspect)+transform+limit+native.stderr).toBe(0);
    const actual=spawnSync(process.execPath,['tools/cli/run.mjs','--root',directory,'--h264-wasm',module,'--',...args],{encoding:'utf8',timeout:15000});expect(actual.status,String(aspect)+transform+limit+actual.stderr).toBe(0);expect(readFileSync(join(directory,'actual.crc'),'utf8'),String(aspect)+transform+limit).toBe(readFileSync(join(directory,'native.crc'),'utf8'));checked++;
   }
  }expect(checked).toBe(20);
 }finally{rmSync(directory,{recursive:true,force:true});}verifyH264Reference();
},180000);
