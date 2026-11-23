import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const hash = b => createHash('sha256').update(b).digest('hex');
const reference = JSON.parse(fs.readFileSync('.build/reference/build-metadata.json'));
const lock = JSON.parse(fs.readFileSync('compat/upstream.lock.json'));
const generator = 'tools/differential-runner/wav-channel-mask/generate.mjs';
const sources = Object.fromEntries([generator, 'upstream/ffmpeg/libavformat/riffenc.c', 'upstream/ffmpeg/libavformat/wavenc.c'].map(p => [p, hash(fs.readFileSync(p))]));
function verify() {
 if (reference.commit !== lock.commit) throw Error('Reference commit changed');
 for (const name of ['ffmpeg','ffprobe']) if (hash(fs.readFileSync('.build/reference/'+name)) !== reference.artifacts[name]) throw Error('Reference artifact changed');
 for (const [path, digest] of Object.entries(sources)) if (hash(fs.readFileSync(path)) !== digest) throw Error('Source changed');
}
verify();
const root = fs.mkdtempSync(join(tmpdir(),'wav-mask-')), rows = [];
try {
 for (const mask of [4,0x20000,0x3ffff,0x40000,0x40001,0x60000,0x80000000]) for (const samples of [0,4]) {
  const channels = mask.toString(2).replaceAll('0','').length;
  const data = Buffer.from(Array.from({length:samples*channels*2},(_,i)=>(i*29+17)&255));
  const input = Buffer.alloc(68+data.length);
  input.write('RIFF',0);input.writeUInt32LE(input.length-8,4);input.write('WAVEfmt ',8);input.writeUInt32LE(40,16);
  input.writeUInt16LE(65534,20);input.writeUInt16LE(channels,22);input.writeUInt32LE(8000,24);input.writeUInt32LE(16000*channels,28);
  input.writeUInt16LE(2*channels,32);input.writeUInt16LE(16,34);input.writeUInt16LE(22,36);input.writeUInt16LE(16,38);input.writeUInt32LE(mask,40);
  Buffer.from('0100000000001000800000aa00389b71','hex').copy(input,44);input.write('data',60);input.writeUInt32LE(data.length,64);data.copy(input,68);
  const src=join(root,'input.wav'),dst=join(root,'output.wav');fs.writeFileSync(src,input);
  const result=spawnSync('.build/reference/ffmpeg',['-v','error','-y','-i',src,'-c:a','copy','-bitexact',dst],{encoding:'utf8',timeout:15000});
  if(result.error||result.signal||result.status!==0) throw Error(result.stderr||String(result.error));
  const output=fs.readFileSync(dst),fmtTag=output.readUInt16LE(20);
  rows.push({mask,channels,samples,exitCode:result.status,fmtTag,outputMask:fmtTag===65534?output.readUInt32LE(40):null,input:input.toString('base64'),output:output.toString('base64'),sha256:hash(output),stderr:result.stderr});
 }
 verify();
 const out=process.argv[2]??'compat/behavior-specs/wav-channel-mask';fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(join(out,'cases.json'),JSON.stringify({reference,rows},null,2)+'\n');
 fs.writeFileSync(join(out,'provenance.json'),JSON.stringify({reference,sources,caseCount:rows.length,scope:'Finite PCM16 WAV stream copy, default compliance, explicit output bitexact; high channel masks serialize as zero. No strict-mode or arbitrary channel-layout certification.'},null,2)+'\n');
 fs.writeFileSync(join(out,'manifest.json'),JSON.stringify({sha256:Object.fromEntries(['cases.json','provenance.json'].map(n=>[n,hash(fs.readFileSync(join(out,n)))]))},null,2)+'\n');
 console.log(JSON.stringify({cases:rows.length,out}));
} finally {fs.rmSync(root,{recursive:true,force:true});}
