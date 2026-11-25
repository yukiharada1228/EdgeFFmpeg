import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {assertCorpusReference,assertRecordedPin,pinnedReference,platformCorpusDir,readPlatformCorpus,referencePin,referencePinIds,requireGeneratedInput,resolvePinnedReference,verifyPinnedLibrary} from '../helpers/reference-identity.js';
import type {BuildMetadata,ReferenceInputs,ReferencePins} from '../helpers/reference-identity.js';
import {loadReferencePins} from '../../tools/differential-runner/reference-identity.mjs';

const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const json=<T>(path:string)=>JSON.parse(readFileSync(path,'utf8')) as T;
const upstream=json<{commit:string;tag:string;configureFile:string}>('compat/upstream.lock.json');
const flags=readFileSync(upstream.configureFile,'utf8').trim().split(/\s+/);
const pins=loadReferencePins();
const darwin=pins.platforms['darwin-arm64']!,linux=pins.platforms['linux-x64']!;

/** Inputs of a consistent linux-x64 build of the pinned commit, as resolvePinnedReference sees them. */
function linuxInputs(change:(inputs:{metadata:BuildMetadata;hashes:{ffmpeg:string;ffprobe:string};host:{platform:string;arch:string};pins:ReferencePins})=>void=()=>{}):ReferenceInputs{
 const metadata:BuildMetadata={artifacts:{...linux.artifacts},commit:upstream.commit,platform:'linux',arch:'x64',flags:[...flags],compiler:linux.compiler,version:'ffmpeg version n9.0.2'};
 const inputs={metadata,hashes:{...linux.artifacts},host:{platform:'linux',arch:'x64'},pins:structuredClone(pins) as ReferencePins};
 change(inputs);return {...inputs,upstream,flags};
}

describe('pinned Native reference identity',()=>{
 it('resolves the local reference to the pin for its own platform',()=>{
  const reference=pinnedReference(),metadata=json<BuildMetadata>('.build/reference/build-metadata.json');
  expect(reference.id).toBe(`${process.platform}-${process.arch}`);
  expect(reference.ffmpeg).toBe(hash('.build/reference/ffmpeg'));expect(reference.ffprobe).toBe(hash('.build/reference/ffprobe'));
  expect(reference.ffmpeg).toBe(referencePin(reference.id).artifacts.ffmpeg);expect(reference.ffprobe).toBe(referencePin(reference.id).artifacts.ffprobe);
  expect(reference.metadata).toEqual(metadata);expect(reference.platform).toBe(metadata.platform);expect(reference.arch).toBe(metadata.arch);
  expect(verifyPinnedLibrary('libavutil/libavutil.a')).toBe(reference.libraries['libavutil/libavutil.a']);
 });
 it('accepts a consistent build of a pinned platform',()=>{
  expect(resolvePinnedReference(linuxInputs())).toMatchObject({id:'linux-x64',ffmpeg:linux.artifacts.ffmpeg,ffprobe:linux.artifacts.ffprobe,libraries:linux.libraries});
 });
 it('rejects a build whose binaries are not the pinned ones',()=>{
  const fake='58295ca5'+'0'.repeat(56);
  expect(()=>resolvePinnedReference(linuxInputs(inputs=>{inputs.metadata={...inputs.metadata,artifacts:{...inputs.metadata.artifacts,ffmpeg:fake}};inputs.hashes.ffmpeg=fake;})))
   .toThrow('Reference linux-x64 ffmpeg 58295ca5… is not the pinned 5e43da9a… (compat/reference-pins.json)');
  expect(()=>resolvePinnedReference(linuxInputs(inputs=>{(inputs.pins.platforms as Record<string,{artifacts:{ffprobe:string}}>)['linux-x64']!.artifacts.ffprobe='f'.repeat(64);})))
   .toThrow('Reference linux-x64 ffprobe 0895f870… is not the pinned ffffffff… (compat/reference-pins.json)');
 });
 it('rejects a platform without a pin instead of falling back to another',()=>{
  expect(()=>resolvePinnedReference(linuxInputs(inputs=>{inputs.metadata={...inputs.metadata,arch:'arm64'};inputs.host={platform:'linux',arch:'arm64'};})))
   .toThrow('No pinned Native reference for linux-arm64 (compat/reference-pins.json)');
  expect(()=>resolvePinnedReference(linuxInputs(inputs=>{delete (inputs.pins.platforms as Record<string,unknown>)['linux-x64'];})))
   .toThrow('No pinned Native reference for linux-x64 (compat/reference-pins.json)');
  expect(()=>referencePin('win32-x64')).toThrow('No pinned Native reference for win32-x64');
 });
 it('rejects inconsistent build metadata, flags, host and binaries',()=>{
  expect(()=>resolvePinnedReference(linuxInputs(inputs=>{inputs.metadata={...inputs.metadata,commit:'0'.repeat(40)};}))).toThrow('not '+upstream.commit);
  expect(()=>resolvePinnedReference(linuxInputs(inputs=>{inputs.metadata={...inputs.metadata,flags:flags.slice(1)};}))).toThrow('flags differ from compat/configure.flags');
  expect(()=>resolvePinnedReference(linuxInputs(inputs=>{inputs.host={platform:'darwin',arch:'arm64'};}))).toThrow('Reference build linux-x64 does not match this host darwin-arm64');
  expect(()=>resolvePinnedReference(linuxInputs(inputs=>{inputs.hashes.ffmpeg='1'.repeat(64);}))).toThrow('differs from build-metadata.json');
  expect(()=>resolvePinnedReference(linuxInputs(inputs=>{(inputs.pins as {commit:string}).commit='0'.repeat(40);}))).toThrow('compat/reference-pins.json records');
 });
 it('maps corpora to the darwin base or a per-platform directory, never a fallback',()=>{
  expect(referencePinIds()).toEqual(['darwin-arm64','linux-x64']);
  expect(platformCorpusDir('compat/behavior-specs/reference-metadata','darwin-arm64')).toBe('compat/behavior-specs/reference-metadata');
  expect(platformCorpusDir('compat/behavior-specs/reference-metadata','linux-x64')).toBe('compat/behavior-specs/reference-metadata/linux-x64');
  expect(()=>platformCorpusDir('compat/behavior-specs/reference-metadata','linux-arm64')).toThrow('No pinned Native reference for linux-arm64');
  expect(()=>readPlatformCorpus('compat/behavior-specs/reference-metadata','cases.json','linux-x64'))
   .toThrow('Missing linux-x64 corpus compat/behavior-specs/reference-metadata/linux-x64; generate it with the linux-corpora job (docs/contributing/linux-reference.md)');
  expect(readPlatformCorpus<unknown[]>('compat/behavior-specs/reference-metadata','cases.json','darwin-arm64')).toHaveLength(336);
 });
 it('checks that a recorded reference names one pin',()=>{
  const recorded={platform:'darwin',arch:'arm64',artifacts:{...darwin.artifacts}};
  expect(assertRecordedPin(recorded,'darwin-arm64').artifacts).toEqual(darwin.artifacts);
  expect(()=>assertRecordedPin(recorded,'linux-x64')).toThrow('Corpus records Native reference darwin-arm64, not linux-x64');
  expect(()=>assertRecordedPin({...recorded,artifacts:{ffmpeg:linux.artifacts.ffmpeg}},'darwin-arm64')).toThrow('Corpus records darwin-arm64 ffmpeg 5e43da9a…, not the pinned 1b86106f…');
  expect(()=>assertRecordedPin({referenceId:'linux-x64',reference:recorded},'darwin-arm64')).toThrow('Corpus provenance names reference linux-x64, not darwin-arm64');
  const local=pinnedReference();
  expect(assertCorpusReference(local.metadata)).toBe(local);
  const other=local.id==='darwin-arm64'?{platform:'linux',arch:'x64',artifacts:{...linux.artifacts}}:recorded;
  expect(()=>assertCorpusReference(other)).toThrow(`not ${local.id}`);
 });
 it('fails with an actionable message when a generated input is missing',()=>{
  expect(()=>requireGeneratedInput('.build/flac-investigation/absent.json','npm run bootstrap -- --only flac-investigation'))
   .toThrow('Missing generated input .build/flac-investigation/absent.json; run npm run bootstrap -- --only flac-investigation');
  expect(requireGeneratedInput('compat/reference-pins.json','unused').length).toBeGreaterThan(0);
 });
});

describe('compat/reference-pins.json',()=>{
 it('pins the locked commit, tag and configure flags',()=>{
  expect({commit:pins.commit,tag:pins.tag,flags:pins.flags}).toEqual({commit:upstream.commit,tag:upstream.tag,flags});
  expect(json<{reference:{pins:string}}>('tools/bootstrap/lock.json').reference.pins).toBe('compat/reference-pins.json');
 });
 it('names, for each pin, a tracked evidence record of the same binaries',()=>{
  const demux=json<{reference:{commit:string;ffmpegSha256:string;ffprobeSha256:string}}>(darwin.source).reference;
  expect(darwin.source).toBe('compat/behavior-specs/mp4-demux/provenance.json');
  expect({commit:demux.commit,ffmpeg:demux.ffmpegSha256,ffprobe:demux.ffprobeSha256}).toEqual({commit:pins.commit,...darwin.artifacts});
  const inverse=json<{reference:BuildMetadata;containerImage:string}>(linux.source);
  expect(linux.source).toBe('compat/behavior-specs/inverse-linux-x64.json');
  expect({platform:inverse.reference.platform,arch:inverse.reference.arch,commit:inverse.reference.commit,flags:inverse.reference.flags,artifacts:inverse.reference.artifacts})
   .toEqual({platform:'linux',arch:'x64',commit:pins.commit,flags,artifacts:linux.artifacts});
  expect(inverse.containerImage).toBe(linux.image);
  expect(inverse.reference.compiler.split('\n')[0]).toBe(linux.compiler);
 });
 it('pins the Linux image that the container lock and every CI job use',()=>{
  const image=json<{image:string}>('compat/reference-container.lock.json').image;
  expect(linux.image).toBe(image);expect(darwin.image).toBeUndefined();
  for(const workflow of ['.github/workflows/ci.yml','.github/workflows/linux-probe.yml']){
   const images=[...readFileSync(workflow,'utf8').matchAll(/(?:image|EDGEFFMPEG_CONTAINER_IMAGE):\s*(\S+)/g)].map(match=>match[1]);
   expect(images.length,workflow).toBeGreaterThan(0);expect(new Set(images),workflow).toEqual(new Set([image]));
  }
 });
 it('records the six oracle link libraries for each platform',()=>{
  const names=['libavcodec','libavfilter','libavformat','libavutil','libswresample','libswscale'].map(name=>`${name}/${name}.a`);
  for(const pin of [darwin,linux])expect(Object.keys(pin.libraries).sort()).toEqual(names);
  expect(darwin.libraries['libavutil/libavutil.a']).toBe(json<{librarySha256:string}>('compat/behavior-specs/default-channel-layout/provenance.json').librarySha256);
 });
});
