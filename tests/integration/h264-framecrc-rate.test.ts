import {it,expect} from 'vitest';import {spawnSync} from 'node:child_process';import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {loadH264Mp4Corpus,verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
it('matches native H264 rate estimation and start normalization for changed decode and presentation clocks',()=>{
 verifyH264Reference();const corpus=loadH264Mp4Corpus(),directory=mkdtempSync(join(tmpdir(),'edge-h264-framecrc-rate-')),module=resolve('.build/codecs/openh264/openh264.wasm');let checked=0;
 const mutations=[['double','pts=2*PTS:dts=2*DTS:duration=2*DURATION'],['jitter','pts=PTS+200*mod(PTS/800\\,2):dts=DTS:duration=DURATION'],['variable','pts=PTS+200*floor(PTS/1600):dts=DTS+200*floor((DTS+1600)/1600):duration=DURATION+200*mod(N\\,2)']] as const;
 try{writeFileSync(join(directory,'source.mp4'),Buffer.from(corpus.inputs.find(row=>row.id==='moving-high-cabac-temporal-normal')!.data,'base64'));
  for(const [id,expression]of mutations){const mutation=spawnSync('.build/reference/ffmpeg',['-v','error','-y','-i',join(directory,'source.mp4'),'-map','0:v:0','-c:v','copy','-bsf:v','setts='+expression,'-use_editlist','0','-f','mp4',join(directory,'input.mp4')],{encoding:'utf8',timeout:15000});expect(mutation.status,mutation.stderr).toBe(0);
   const probe=spawnSync('.build/reference/ffprobe',['-v','error','-show_entries','stream=avg_frame_rate,r_frame_rate,start_pts','-of','json',join(directory,'input.mp4')],{encoding:'utf8',timeout:15000});expect(probe.status,probe.stderr).toBe(0);const stream=JSON.parse(probe.stdout).streams[0];expect(stream.start_pts).toBeGreaterThan(0);if(id==='variable')expect(stream.r_frame_rate).not.toBe(stream.avg_frame_rate);
   for(const clock of [[],['-enc_time_base','demux'],['-enc_time_base','filter'],['-enc_time_base','1:1000'],['-enc_time_base','1:1']]){
    const args=['-y','-f','mp4','-i','/input.mp4','-an','-c:v','rawvideo','-fps_mode','passthrough','-bitexact',...clock,'-f','framecrc','/actual.crc'];
    const native=spawnSync('.build/reference/ffmpeg',['-v','error',...args.map(value=>value==='/input.mp4'?join(directory,'input.mp4'):value==='/actual.crc'?join(directory,'native.crc'):value)],{encoding:'utf8',timeout:15000});expect(native.status,id+clock+native.stderr).toBe(0);
    const actual=spawnSync(process.execPath,['tools/cli/run.mjs','--root',directory,'--h264-wasm',module,'--',...args],{encoding:'utf8',timeout:15000});expect(actual.status,id+clock+actual.stderr).toBe(0);expect(readFileSync(join(directory,'actual.crc'),'utf8'),id+clock).toBe(readFileSync(join(directory,'native.crc'),'utf8'));checked++;
   }
  }expect(checked).toBe(15);
 }finally{rmSync(directory,{recursive:true,force:true});}verifyH264Reference();
},180000);
