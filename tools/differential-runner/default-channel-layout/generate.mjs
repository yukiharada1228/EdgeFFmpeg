import fs from 'node:fs';import {execFileSync,spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {DRAFT_ENV,corpusTarget,writePlatformCorpus} from '../platform-corpus.mjs';import {LEGACY_CORPUS_PLATFORM,localReferenceIdentity} from '../reference-identity.mjs';
// darwin-arm64 rewrites its tracked corpus in compat/behavior-specs/default-channel-layout; an explicit first argument writes the
// same layout to that directory instead (independent repeats). Any other pin, and --draft, writes native-layouts.json, cases.json
// and sources.json (the provenance record without `reference`) into compat/behavior-specs/default-channel-layout/<pin id>/ through
// platform-corpus.mjs, as tools/linux/generate-corpora.mjs runs it (committed only from the Linux probe corpora job). The oracle
// links the libavutil.a pinned for this host's reference (compat/reference-pins.json).
const hash=b=>createHash('sha256').update(b).digest('hex'),read=p=>fs.readFileSync(p),generator='tools/differential-runner/default-channel-layout/generate.mjs',oracle='tools/differential-runner/default-channel-layout/oracle.c',reference=JSON.parse(read('.build/reference/build-metadata.json')),lock=JSON.parse(read('compat/upstream.lock.json')),library='.build/reference/libavutil/libavutil.a',librarySha256=hash(read(library));
const explicitOut=process.argv[2]&&!process.argv[2].startsWith('--')?process.argv[2]:undefined,identity=localReferenceIdentity(),draft=process.argv.includes('--draft')||process.env[DRAFT_ENV]==='1';
if(librarySha256!==identity.libraries['libavutil/libavutil.a'])throw Error(`${library} ${librarySha256} is not the pinned ${identity.id} libavutil.a`);
const target=explicitOut||identity.id===LEGACY_CORPUS_PLATFORM&&!draft?null:corpusTarget('compat/behavior-specs/default-channel-layout',generator);
const sources=Object.fromEntries([generator,oracle,...['libavutil/channel_layout.c','libavutil/channel_layout.h','libavformat/riffenc.c','fftools/ffmpeg_demux.c'].map(p=>'upstream/ffmpeg/'+p)].map(p=>[p,hash(read(p))]));
function verify(){if(reference.commit!==lock.commit||hash(read(library))!==librarySha256)throw Error('Reference changed');for(const name of ['ffmpeg','ffprobe'])if(hash(read('.build/reference/'+name))!==reference.artifacts[name])throw Error('Reference binary changed');for(const[p,digest]of Object.entries(sources))if(hash(read(p))!==digest)throw Error('Source changed');}
verify();const root=fs.mkdtempSync(join(tmpdir(),'native-default-layout-')),rows=[];
try{
 const config=read('.build/reference/ffbuild/config.mak').toString(),raw=config.split('\n').find(l=>l.startsWith('EXTRALIBS-avutil=')).split('=').slice(1).join('=');if(/[$`"'\\]/.test(raw))throw Error('Nonliteral linker flags');
 const binary=join(root,'oracle');execFileSync('cc',['-I.build/reference','-Iupstream/ffmpeg',oracle,library,...raw.trim().split(/\s+/).filter(Boolean),'-o',binary]);
 const layouts=JSON.parse(execFileSync(binary,{encoding:'utf8'}));if(layouts.length!==13)throw Error('Default layout table changed');
 for(let channels=1;channels<=32;channels++)for(const samples of [0,4])for(const kind of ['raw','wav'])for(const guess of [true,false])for(const format of ['wav','framecrc']){
  const payload=Buffer.from(Array.from({length:samples*channels*2},(_,i)=>(i*29+17)&255));let input=payload;
  if(kind==='wav'){input=Buffer.alloc(44+payload.length);input.write('RIFF',0);input.writeUInt32LE(input.length-8,4);input.write('WAVEfmt ',8);input.writeUInt32LE(16,16);input.writeUInt16LE(1,20);input.writeUInt16LE(channels,22);input.writeUInt32LE(8000,24);input.writeUInt32LE(16000*channels,28);input.writeUInt16LE(channels*2,32);input.writeUInt16LE(16,34);input.write('data',36);input.writeUInt32LE(payload.length,40);payload.copy(input,44);}
  const inputOptions=kind==='raw'?['-f','s16le','-ar','8000','-ac',String(channels)]:[],argv=[...inputOptions,...(guess?[]:['-guess_layout_max','0']),'-i','/input','-c:a','copy','-bitexact','-f',format,'/output'];
  fs.writeFileSync(join(root,'input'),input);const result=spawnSync('.build/reference/ffmpeg',['-v','error','-y',...argv.map(a=>a==='/input'?join(root,'input'):a==='/output'?join(root,'output'):a)],{encoding:'utf8',timeout:15000});if(result.error||result.signal||result.status!==0)throw Error(result.stderr||String(result.error));
  const output=read(join(root,'output'));rows.push({channels,samples,kind,guess,format,argv,input:input.toString('base64'),output:output.toString('base64'),sha256:hash(output),exitCode:result.status});
 }
 verify();if(rows.length!==512)throw Error('Incomplete matrix');const out=explicitOut??'compat/behavior-specs/default-channel-layout';
 const record={sources,librarySha256,oracleBinarySha256:hash(read(binary)),compiler:execFileSync('cc',['--version'],{encoding:'utf8'}),caseCount:512,scope:'All13defaultlayouts returned by fixed Native API across1..65535counts;finite PCM16 raw/WAV streamcopy counts1..32,empty/foursamples,default/disabledguess,WAV/framecrc. No arbitrary-layout or fullcodec certification.'};
 if(target)writePlatformCorpus(target,{'native-layouts.json':{range:[1,65535],layouts},'cases.json':rows,'sources.json':record});
 else{fs.mkdirSync(out,{recursive:true});for(const [name,value] of [['native-layouts.json',{range:[1,65535],layouts}],['cases.json',rows],['provenance.json',{reference,...record}]])fs.writeFileSync(join(out,name),JSON.stringify(value,null,2)+'\n');
 fs.writeFileSync(join(out,'manifest.json'),JSON.stringify({sha256:Object.fromEntries(['native-layouts.json','cases.json','provenance.json'].map(n=>[n,hash(read(join(out,n)))]))},null,2)+'\n');}
 console.log(JSON.stringify({layouts:layouts.length,cases:rows.length,out:target?target.dir:out}));
}finally{fs.rmSync(root,{recursive:true,force:true});}
