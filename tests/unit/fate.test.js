import { it, expect } from 'vitest';
import { inventoryFate } from '../../tools/fate-adapter/parse.mjs';
it('records explicit commands and unresolved sample variables without evaluating shell', () => {
  const cases = inventoryFate('FATE_X += fate-foo\nfate-foo: CMD = framecrc -i $(TARGET_SAMPLES)/foo \\\n -vn\nfate-$(NAME): CMD = ignored\n', 'pcm.mak');
  expect(cases).toHaveLength(1);
  expect(cases[0]).toMatchObject({ id: 'fate-foo', helper: 'framecrc', sampleDependent: true, status: 'unported', command: 'framecrc -i $(TARGET_SAMPLES)/foo   -vn' });
});

import { readFileSync } from 'node:fs';
import { verifyProfile, adaptCommand } from '../../tools/fate-adapter/profile.mjs';
it('verifies the reviewed FATE command, generator/helper dependencies and expected result',()=>{
  const profile=JSON.parse(readFileSync('compat/fate/unknown-layout-pcm.json','utf8'));
  const read=file=>readFileSync(`upstream/ffmpeg/${file}`);
  expect(verifyProfile(profile,read).id).toBe('fate-unknown_layout-pcm');
  expect(()=>verifyProfile({...profile,command:'md5 -i changed'},read)).toThrow('command changed');
  expect(()=>verifyProfile({...profile,md5:'0'.repeat(32)},read)).toThrow('expected result');
  expect(()=>verifyProfile(profile,file=>file==='tests/audiogen.c'?Buffer.from('changed generator'):read(file))).toThrow('dependency changed');
  expect(()=>verifyProfile({...profile,id:'fate-not-reviewed'},read)).toThrow('Unsupported');
});

it('projects the reviewed md5 command to VFS paths without changing media arguments',()=>{
  const profile=JSON.parse(readFileSync('compat/fate/unknown-layout-pcm.json','utf8'));
  expect(adaptCommand(profile,profile.command)).toEqual(profile.edgeArgv);
  expect(()=>adaptCommand(profile,profile.command.replace('-guess_layout_max 0 ',''))).toThrow('projection mismatch');
  expect(()=>adaptCommand(profile,profile.command+'; touch /tmp/no')).toThrow();
  expect(()=>adaptCommand(profile,profile.command.replace('md5','run'))).toThrow('helper');
});

it('verifies and projects the reviewed framecrc helper without dropping frame or filter options',()=>{
  const profile=JSON.parse(readFileSync('compat/fate/asetrate.json','utf8'));
  expect(verifyProfile(profile,file=>readFileSync(`upstream/ffmpeg/${file}`)).id).toBe('fate-filter-asetrate');
  expect(adaptCommand(profile,profile.command)).toEqual(profile.edgeArgv);
  expect(()=>adaptCommand(profile,profile.command.replace('-frames:a 20 ',''))).toThrow('projection mismatch');
  expect(()=>verifyProfile({...profile,expectedOutput:{...profile.expectedOutput,sha256:'0'.repeat(64)}},file=>readFileSync(`upstream/ffmpeg/${file}`))).toThrow('expected result');
});

import {auditAudioCandidates} from '../../tools/fate-adapter/candidates.mjs';
it('triages explicit audio FATE dependencies without dropping unsupported filters or claiming execution',()=>{
  const entries=inventoryFate('fate-ok: CMD = framecrc -i $(SRC) -af anull\nfate-volume: CMD = md5 -i $(SRC) -af aperms=random,volume=0.5\nfate-complex: CMD = framecrc -i $(TARGET_SAMPLES)/x -af "anull,volume=1"\n','tests/fate/filter-audio.mak');
  let compiled=0;const cases=auditAudioCandidates(entries,description=>{compiled++;if(description.includes('aperms'))throw new Error('Unsupported audio filter: aperms=random');return {steps:[{name:'anull'}]};},['fate-ok']);
  expect(compiled).toBe(2);expect(cases[0]).toMatchObject({filterStatus:'accepted-by-compiler',executionStatus:'reviewed-profile-present',blockers:[]});expect(cases[1]).toMatchObject({filterStatus:'unsupported-filter',executionStatus:'not-executed',filter:'aperms=random,volume=0.5'});expect(cases[1].reason).toContain('aperms');expect(cases[2]).toMatchObject({filterStatus:'not-analyzed',sampleDependent:true,executionStatus:'not-executed'});expect(cases[2].blockers).toContain('external sample provenance and availability');
});
it('locks the original finite apad target and projects all media options unchanged',()=>{
  const profile=JSON.parse(readFileSync('compat/fate/apad.json','utf8'));expect(verifyProfile(profile,file=>readFileSync(`upstream/ffmpeg/${file}`)).id).toBe('fate-filter-apad');expect(adaptCommand(profile,profile.command)).toEqual(profile.edgeArgv);expect(()=>adaptCommand(profile,profile.command.replace('pad_len=10','pad_len=9'))).toThrow('projection');
});
