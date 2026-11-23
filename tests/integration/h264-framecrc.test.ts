import {it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {loadH264Mp4Corpus,verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
it('matches native H264 framecrc clocks and checksums through actual Node CLI encoder timebases',()=>{
 verifyH264Reference();const corpus=loadH264Mp4Corpus(),directory=mkdtempSync(join(tmpdir(),'edge-h264-framecrc-')),module=resolve('.build/codecs/openh264/openh264.wasm');let checked=0;
 try{for(const input of corpus.inputs){writeFileSync(join(directory,'input.mp4'),Buffer.from(input.data,'base64'));for(const stream of input.id==='multi'?[0,1]:[0])for(const clock of [[],['-enc_time_base','demux'],['-enc_time_base','filter'],['-enc_time_base','1:1000']])for(const limit of [0,2,null]){
  const args=['-y','-f','mp4','-i','/input.mp4','-map',`0:v:${stream}`,'-an','-c:v','rawvideo','-fps_mode','passthrough','-bitexact',...clock,...(limit===null?[]:['-frames:v',String(limit)]),'-f','framecrc','/actual.crc'];
  const native=spawnSync('.build/reference/ffmpeg',['-v','error',...args.map(value=>value==='/input.mp4'?join(directory,'input.mp4'):value==='/actual.crc'?join(directory,'native.crc'):value)],{encoding:'utf8',timeout:15000});expect(native.status,input.id+clock+limit+native.stderr).toBe(0);
  const actual=spawnSync(process.execPath,['tools/cli/run.mjs','--root',directory,'--h264-wasm',module,'--',...args],{encoding:'utf8',timeout:15000});expect(actual.status,input.id+clock+limit+actual.stderr).toBe(0);
  expect(readFileSync(join(directory,'actual.crc'),'utf8'),input.id+'/'+stream+'/'+clock+'/'+limit).toBe(readFileSync(join(directory,'native.crc'),'utf8'));checked++;
 }}expect(checked).toBe(324);}finally{rmSync(directory,{recursive:true,force:true});}verifyH264Reference();
},300000);
