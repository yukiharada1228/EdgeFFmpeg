import {it,expect} from 'vitest';import {spawnSync} from 'node:child_process';import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {loadH264Mp4Corpus,verifyH264Reference} from '../helpers/h264-mp4-corpus.js';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
// Edge converts with the reference build's default pixel profile (x86_64 for the linux-x64 pin), resolved once.
let edgeEnvironment:NodeJS.ProcessEnv|undefined;const edgeEnv=()=>edgeEnvironment??={...process.env,EDGEFFMPEG_PIXEL_ARITHMETIC:referencePixelArithmetic()};
it('matches native RGB after full-to-limited H264 range changes through MP4 Node CLI',()=>{
 verifyH264Reference();const corpus=loadH264Mp4Corpus(),directory=mkdtempSync(join(tmpdir(),'edge-h264-range-cli-')),module=resolve('.build/codecs/openh264/openh264.wasm');let checked=0;
 const run=(args:string[])=>{const result=spawnSync('.build/reference/ffmpeg',['-v','error','-y',...args],{encoding:'utf8',timeout:15000});expect(result.status,result.stderr).toBe(0);};
 try{writeFileSync(join(directory,'source.mp4'),Buffer.from(corpus.inputs.find(row=>row.id==='moving-high-cabac-temporal-normal')!.data,'base64'));
  for(const range of [0,1])run(['-i',join(directory,'source.mp4'),'-map','0:v:0','-c:v','copy','-bsf:v',`h264_mp4toannexb,h264_metadata=video_full_range_flag=${range}:matrix_coefficients=1`,'-f','h264',join(directory,`${range}.h264`)]);
  for(const ranges of [[0,1],[1,0]]){writeFileSync(join(directory,'input.h264'),Buffer.concat(ranges.map(range=>readFileSync(join(directory,`${range}.h264`)))));run(['-r','25','-f','h264','-i',join(directory,'input.h264'),'-c:v','copy','-use_editlist','0',join(directory,'input.mp4')]);
   for(const cpu of [[],['-cpuflags','0']])for(const filter of ['format=rgb24','hflip,scale=48:32,format=rgb24']){const args=['-y',...cpu,'-f','mp4','-i','/input.mp4','-an','-c:v','rawvideo','-fps_mode','passthrough','-vf',filter,'-f','rawvideo','/actual.out'];run(args.map(v=>v==='/input.mp4'?join(directory,'input.mp4'):v==='/actual.out'?join(directory,'native.out'):v));const actual=spawnSync(process.execPath,['tools/cli/run.mjs','--root',directory,'--h264-wasm',module,'--',...args],{encoding:'utf8',timeout:15000,env:edgeEnv()});expect(actual.status,ranges+filter+actual.stderr).toBe(0);expect(readFileSync(join(directory,'actual.out')).equals(readFileSync(join(directory,'native.out'))),`${ranges}/${cpu}/${filter}`).toBe(true);checked++;}
  }expect(checked).toBe(8);
 }finally{rmSync(directory,{recursive:true,force:true});}verifyH264Reference();
},180000);
