// Where a Native corpus generator writes, and what it records, for the pinned reference of the executing host.
// Generators call corpusTarget(base, generator) and then writePlatformCorpus(target, outputs). The target refuses an
// unpinned reference, refuses to write committed evidence from an emulated CPU (Rosetta, QEMU or qemu-user) or, for a
// non-darwin pin, from anywhere but the corpora job of the Linux probe workflow, unless it is a draft, and records the
// provenance docs/contributing/linux-reference.md describes. darwin-arm64 corpora keep their tracked layout and their
// generators' own writers; this library writes only <base>/<id>/ layouts.
import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {cpus,release,version} from 'node:os';
import {dirname,isAbsolute,join,normalize,relative,resolve,sep} from 'node:path';
import {LEGACY_CORPUS_PLATFORM,PINS_FILE,assertRecordedPin,loadReferencePins,localReferenceIdentity,platformCorpusDirFor,sha256,sha256File} from './reference-identity.mjs';

export const PROVENANCE_SCHEMA='edge-ffmpeg/platform-corpus@1';
export const DRAFT_ROOT='.build/linux-green/drafts';
export const DRAFT_ENV='EDGEFFMPEG_CORPUS_DRAFT';
export const IMAGE_ENV='EDGEFFMPEG_CONTAINER_IMAGE';
const reserved=new Set(['manifest.json','provenance.json']);

/**
 * Whether the CPU executing this process is emulated, and why. Linux: /proc/cpuinfo must describe a CPU of the process
 * architecture (x86 vendor_id for x64, CPU implementer for arm64) and not Rosetta (VirtualApple) or QEMU; qemu-user
 * passes the host's cpuinfo through, so an x64 process on an arm64 host shows no x86 vendor. An unreadable cpuinfo is
 * treated as emulated. macOS: a VirtualApple or QEMU model, or an x64 process on an Apple CPU (Rosetta).
 */
export function detectEmulation({platform,arch,cpuinfo='',model=''}){
 if(/VirtualApple|QEMU/i.test(model)||/VirtualApple/i.test(cpuinfo))return `the CPU reports ${/VirtualApple/i.test(model+cpuinfo)?'VirtualApple (Rosetta)':'QEMU'}`;
 if(platform==='linux'){
  if(!cpuinfo.trim())return '/proc/cpuinfo is unreadable, so the CPU cannot be verified';
  if(arch==='x64'&&!/^vendor_id\s*:\s*(GenuineIntel|AuthenticAMD|HygonGenuine)\s*$/m.test(cpuinfo))return 'an x64 process but /proc/cpuinfo names no x86 vendor (qemu-user emulation)';
  if(arch==='arm64'&&!/^CPU implementer\s*:/m.test(cpuinfo))return 'an arm64 process but /proc/cpuinfo names no Arm implementer (emulation)';
  if(arch!=='x64'&&arch!=='arm64')return `no real-hardware check exists for ${arch}`;
 }
 if(platform==='darwin'&&arch==='x64'&&/^Apple\b/.test(model))return 'an x64 process on an Apple CPU (Rosetta)';
 return null;
}
/** CPU and kernel facts of the executing machine; emulated is true under Rosetta (VirtualApple), QEMU or qemu-user. */
export function executionEnvironment(){
 let cpuinfo='';if(process.platform==='linux'){try{cpuinfo=readFileSync('/proc/cpuinfo','utf8');}catch{cpuinfo='';}}
 const model=/^model name\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]?.trim()??cpus()[0]?.model??'unknown';
 const uid=process.getuid?.()??null,emulation=detectEmulation({platform:process.platform,arch:process.arch,cpuinfo,model});
 return {platform:process.platform,arch:process.arch,node:process.version,kernel:release(),kernelVersion:version(),cpuModel:model,emulated:emulation!==null,emulation,uid,unprivileged:uid!==null&&uid!==0};
}
/** The GitHub Actions run executing this process, or null outside one. */
export function ciRecord(env=process.env){
 return env.GITHUB_ACTIONS==='true'?{provider:'github-actions',repository:env.GITHUB_REPOSITORY??null,workflow:env.GITHUB_WORKFLOW??null,job:env.GITHUB_JOB??null,runId:env.GITHUB_RUN_ID??null,runAttempt:env.GITHUB_RUN_ATTEMPT??null,sha:env.GITHUB_SHA??null,ref:env.GITHUB_REF??null,runnerName:env.RUNNER_NAME??null}:null;
}
/** The only workflow and job that may produce committed evidence for a non-darwin pin (.github/workflows/linux-probe.yml). */
export const CORPORA_WORKFLOW='Linux probe';
export const CORPORA_JOB='corpora';
/**
 * Why evidence from this origin cannot be committed, or null. Committed evidence needs a real CPU; for a non-darwin
 * pin it also needs a GitHub Actions run of the corpora job of the Linux probe workflow in the pinned image. Used at
 * write time with the live environment and at verification time with the recorded provenance.
 */
export function committedOriginRefusal({id,tracked,environment,ci,image,pinImage}){
 if(!environment||environment.emulated!==false)return `Refusing ${tracked} as committed evidence from an emulated or unverified CPU (${environment?.cpuModel??'unknown'}${environment?.emulation?`; ${environment.emulation}`:''}); committed ${id} corpora come only from real hardware (the linux-corpora job). Pass --draft to write under ${DRAFT_ROOT}/`;
 if(id===LEGACY_CORPUS_PLATFORM)return null;
 if(ci?.provider!=='github-actions'||!/^\d+$/.test(String(ci?.runId??'')))return `Refusing committed ${id} evidence ${tracked} from outside a GitHub Actions run of the linux-corpora job; pass --draft for a local draft`;
 if(ci.workflow!==CORPORA_WORKFLOW||ci.job!==CORPORA_JOB)return `Refusing committed ${id} evidence ${tracked} from workflow ${JSON.stringify(ci.workflow)} job ${JSON.stringify(ci.job)}; it comes only from the ${CORPORA_JOB} job of the ${CORPORA_WORKFLOW} workflow`;
 if(pinImage&&image!==pinImage)return `${IMAGE_ENV} must name the pinned ${id} image ${pinImage}, got ${image??'nothing'}`;
 return null;
}
/** Why a corpus write must be refused, or null: drafts are always allowed, committed evidence needs committedOriginRefusal to pass. */
export function corpusWriteRefusal({draft,...origin}){return draft?null:committedOriginRefusal(origin);}
const draftRequested=()=>process.argv.includes('--draft')||process.env[DRAFT_ENV]==='1';
const inside=(root,path)=>{const local=relative(root,path);return local===''||!local.startsWith('..')&&!isAbsolute(local);};

/**
 * Resolves where generator `generator` (a path relative to the checkout) writes the corpus whose tracked darwin base is
 * `base` (for example compat/behavior-specs/reference-metadata), and the provenance to record.
 * Options: draft (default: --draft or EDGEFFMPEG_CORPUS_DRAFT=1), root (default: the current directory).
 */
export function corpusTarget(base,generator,{draft=draftRequested(),root=process.cwd()}={}){
 if(typeof base!=='string'||!base.startsWith('compat/behavior-specs/')||normalize(base)!==base.replace(/\/+$/,''))throw new Error(`Corpus base must be a normalized path under compat/behavior-specs/, got ${base}`);
 if(typeof generator!=='string'||isAbsolute(generator)||!existsSync(resolve(root,generator)))throw new Error(`Generator ${generator} must be an existing path relative to the checkout`);
 const identity=localReferenceIdentity(root),pins=loadReferencePins(root),environment=executionEnvironment();
 const legacyLayout=identity.id===LEGACY_CORPUS_PLATFORM,tracked=platformCorpusDirFor(base,identity.id,pins);
 const refusal=corpusWriteRefusal({id:identity.id,tracked,draft,environment,ci:ciRecord(),image:process.env[IMAGE_ENV]??null,pinImage:identity.pin.image??null});
 if(refusal)throw new Error(refusal);
 const dir=draft?join(DRAFT_ROOT,tracked):tracked;
 const provenance={schema:PROVENANCE_SCHEMA,referenceId:identity.id,pin:{file:PINS_FILE,ffmpeg:identity.ffmpeg,ffprobe:identity.ffprobe,source:identity.pin.source,image:identity.pin.image??null},
  reference:identity.metadata,generator:{path:generator,sha256:sha256File(resolve(root,generator))},image:process.env[IMAGE_ENV]??null,environment,ci:ciRecord(),draft,generatedAt:new Date().toISOString()};
 return {id:identity.id,base,dir,draft,legacyLayout,provenance,identity};
}

/**
 * Writes `outputs` ({name: string | Uint8Array | JSON value}) plus manifest.json and provenance.json into target.dir,
 * replacing the directory atomically. Refuses the darwin-arm64 tracked layout.
 */
export function writePlatformCorpus(target,outputs,{root=process.cwd()}={}){
 if(target.legacyLayout&&!target.draft)throw new Error(`${LEGACY_CORPUS_PLATFORM} corpora keep their tracked layout in ${target.base}; write them with the generator's own writer`);
 const names=Object.keys(outputs).sort();if(!names.length)throw new Error('A platform corpus needs at least one output');
 for(const name of names)if(reserved.has(name)||isAbsolute(name)||normalize(name)!==name||name.split(sep).includes('..')||name.includes('/'))throw new Error(`Invalid corpus output name ${name}`);
 const dir=resolve(root,target.dir);if(!inside(resolve(root,target.draft?DRAFT_ROOT:'compat/behavior-specs'),dir))throw new Error(`Refusing to write outside the corpus roots: ${target.dir}`);
 const staged=`${dir}.partial-${process.pid}`,old=`${dir}.old-${process.pid}`;rmSync(staged,{recursive:true,force:true});mkdirSync(staged,{recursive:true});
 const files={};
 for(const name of names){const value=outputs[name],bytes=typeof value==='string'||value instanceof Uint8Array?value:JSON.stringify(value,null,2)+'\n';writeFileSync(join(staged,name),bytes);files[name]=sha256(typeof bytes==='string'?Buffer.from(bytes):bytes);}
 writeFileSync(join(staged,'provenance.json'),JSON.stringify(target.provenance,null,2)+'\n');
 writeFileSync(join(staged,'manifest.json'),JSON.stringify({schema:PROVENANCE_SCHEMA,referenceId:target.id,sha256:{...files,'provenance.json':sha256File(join(staged,'provenance.json'))}},null,2)+'\n');
 mkdirSync(dirname(dir),{recursive:true});if(existsSync(dir))renameSync(dir,old);renameSync(staged,dir);rmSync(old,{recursive:true,force:true});
 return {dir:target.dir,files:Object.keys(files)};
}

/**
 * Verifies a <base>/<id>/ corpus written by writePlatformCorpus: the manifest covers exactly the files present and
 * their hashes, the provenance is not a draft, names the pin `id` and, for committed evidence, passes
 * committedOriginRefusal (real CPU; for a non-darwin pin the corpora job of the Linux probe workflow in the pinned
 * image). Returns the provenance.
 */
export function verifyPlatformCorpusDir(dir,id,{root=process.cwd(),pins=loadReferencePins(root),allowDraft=false}={}){
 const path=resolve(root,dir),read=name=>{try{return JSON.parse(readFileSync(join(path,name),'utf8'));}catch(error){throw new Error(`${dir}/${name} is unreadable (${error.code??error.message})`);}};
 const manifest=read('manifest.json'),provenance=read('provenance.json');
 if(manifest.schema!==PROVENANCE_SCHEMA||provenance.schema!==PROVENANCE_SCHEMA)throw new Error(`${dir} is not a ${PROVENANCE_SCHEMA} corpus`);
 if(manifest.referenceId!==id||provenance.referenceId!==id)throw new Error(`${dir} records reference ${provenance.referenceId}, not ${id}`);
 const present=readdirSync(path).filter(name=>name!=='manifest.json').sort(),listed=Object.keys(manifest.sha256??{}).sort();
 if(JSON.stringify(present)!==JSON.stringify(listed))throw new Error(`${dir} files ${present.join(', ')} differ from its manifest ${listed.join(', ')}`);
 for(const name of listed)if(sha256File(join(path,name))!==manifest.sha256[name])throw new Error(`${dir}/${name} differs from its manifest`);
 if(provenance.draft!==false&&!allowDraft)throw new Error(`${dir} is a draft; committed corpora come only from the linux-corpora job`);
 const pin=assertRecordedPin(provenance,id,pins);
 if(provenance.draft===false){const refusal=committedOriginRefusal({id,tracked:dir,environment:provenance.environment,ci:provenance.ci,image:provenance.image,pinImage:pin.image??null});if(refusal)throw new Error(refusal);}
 if(provenance.pin?.ffmpeg!==provenance.reference?.artifacts?.ffmpeg)throw new Error(`${dir} provenance pin and reference disagree`);
 return provenance;
}
