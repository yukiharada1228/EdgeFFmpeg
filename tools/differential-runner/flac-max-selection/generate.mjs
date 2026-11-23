// Development-only pinned Native evidence; no production helper imports.
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const binary = resolve('.build/reference/ffmpeg');
const binarySha256 = '1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92';
const reference = JSON.parse(readFileSync('.build/reference/build-metadata.json', 'utf8'));
const limit = 512 * 1024;
const destination = 'compat/behavior-specs/flac-max-selection/cases.json';
const generator = 'tools/differential-runner/flac-max-selection/generate.mjs';
if (sha(readFileSync(binary)) !== binarySha256 || reference.artifacts.ffmpeg !== binarySha256 || reference.commit !== '946fcce07b6dcd0331c8cc609192aeff5e1924f8') throw Error('Pinned Native reference mismatch');
const wasmSha256 = sha(readFileSync('.build/codecs/flac/edge-flac.wasm'));
const corpusPath = 'compat/behavior-specs/flac-decode-cli/cases.json';
const picturePath = 'compat/behavior-specs/flac-pictures/native-pictures.json';
const canonical = JSON.parse(readFileSync(corpusPath, 'utf8')).rows.find(row => row.id === '16-2-extremes-5/s16le');
if (!canonical) throw Error('Missing canonical audio source');
const audio = Buffer.from(canonical.input, 'base64');
if (audio.length > limit || sha(audio) !== canonical.inputSha256) throw Error('Canonical input hash/bound mismatch');
const pictures = JSON.parse(readFileSync(picturePath, 'utf8')).rows;
const blocks = [];
let at = 4;
if (audio.toString('ascii', 0, 4) !== 'fLaC') throw Error('Expected native FLAC');
for (;;) {
  if (at + 4 > audio.length) throw Error('Truncated metadata');
  const type = audio[at] & 127, end = at + 4 + audio.readUIntBE(at + 1, 3);
  if (end > audio.length) throw Error('Truncated metadata payload');
  blocks.push({type, payload:audio.subarray(at + 4, end)});
  const last = audio[at] & 128;
  at = end;
  if (last) break;
}
function block(type, payload, last) {
  const header = Buffer.alloc(4);
  header[0] = type | (last ? 128 : 0);
  header.writeUIntBE(payload.length, 1, 3);
  return Buffer.concat([header, payload]);
}
function addPicture(id, transport) {
  const fixture = pictures.find(row => row.id === id && row.transport === transport && row.policy === 'default');
  if (!fixture) throw Error('Missing saved picture fixture');
  const payload = Buffer.from(fixture.payload, 'base64');
  if (sha(payload) !== fixture.payloadSha256) throw Error('Saved picture payload hash mismatch');
  const metadata = blocks.map(entry => ({...entry}));
  if (transport === 'block') metadata.push({type:6, payload});
  else {
    const comment = metadata.find(entry => entry.type === 4);
    if (!comment) throw Error('Canonical Vorbis comment required');
    const old = comment.payload, countAt = 4 + old.readUInt32LE(0);
    const prefix = Buffer.from(old);
    prefix.writeUInt32LE(old.readUInt32LE(countAt) + 1, countAt);
    const value = Buffer.from('METADATA_BLOCK_PICTURE=' + payload.toString('base64'));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(value.length);
    comment.payload = Buffer.concat([prefix, length, value]);
  }
  return {id:transport + '-' + id, bytes:Buffer.concat([Buffer.from('fLaC'), ...metadata.map((entry, index) => block(entry.type, entry.payload, index === metadata.length - 1)), audio.subarray(at)]), source:{path:corpusPath, rowId:canonical.id, inputSha256:canonical.inputSha256, picture:{path:picturePath, id, transport, policy:'default', payloadSha256:fixture.payloadSha256}, transformation:transport === 'block' ? 'Append saved encoded PICTURE block; preserve canonical audio frames and existing metadata' : 'Append METADATA_BLOCK_PICTURE base64 comment; preserve canonical audio frames and other comments'}};
}
const sources = [
  {id:'audio', bytes:audio, source:{path:corpusPath, rowId:canonical.id, inputSha256:canonical.inputSha256, transformation:'unchanged'}},
  addPicture('bmp', 'block'),
  addPicture('png', 'comment'),
];
const plans = [
  ['automatic', []],
  ['V-optional', ['0:V?']],
  ['V-required', ['0:V']],
  ['metadata-title-cover', ['0:m:title:cover']],
  ['metadata-encoder-question', ['0:m:encoder?']],
  ['metadata-encoder', ['0:m:encoder']],
  ['disposition-picture', ['0:disp:attached_pic']],
  ['disposition-picture-optional', ['0:disp:attached_pic?']],
  ['all-minus-V-optional', ['0', '-0:V?']],
  ['all-minus-cover', ['0', '-0:m:title:cover']],
  ['all-minus-encoder-question', ['0', '-0:m:encoder?']],
  ['all-minus-picture', ['0', '-0:disp:attached_pic']],
  ['negative-picture-first-optional', ['-0:disp:attached_pic?']],
  ['negative-picture-first-required', ['-0:disp:attached_pic']],
  ['cover-then-audio', ['0:m:title:cover', '0:a']],
  ['audio-plus-V-optional', ['0:a', '0:V?']],
  ['picture-remove-then-audio', ['0:disp:attached_pic?', '-0:disp:attached_pic?', '0:a']],
  ['duplicate-picture-minus-cover', ['0:v?', '0:v?', '-0:m:title:cover', '0:a']],
  ['metadata-cover-question', ['0:m:title:cover?']],
  ['all-minus-picture-then-picture', ['0', '-0:disp:attached_pic?', '0:disp:attached_pic?']],
];
const invocationPrefix = ['-nostdin', '-hide_banner', '-loglevel', 'info', '-y', '-threads', '1'];
const fingerprint = sha(JSON.stringify({generatorSha256:sha(readFileSync(generator)), binarySha256, wasmSha256, plans, sources:sources.map(source => [source.id, sha(source.bytes)])}));
function validate(data) {
  if (data.fingerprint !== fingerprint || data.rows.length !== sources.length * plans.length || data.binarySha256 !== binarySha256 || data.wasmSha256 !== wasmSha256) throw Error('Evidence identity mismatch');
  for (const row of data.rows) {
    const source = sources.find(source => source.id === row.sourceId);
    const input = Buffer.from(row.input, 'base64'), output = row.output === null ? null : Buffer.from(row.output, 'base64');
    if (!source || !input.equals(source.bytes) || input.length > limit || sha(input) !== row.inputSha256 || output !== null && (output.length > limit || sha(output) !== row.outputSha256) || output === null && row.outputSha256 !== null) throw Error('Evidence hash/bound mismatch: ' + row.id);
    if (!Number.isInteger(row.exitCode) || row.args[1] !== '/in.flac' || row.args.at(-1) !== '/out' || typeof row.stderr !== 'string') throw Error('Evidence schema mismatch');
    if (!Array.isArray(row.selectedStreamIds) || !Array.isArray(row.descriptors) || row.descriptors.length !== (source.id === 'audio' ? 1 : 2)) throw Error('Missing Native descriptor evidence: ' + row.id);
    if (row.exitCode === 0 && (output === null || !row.selectedStreamIds.length || !output.toString('utf8').includes('#software:'))) throw Error('Missing successful Native output/mapping');
    if (row.selectedStreamIds.some(id => !row.descriptors.some(descriptor => descriptor.streamId === id))) throw Error('Mapping references unknown input stream');
  }
}
if (existsSync(destination)) {
  const existing = JSON.parse(readFileSync(destination, 'utf8'));
  if (existing.fingerprint === fingerprint) {
    validate(existing);
    console.log(JSON.stringify({cached:true, nativeCalls:0, rows:existing.rows.length}));
    process.exit(0);
  }
  throw Error('Existing evidence differs: refusing automatic Native regeneration');
}
if (process.argv.includes('--verify')) throw Error('No matching saved evidence');
mkdirSync('.build/temp', {recursive:true});
const root = mkdtempSync(resolve('.build/temp/flac-max-selection-'));
const rows = [];
try {
  for (const source of sources) {
    if (source.bytes.length > limit) throw Error('Input exceeds bound');
    writeFileSync(join(root, 'in.flac'), source.bytes);
    for (const [id, maps] of plans) {
      const args = ['-i', '/in.flac', ...maps.flatMap(map => ['-map', map]), '-map_metadata', '-1', '-c', 'copy', '-f', 'framecrc', '/out'];
      rmSync(join(root, 'out'), {force:true});
      const actual = args.map(arg => arg === '/in.flac' ? join(root, 'in.flac') : arg === '/out' ? join(root, 'out') : arg);
      const result = spawnSync(binary, [...invocationPrefix, ...actual], {encoding:'utf8', timeout:10000, maxBuffer:limit});
      if (result.error || result.status === null) throw result.error ?? Error('Native did not terminate with an exit code');
      if (existsSync(join(root, 'out')) && statSync(join(root, 'out')).size > limit) throw Error('Native output exceeds bound');
      const output = existsSync(join(root, 'out')) ? readFileSync(join(root, 'out')) : null;
      const stderr = result.stderr.replaceAll(root, '<fixture>').replaceAll(/0x[0-9a-f]+/g, '<address>');
      const inputLog = stderr.split(/Stream mapping:|Output #/)[0];
      const descriptors = [...inputLog.matchAll(/^\s*Stream #0:(\d+)[^\n]*: (Audio|Video): ([^\n]+)/gm)].map(match => {
        const end = inputLog.slice(match.index + match[0].length).search(/^\s*Stream #|^\[/m);
        const tail = inputLog.slice(match.index + match[0].length, end < 0 ? undefined : match.index + match[0].length + end);
        const metadata = Object.fromEntries([...tail.matchAll(/^\s{6,}([\w]+)\s*:\s*(.*)$/gm)].map(tag => [tag[1], tag[2].trim()]));
        return {streamId:Number(match[1]), mediaType:match[2].toLowerCase(), codec:match[3].split(/[ ,]/)[0], attachedPicture:match[3].includes('(attached pic)'), metadata, nativeDescription:match[0].trim()};
      });
      const selectedStreamIds = [...stderr.matchAll(/Stream #0:(\d+) -> #0:\d+/g)].map(match => Number(match[1]));
      rows.push({id:source.id + '/' + id, sourceId:source.id, input:source.bytes.toString('base64'), inputSha256:sha(source.bytes), args, exitCode:result.status, output:output?.toString('base64') ?? null, outputSha256:output === null ? null : sha(output), stderr, maps, selectedStreamIds, selectionEvidence:'Native Stream mapping log, in output order; empty on pre-mapping failure (not a prediction of hypothetical selection)', descriptors, source:source.source});
    }
  }
  const data = {reference, binarySha256, wasmSha256, fingerprint, generator, invocationPrefix, limits:{nativeCalls:60, sequential:true, maxInputBytes:limit, maxOutputBytes:limit, maxCapturedLogBytes:limit, timeoutMs:10000}, status:'independent-native-evidence-not-production-conformance', rows};
  validate(data);
  mkdirSync('compat/behavior-specs/flac-max-selection', {recursive:true});
  const temporary = join(root, 'cases.json');
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n');
  renameSync(temporary, destination);
  console.log(JSON.stringify({nativeCalls:rows.length, rows:rows.length, successes:rows.filter(row => row.exitCode === 0).length, failures:rows.filter(row => row.exitCode !== 0).map(row => ({id:row.id, exitCode:row.exitCode})), selections:rows.filter(row => row.exitCode === 0).map(row => ({id:row.id, selected:row.selectedStreamIds}))}));
} finally {
  rmSync(root, {recursive:true, force:true});
}
