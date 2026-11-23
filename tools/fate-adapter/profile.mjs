import { createHash } from 'node:crypto';
import { inventoryFate } from './parse.mjs';
export const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
/** A reviewed adapter profile must still match every locked upstream dependency. */
export function verifyProfile(profile, readSource) {
  if (profile.schemaVersion !== 1 || !['fate-unknown_layout-pcm','fate-filter-asetrate','fate-filter-apad','fate-filter-asetnsamples-pad','fate-filter-asetnsamples-nopad'].includes(profile.id)) throw new Error('Unsupported FATE execution profile');
  for (const [file, expected] of Object.entries(profile.sources)) {
    if (digest(readSource(file)) !== expected) throw new Error(`FATE dependency changed: ${file}`);
  }
  const entries = inventoryFate(readSource(profile.definitionFile).toString(),profile.definitionFile).filter(entry => entry.id === profile.id);
  const normalize = text => text.trim().replace(/\s+/g,' ');
  if (entries.length !== 1 || normalize(entries[0].command) !== profile.command) throw new Error('FATE command changed');
  const reference=readSource(profile.referenceFile);
  if (profile.comparison === 'framecrc') {
    if (digest(reference)!==profile.expectedOutput.sha256 || reference.length!==profile.expectedOutput.bytes) throw new Error('FATE expected result changed');
  } else if (reference.toString().trim() !== profile.md5) throw new Error('FATE expected result changed');
  return entries[0];
}

/** Only reviewed whitespace-tokenized md5/framecrc grammars; no shell evaluation. */
export function adaptCommand(profile, command) {
  const tokens=command.trim().split(/\s+/), helper=tokens.shift();
  const expectedHelper=profile.comparison==='framecrc'?'framecrc':'md5';
  if(helper!==expectedHelper) throw new Error('Unsupported FATE helper');
  const input=profile.inputToken??'$(TARGET_PATH)/$(AREF)';
  const binding=input==='$(SRC)' ? profile.variables.SRC===`$(TARGET_PATH)/${profile.generatorTarget}` : input==='$(TARGET_PATH)/$(AREF)' && profile.variables.AREF===profile.generatorTarget;
  if(tokens.filter(token=>token===input).length!==1 || !binding) throw new Error('Invalid FATE input binding');
  const args=['-y',...tokens.map(token=>token===input?'/input.sw':token),...(helper==='framecrc'?['-bitexact','-f','framecrc']:[]),'/output.sw'];
  if(args.some(token=>/[\$`|;&<>]/.test(token)) || JSON.stringify(args)!==JSON.stringify(profile.edgeArgv)) throw new Error('FATE argv projection mismatch');
  return args;
}
