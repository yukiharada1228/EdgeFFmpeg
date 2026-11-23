// Development-only independently executed Native oracle. No production imports.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
const sha=b=>createHash('sha256').update(b).digest('hex');
const tool='tools/differential-runner/flac-copy-duration/generate.mjs', destination='compat/behavior-specs/flac-copy-duration/cases.json';
const binary=resolve('.build/reference/ffmpeg'), binarySha256='1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92';
assert.equal(sha(readFileSync(binary)),binarySha256);
const reference=JSON.parse(readFileSync('.build/reference/build-metadata.json'));
assert.equal(reference.commit,'946fcce07b6dcd0331c8cc609192aeff5e1924f8');
const sourcePath='compat/behavior-specs/flac-max-remux/cases.json', corpus=JSON.parse(readFileSync(sourcePath));
const base=corpus.rows.find(r=>r.id==='16-2-ramp-5/default'), empty=corpus.rows.find(r=>r.id==='16-2-empty-5/default');
const sources=new Map([['known',Buffer.from(base.input,'base64')],['empty',Buffer.from(empty.input,'base64')]]);
const unknown=Buffer.from(sources.get('known'));unknown.writeBigUInt64BE(unknown.readBigUInt64BE(18)&~((1n<<36n)-1n),18);sources.set('unknown',unknown);
assert.equal(Number(sources.get('known').readBigUInt64BE(18)&((1n<<36n)-1n)),257);
assert.deepEqual(base.inputPackets.map(p=>[p.pts,p.duration]),[[0,192],[192,65]]);
function audio(bytes){let at=4;for(;;){const last=bytes[at]&128,n=bytes.readUIntBE(at+1,3);at+=4+n;if(last)return bytes.subarray(at);}}
function crc(bytes, bits, polynomial) {
  let value = 0;
  for (const byte of bytes) {
    value ^= byte << (bits - 8);
    for (let bit = 0; bit < 8; bit++) value = ((value << 1) ^ (value & (1 << (bits - 1)) ? polynomial : 0)) & ((1 << bits) - 1);
  }
  return value;
}
function inspect(bytes) {
  const metadata = {audioOffset:bytes.length-audio(bytes).length}, word = bytes.readBigUInt64BE(18);
  const descriptor = {streamId:0, codec:'flac', sampleRate:Number(word >> 44n), channels:Number(word >> 41n & 7n) + 1, bitsPerSample:Number(word >> 36n & 31n) + 1, totalSamples:Number(word & ((1n << 36n) - 1n)), minBlockSamples:bytes.readUInt16BE(8), maxBlockSamples:bytes.readUInt16BE(10), channelLayout:'stereo', streamInfoSha256:sha(bytes.subarray(8, 42)), provenance:'Independent STREAMINFO interpretation; not ffprobe output'};
  const starts = [];
  for (let at = metadata.audioOffset; at + 6 < bytes.length; at++) {
    if (bytes[at] !== 255 || (bytes[at + 1] & 254) !== 248) continue;
    const blockCode = bytes[at + 2] >> 4, rateCode = bytes[at + 2] & 15;
    let end = at + 4, leading = bytes[end++], continuation = 0;
    if (leading >= 128) {let mask = 128; while (leading & mask) {continuation++; mask >>= 1;} continuation--;}
    if (continuation > 6 || continuation < 0) continue;
    end += continuation;
    let duration;
    if (blockCode === 1) duration = 192;
    else if (blockCode >= 2 && blockCode <= 5) duration = 576 << (blockCode - 2);
    else if (blockCode === 6) duration = bytes[end++] + 1;
    else if (blockCode === 7) {if (end + 2 > bytes.length) continue; duration = bytes.readUInt16BE(end) + 1; end += 2;}
    else if (blockCode >= 8) duration = 256 << (blockCode - 8);
    else continue;
    end += rateCode === 12 ? 1 : rateCode >= 13 ? 2 : 0;
    if (end < bytes.length && crc(bytes.subarray(at, end + 1), 8, 7) === 0) starts.push({at, duration});
  }
  const packets = [];
  let at = metadata.audioOffset, pts = 0;
  while (at < bytes.length) {
    const start = starts.find(start => start.at === at);
    assert(start, 'No CRC8-valid frame at audio boundary');
    const end = [...starts.filter(start => start.at > at).map(start => start.at), bytes.length].find(end => crc(bytes.subarray(at, end), 16, 0x8005) === 0);
    assert(end !== undefined, 'No CRC16-valid frame ending');
    packets.push({streamId:0, pts, dts:pts, duration:start.duration, bytes:end - at, dataSha256:sha(bytes.subarray(at, end))});
    pts += start.duration; at = end;
  }
  return {descriptors:[descriptor], packets, parser:'Independent FLAC header CRC8 and whole-frame CRC16, cumulative clean-source sample timestamps; no PCM decode'};
}

let preparationCalls=0;
const previous=existsSync(destination)?JSON.parse(readFileSync(destination)):null;
let preparation=previous?.sourcePreparation;
if(!preparation){
assert(!process.argv.includes('--verify'),'Fractional source absent');
const pcmPath='compat/behavior-specs/flac-decode-cli/cases.json',pcmRow=JSON.parse(readFileSync(pcmPath)).rows.find(r=>r.id==='16-2-ramp-5/s16le'),pcm=Buffer.from(pcmRow.output,'base64');assert.equal(sha(pcm),pcmRow.outputSha256);
mkdirSync('.build/temp',{recursive:true});const prepRoot=mkdtempSync(resolve('.build/temp/flac-copy-duration-prep-'));
try{writeFileSync(join(prepRoot,'in.pcm'),pcm);const args=['-y','-f','s16le','-ar','44100','-ac','2','-i','/in.pcm','-c:a','flac','-frame_size','192','-f','flac','/out'];
const result=spawnSync(binary,['-nostdin','-hide_banner','-loglevel','warning','-threads','1',...args.map(x=>x==='/in.pcm'?join(prepRoot,'in.pcm'):x==='/out'?join(prepRoot,'out'):x)],{timeout:10000,maxBuffer:524288});preparationCalls++;
preparation={source:{path:pcmPath,rowId:pcmRow.id,outputSha256:pcmRow.outputSha256},args,input:pcm.toString('base64'),inputSha256:sha(pcm),exitCode:result.status,stdout:result.stdout.toString(),stderr:result.stderr.toString().replaceAll(prepRoot,'<fixture>').replaceAll(/0x[0-9a-f]+/g,'<address>')};
if(existsSync(join(prepRoot,'out'))){const b=readFileSync(join(prepRoot,'out'));preparation.output=b.toString('base64');preparation.outputSha256=sha(b);}
previous.sourcePreparation=preparation;writeFileSync(destination,JSON.stringify(previous,null,2)+'\n');assert(!result.error);assert.equal(result.status,0,preparation.stderr);
}finally{rmSync(prepRoot,{recursive:true,force:true});}}
assert.equal(preparation.exitCode,0);const fractional=Buffer.from(preparation.output,'base64');assert.equal(sha(fractional),preparation.outputSha256);const fractionalProbe=inspect(fractional);assert.equal(fractionalProbe.descriptors[0].sampleRate,44100);assert.equal(fractional.readUInt16BE(8),192);assert.equal(fractional.readUInt16BE(10),192);assert.deepEqual(fractionalProbe.packets.map(p=>[p.pts,p.duration]),[[0,192],[192,65]]);sources.set('fractional',fractional);

const plans=[];
const add=(id,inputOptions=[],outputOptions=[],source='known')=>plans.push({id,inputOptions,outputOptions,source});
for(const where of ['input','output'])for(const value of ['0','0.000125','0.023875','0.024','0.024125','0.032125'])add(`${where}-t-${value}`,where==='input'?['-t',value]:[],where==='output'?['-t',value]:[]);
for(const where of ['input','output'])for(const value of ['0.023999','0.024001'])add(`${where}-t-${value}`,where==='input'?['-t',value]:[],where==='output'?['-t',value]:[]);
for(const where of ['input','output'])for(const value of ['0','0.024','0.024125'])add(`${where}-to-${value}`,where==='input'?['-to',value]:[],where==='output'?['-to',value]:[]);
add('input-t-wins-to',['-to','0.024125','-t','0.024']);add('output-t-wins-to',[],['-to','0.024125','-t','0.024']);
add('input-short-output-long',['-t','0.024'],['-t','0.024125']);add('input-long-output-short',['-t','0.024125'],['-t','0.024']);
add('frames-one',[],['-t','0.024125','-frames:a','1']);add('frames-zero',[],['-t','0.024125','-frames:a','0']);
add('unknown-input',['-t','0.024'],[],'unknown');add('unknown-output',[],['-t','0.024125'],'unknown');
add('empty-input',['-t','0.024'],[],'empty');add('empty-output',[],['-t','0.024125'],'empty');
add('output-bitexact',[],['-t','0.024','-fflags','+bitexact','-map_metadata','-1']);
add('input-negative',['-t','-0.01']);add('output-negative',[],['-t','-0.01']);
for(const value of ['0.004353','0.004354','0.004355'])add(`fractional-output-t-${value}`,[],['-t',value],'fractional');
const prefix=['-nostdin','-hide_banner','-loglevel','warning','-threads','1'];
const fingerprint=sha(JSON.stringify({tool:sha(readFileSync(tool)),binarySha256,plans,sources:[...sources].map(([id,b])=>[id,sha(b)])}));
let data=existsSync(destination)?JSON.parse(readFileSync(destination)):null;
if(data&&data.fingerprint!==fingerprint){assert(!process.argv.includes('--verify'),'Fingerprint mismatch');data.generationHistory??=[];data.generationHistory.push({fingerprint:data.fingerprint,rows:data.rows.length,note:'Incremental extension; all cached argv/input/output hashes revalidated without Native execution.'});data.fingerprint=fingerprint;}
data??={generator:tool,fingerprint,reference,binarySha256,source:{path:sourcePath,rowId:base.id,inputSha256:base.inputSha256,packets:base.inputPackets,descriptor:base.descriptors[0],unknownTransform:'Clear only STREAMINFO totalSamples 36 bits; preserve every other input byte.'},limits:{nativeCalls:40,maxInputBytes:524288,maxOutputBytes:524288,sequential:true},invocationPrefix:prefix,rows:[]};
let nativeCalls=preparationCalls;mkdirSync('.build/temp',{recursive:true});const root=mkdtempSync(resolve('.build/temp/flac-copy-duration-'));
try{for(const plan of plans){const input=sources.get(plan.source),args=['-y',...plan.inputOptions,'-i','/in.flac','-map','0:a:0','-c:a','copy',...plan.outputOptions,'-f','flac','/out'];
const prior=data.rows.find(r=>r.id===plan.id);if(prior){assert.deepEqual(prior.args,args);assert.equal(prior.inputSha256,sha(input));if(prior.output!==null)assert.equal(sha(Buffer.from(prior.output,'base64')),prior.outputSha256);continue;}
assert(!process.argv.includes('--verify'),'Missing cached row');assert(data.rows.length+1+1<=40);assert(++nativeCalls<=40);writeFileSync(join(root,'in.flac'),input);rmSync(join(root,'out'),{force:true});
const actual=args.map(x=>x==='/in.flac'?join(root,'in.flac'):x==='/out'?join(root,'out'):x),r=spawnSync(binary,[...prefix,...actual],{timeout:10000,maxBuffer:524288});assert(!r.error);assert.notEqual(r.status,null);
const output=existsSync(join(root,'out'))?readFileSync(join(root,'out')):null;assert(input.length<=524288);assert(!output||output.length<=524288);
let packets=[];if(output){const payload=audio(output);let at=0;for(const packet of (plan.source==='fractional'?fractionalProbe.packets:base.inputPackets)){if(at===payload.length)break;assert.equal(sha(payload.subarray(at,at+packet.bytes)),packet.dataSha256,'Actual output must contain whole original packets');packets.push(packet);at+=packet.bytes;}assert.equal(at,payload.length);}
data.rows.push({...plan,input:input.toString('base64'),inputSha256:sha(input),args,exitCode:r.status,stdout:r.stdout.toString(),stderr:r.stderr.toString().replaceAll(root,'<fixture>').replaceAll(/0x[0-9a-f]+/g,'<address>'),output:output?.toString('base64')??null,outputSha256:output?sha(output):null,outputPackets:packets});
data.actualNativeCalls=data.rows.length+1;writeFileSync(destination,JSON.stringify(data,null,2)+'\n');console.log(JSON.stringify({id:plan.id,exitCode:r.status,packets:packets.length}));}
data.rows.sort((a,b)=>plans.findIndex(p=>p.id===a.id)-plans.findIndex(p=>p.id===b.id));assert.equal(data.rows.length,plans.length);assert(data.actualNativeCalls<=40);data.sourcePreparation.inspection=fractionalProbe;writeFileSync(destination,JSON.stringify(data,null,2)+'\n');console.log(JSON.stringify({cached:nativeCalls===0,nativeCalls,rows:data.rows.length}));}finally{rmSync(root,{recursive:true,force:true});}
