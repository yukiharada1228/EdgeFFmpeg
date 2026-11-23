import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {execFileSync} from 'node:child_process';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {verifyH264Reference} from './h264-mp4-corpus.js';
/** Host-test oracle only: finite seekable Native output, never bundled into a Worker. */
export function nativeWavOutput(input:Uint8Array,outputArgs:readonly string[]=['-c:a','copy'],globalArgs:readonly string[]=[]):Uint8Array{
 verifyH264Reference();const root=mkdtempSync(join(tmpdir(),'workerd-native-wav-'));try{
  writeFileSync(join(root,'input.wav'),input);
  execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-y',...globalArgs,'-i',join(root,'input.wav'),...outputArgs,join(root,'output.wav')],{timeout:15000,stdio:'pipe'});
  return new Uint8Array(readFileSync(join(root,'output.wav')));
 }finally{rmSync(root,{recursive:true,force:true});}
}
