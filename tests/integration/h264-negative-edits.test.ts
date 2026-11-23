import {loadMp4NegativeEdits} from '../helpers/mp4-negative-edits.js';
import {it,expect} from 'vitest';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
it('matches native negative media-time presentation through Node CLI raw and framecrc output',()=>{
 verifyH264Reference();const rows=loadMp4NegativeEdits().inputs,directory=mkdtempSync(join(tmpdir(),'edge-h264-edits-')),module=resolve('.build/codecs/openh264/openh264.wasm');let checked=0;
 try{for(const row of rows){writeFileSync(join(directory,'input.mp4'),Buffer.from(row.input,'base64'));for(const cpu of [[],['-cpuflags','0']])for(const processing of [[],['-pix_fmt','rgb24'],['-vf','hflip,scale=48:32','-pix_fmt','bgra']])for(const format of ['rawvideo','framecrc']){const args=['-y',...cpu,'-f','mp4','-i','/input.mp4','-an','-c:v','rawvideo','-fps_mode','passthrough','-bitexact',...processing,'-f',format,'/actual.out'],native=spawnSync('.build/reference/ffmpeg',['-v','error',...args.map(v=>v==='/input.mp4'?join(directory,'input.mp4'):v==='/actual.out'?join(directory,'native.out'):v)],{encoding:'utf8',timeout:15000});expect(native.status,native.stderr).toBe(0);const actual=spawnSync(process.execPath,['tools/cli/run.mjs','--root',directory,'--h264-wasm',module,'--',...args],{encoding:'utf8',timeout:15000});expect(actual.status,row.id+actual.stderr).toBe(0);const actualBytes=readFileSync(join(directory,'actual.out')),nativeBytes=readFileSync(join(directory,'native.out'));if(!actualBytes.equals(nativeBytes))writeFileSync('.build/h264-negative-mismatch.json',JSON.stringify({id:row.id,cpu,processing,format,actualBytes:actualBytes.length,nativeBytes:nativeBytes.length,actual:format==='framecrc'?actualBytes.toString():null,native:format==='framecrc'?nativeBytes.toString():null},null,2));expect(actualBytes.equals(nativeBytes),row.id+cpu+processing+format).toBe(true);checked++;}}expect(checked).toBe(792);}finally{rmSync(directory,{recursive:true,force:true});}verifyH264Reference();
},600000);
