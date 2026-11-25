import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,describe,expect,it} from 'vitest';
import {pinnedReference} from '../helpers/reference-identity.js';
import {LEGACY_CORPUS_PLATFORM,loadReferencePins,platformCorpusDirFor} from '../../tools/differential-runner/reference-identity.mjs';
import {DRAFT_ROOT,PROVENANCE_SCHEMA,corpusTarget,corpusWriteRefusal,verifyPlatformCorpusDir,writePlatformCorpus} from '../../tools/differential-runner/platform-corpus.mjs';
import type {CorpusTarget} from '../../tools/differential-runner/platform-corpus.mjs';

const specs='compat/behavior-specs',pins=loadReferencePins(),ids=Object.keys(pins.platforms);
const pinnedIds=ids.filter(id=>id!==LEGACY_CORPUS_PLATFORM);
const hashesOf=(id:string)=>Object.values(pins.platforms[id]!.artifacts);
const files=(readdirSync(specs,{recursive:true}) as string[]).map(path=>join(specs,path)).filter(path=>statSync(path).isFile()).sort();
interface Labelled {platform:string;arch:string;artifacts:Record<string,unknown>}
function labelled(value:unknown,found:Labelled[]=[]):Labelled[]{
 if(Array.isArray(value))for(const item of value)labelled(item,found);
 else if(value&&typeof value==='object'){
  const record=value as Partial<Labelled>;if(typeof record.platform==='string'&&typeof record.arch==='string'&&record.artifacts&&typeof record.artifacts==='object')found.push(record as Labelled);
  for(const item of Object.values(value))labelled(item,found);
 }
 return found;
}
const temporary:string[]=[];afterAll(()=>{for(const path of temporary)rmSync(path,{recursive:true,force:true});});

describe('tracked Native evidence is labelled with the platform whose pin produced it',()=>{
 it('every platform-labelled reference record in compat/behavior-specs names that platform\'s pin',()=>{
  let records=0;const wrong:string[]=[];
  for(const path of files.filter(path=>path.endsWith('.json'))){
   const text=readFileSync(path,'utf8');if(!text.includes('"arch"'))continue;
   for(const record of labelled(JSON.parse(text))){
    records++;const id=`${record.platform}-${record.arch}`,pin=pins.platforms[id];
    if(!pin){wrong.push(`${path}: ${id} has no pin`);continue;}
    for(const [name,value]of Object.entries(record.artifacts))if(name in pin.artifacts&&value!==pin.artifacts[name as 'ffmpeg'|'ffprobe'])wrong.push(`${path}: ${id} ${name} ${String(value).slice(0,12)}`);
    if(!('ffmpeg' in record.artifacts))wrong.push(`${path}: ${id} record has no ffmpeg hash`);
   }
  }
  expect(wrong).toEqual([]);expect(records).toBeGreaterThanOrEqual(115);
 });
 it('every per-platform corpus directory is verified real-hardware CI evidence of its own pin only',()=>{
  const directories=files.map(path=>path.split('/')).flatMap(parts=>{const at=parts.findIndex((part,index)=>index>=3&&pinnedIds.includes(part));return at<0?[]:[parts.slice(0,at+1).join('/')];});
  for(const dir of new Set(directories)){
   const id=dir.split('/').at(-1)!,base=dir.slice(0,-id.length-1),pin=pins.platforms[id]!;
   expect(platformCorpusDirFor(base,id,pins)).toBe(dir);
   const provenance=verifyPlatformCorpusDir(dir,id,{pins});
   expect(provenance.environment.emulated,dir).toBe(false);expect(provenance.ci?.runId,dir).toMatch(/^\d+$/);
   expect(provenance.image,dir).toBe(pin.image??null);expect(existsSync(provenance.generator.path),dir).toBe(true);
   const others=ids.filter(other=>other!==id).flatMap(hashesOf);
   for(const name of readdirSync(dir)){const text=readFileSync(join(dir,name),'latin1');for(const other of others)expect(text.includes(other),`${dir}/${name} names another platform's binary`).toBe(false);}
   for(const name of readdirSync(base).filter(name=>!ids.includes(name)&&statSync(join(base,name)).isFile())){
    const text=readFileSync(join(base,name),'latin1');for(const hash of hashesOf(id))expect(text.includes(hash),`${base}/${name} is darwin evidence but names ${id}`).toBe(false);
   }
  }
 });
});

describe('platform corpus writer',()=>{
 const linux=pins.platforms['linux-x64']!,reference={...pinnedReference().metadata,platform:'linux',arch:'x64',artifacts:{...linux.artifacts}};
 function target(change:Partial<CorpusTarget>={}):CorpusTarget{
  const provenance={schema:PROVENANCE_SCHEMA,referenceId:'linux-x64',pin:{file:'compat/reference-pins.json',ffmpeg:linux.artifacts.ffmpeg,ffprobe:linux.artifacts.ffprobe,source:linux.source,image:linux.image??null},reference,
   generator:{path:'tools/differential-runner/reference-metadata/generate.mjs',sha256:'0'.repeat(64)},image:linux.image??null,environment:{platform:'linux',arch:'x64',node:'v24',kernel:'6',kernelVersion:'6',cpuModel:'AMD EPYC',emulated:false,uid:1000,unprivileged:true},ci:null,draft:false,generatedAt:'2026-11-25T00:00:00.000Z'} as const;
  return {id:'linux-x64',base:'compat/behavior-specs/example',dir:'compat/behavior-specs/example/linux-x64',draft:false,legacyLayout:false,provenance,identity:pinnedReference(),...change} as CorpusTarget;
 }
 it('writes outputs with a manifest and provenance that verify, and rejects tampering, drafts and foreign labels',()=>{
  const root=mkdtempSync(join(tmpdir(),'platform-corpus-'));temporary.push(root);
  const written=writePlatformCorpus(target(),{'cases.json':{rows:[1,2]},'raw.bin':new Uint8Array([1,2,3])},{root});
  expect(written).toEqual({dir:'compat/behavior-specs/example/linux-x64',files:['cases.json','raw.bin']});
  const dir=join(root,written.dir);expect(readdirSync(dir).sort()).toEqual(['cases.json','manifest.json','provenance.json','raw.bin']);
  expect(verifyPlatformCorpusDir(written.dir,'linux-x64',{root,pins}).referenceId).toBe('linux-x64');
  expect(()=>verifyPlatformCorpusDir(written.dir,'darwin-arm64',{root,pins})).toThrow('records reference linux-x64, not darwin-arm64');
  writeFileSync(join(dir,'raw.bin'),new Uint8Array([1,2,4]));
  expect(()=>verifyPlatformCorpusDir(written.dir,'linux-x64',{root,pins})).toThrow('raw.bin differs from its manifest');
  writePlatformCorpus(target(),{'cases.json':'{}\n'},{root});writeFileSync(join(dir,'extra.json'),'{}');
  expect(()=>verifyPlatformCorpusDir(written.dir,'linux-x64',{root,pins})).toThrow('differ from its manifest');
  writePlatformCorpus(target({provenance:{...target().provenance,draft:true}}),{'cases.json':'{}\n'},{root});
  expect(()=>verifyPlatformCorpusDir(written.dir,'linux-x64',{root,pins})).toThrow('is a draft');
  const darwin=pins.platforms['darwin-arm64']!;
  writePlatformCorpus(target({provenance:{...target().provenance,reference:{...reference,platform:'darwin',arch:'arm64',artifacts:{...darwin.artifacts}}}}),{'cases.json':'{}\n'},{root});
  expect(()=>verifyPlatformCorpusDir(written.dir,'linux-x64',{root,pins})).toThrow('Corpus records Native reference darwin-arm64, not linux-x64');
 });
 it('refuses to write the darwin tracked layout, reserved names and paths outside the corpus roots',()=>{
  const root=mkdtempSync(join(tmpdir(),'platform-corpus-'));temporary.push(root);
  expect(()=>writePlatformCorpus(target({id:'darwin-arm64',dir:'compat/behavior-specs/example',legacyLayout:true}),{'cases.json':'{}'},{root})).toThrow('darwin-arm64 corpora keep their tracked layout');
  expect(()=>writePlatformCorpus(target(),{'manifest.json':'{}'},{root})).toThrow('Invalid corpus output name manifest.json');
  expect(()=>writePlatformCorpus(target(),{'../x.json':'{}'},{root})).toThrow('Invalid corpus output name');
  expect(()=>writePlatformCorpus(target({dir:'tests/fixtures/x'}),{'cases.json':'{}'},{root})).toThrow('Refusing to write outside the corpus roots');
  expect(existsSync(join(root,'compat'))).toBe(false);
 });
 it('admits committed evidence only from real hardware, and non-darwin evidence only from the CI job and pinned image',()=>{
  const real={emulated:false,cpuModel:'AMD EPYC 7763 64-Core Processor'},rosetta={emulated:true,cpuModel:'VirtualApple @ 2.50GHz'},image=linux.image!;
  const refusal=(input:Partial<Parameters<typeof corpusWriteRefusal>[0]>)=>corpusWriteRefusal({id:'linux-x64',tracked:'compat/behavior-specs/x/linux-x64',draft:false,environment:real,ci:{runId:'1'},image,pinImage:image,...input});
  expect(refusal({})).toBeNull();
  expect(refusal({environment:rosetta})).toContain('Refusing to write compat/behavior-specs/x/linux-x64 on an emulated CPU (VirtualApple @ 2.50GHz)');
  expect(refusal({environment:rosetta,draft:true})).toBeNull();
  expect(refusal({ci:null})).toContain('outside the GitHub linux-corpora job');
  expect(refusal({image:null})).toContain(`must name the pinned linux-x64 image ${image}`);
  expect(refusal({id:'darwin-arm64',ci:null,image:null,pinImage:null})).toBeNull();
  expect(refusal({id:'darwin-arm64',ci:null,image:null,pinImage:null,environment:rosetta})).toContain('emulated CPU');
 });
 it('targets drafts for the local pinned reference and records its provenance',()=>{
  const generator='tools/differential-runner/reference-metadata/generate.mjs',local=pinnedReference(),drafted=corpusTarget('compat/behavior-specs/reference-metadata',generator,{draft:true});
  expect(drafted.id).toBe(local.id);expect(drafted.draft).toBe(true);expect(drafted.legacyLayout).toBe(local.id===LEGACY_CORPUS_PLATFORM);
  expect(drafted.dir).toBe(`${DRAFT_ROOT}/${platformCorpusDirFor('compat/behavior-specs/reference-metadata',local.id,pins)}`);
  expect(drafted.provenance).toMatchObject({schema:PROVENANCE_SCHEMA,referenceId:local.id,reference:local.metadata,draft:true,pin:{ffmpeg:local.ffmpeg,ffprobe:local.ffprobe,source:local.pin.source}});
  expect(drafted.provenance.generator.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(()=>corpusTarget('tests/fixtures',generator,{draft:true})).toThrow('Corpus base must be a normalized path under compat/behavior-specs/');
  expect(()=>corpusTarget('compat/behavior-specs/reference-metadata','tools/absent.mjs',{draft:true})).toThrow('must be an existing path');
 });
});
