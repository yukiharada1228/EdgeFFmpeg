import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const canonical=resolve('compat/behavior-specs/mp4-demux'),reference=resolve(process.env.EDGE_FFMPEG_REFERENCE_DIR??'.build/reference');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),inputs=JSON.parse(readFileSync(join(canonical,'inputs.json'))),directory=mkdtempSync(join(tmpdir(),'edge-mp4-'));
const results=[];
try{for(const row of inputs){const file=join(directory,'input.mp4'),data=Buffer.from(row.input,'base64');writeFileSync(file,data);const probe=spawnSync(join(reference,'ffprobe'),['-v','error','-show_packets','-show_streams','-show_data','-of','json',file],{encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024});if(probe.status!==0)throw Error(row.id+': '+probe.stderr);const parsed=JSON.parse(probe.stdout);results.push({id:row.id,inputSha256:hash(data),streams:parsed.streams,packets:parsed.packets.map(p=>{const hex=p.data.split('\n').filter(l=>l.includes(':')).map(l=>l.slice(l.indexOf(':')+1).trimStart().split('  ')[0].replace(/\s/g,'')).join('');return {...p,data:Buffer.from(hex,'hex').toString('base64')};})});}}
finally{rmSync(directory,{recursive:true,force:true});}
writeFileSync(join(canonical,'results.json'),JSON.stringify(results,null,2)+'\n');
const version=spawnSync(join(reference,'ffmpeg'),['-version'],{encoding:'utf8'});if(version.status)throw Error(version.stderr);
const lock=JSON.parse(readFileSync('compat/upstream.lock.json')),sources=Object.fromEntries(['mov.c','isom.c'].map(name=>{const file='upstream/ffmpeg/libavformat/'+name;return[file,hash(readFileSync(file))];}));
writeFileSync(join(canonical,'provenance.json'),JSON.stringify({reference:{commit:lock.commit,ffmpegSha256:hash(readFileSync(join(reference,'ffmpeg'))),ffprobeSha256:hash(readFileSync(join(reference,'ffprobe'))),version:version.stdout},sources,caseCount:results.length,certified:false},null,2)+'\n');
const hashes=Object.fromEntries(['inputs.json','results.json','provenance.json'].map(name=>[name,hash(readFileSync(join(canonical,name)))]));writeFileSync(join(canonical,'manifest.json'),JSON.stringify({sha256:hashes},null,2)+'\n');console.log({cases:results.length});
