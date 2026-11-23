import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {loadH264Mp4Corpus,verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
import {h264Hash,loadH264Module} from '../helpers/h264-corpus.js';
it('matches native MP4 H264 passthrough through the actual Node CLI and frame limits',()=>{
 const corpus=loadH264Mp4Corpus(),directory=mkdtempSync(join(tmpdir(),'edge-h264-cli-')),module=resolve('.build/codecs/openh264/openh264.wasm');loadH264Module();verifyH264Reference();
 try{for(const row of corpus.cases){const input=corpus.inputs.find(input=>input.id===row.inputId)!;writeFileSync(join(directory,'input.mp4'),Buffer.from(input.data,'base64'));
  const args=['-y','-f','mp4','-i','/input.mp4',...row.map,'-an','-c:v','rawvideo','-pix_fmt','yuv420p','-fps_mode','passthrough',...(row.limit===null?[]:['-frames:v',String(row.limit)]),'-f','rawvideo','/actual.raw'],nativeArgs=args.map(value=>value==='/input.mp4'?join(directory,'input.mp4'):value==='/actual.raw'?join(directory,'native.raw'):value);
  const native=spawnSync('.build/reference/ffmpeg',['-v','error',...nativeArgs],{encoding:'utf8',timeout:15000});expect(native.status,row.id+native.stderr).toBe(0);
  const processResult=spawnSync(process.execPath,['tools/cli/run.mjs','--root',directory,'--h264-wasm',module,'--',...args],{encoding:'utf8',timeout:15000});expect(processResult.status,row.id+processResult.stderr).toBe(0);
  const expected=readFileSync(join(directory,'native.raw')),actual=readFileSync(join(directory,'actual.raw'));expect(actual.equals(expected),row.id).toBe(true);expect(actual.length,row.id).toBe(row.expectedBytes);expect(h264Hash(actual),row.id).toBe(row.expectedSha256);
 }}finally{rmSync(directory,{recursive:true,force:true});}
 verifyH264Reference();
},180000);
