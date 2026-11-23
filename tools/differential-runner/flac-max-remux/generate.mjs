// Development-only pinned Native evidence; no production imports or fallback.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const limit = 512 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const binarySha256 = '1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92';
const probeSha256 = '9cb672fd23da44c9a1fa5cb6f9255eab4ca3ddbba6d8c94a676b719cf0c87698';
const binary = resolve('.build/reference/ffmpeg'), probe = resolve('.build/reference/ffprobe');
const sourcePath = 'compat/behavior-specs/flac-decode-cli/cases.json';
const destination = 'compat/behavior-specs/flac-max-remux/cases.json';
const generator = 'tools/differential-runner/flac-max-remux/generate.mjs';
const reference = JSON.parse(readFileSync('.build/reference/build-metadata.json', 'utf8'));
assert.equal(sha(readFileSync(binary)), binarySha256);
assert.equal(sha(readFileSync(probe)), probeSha256);
assert.equal(reference.artifacts.ffmpeg, binarySha256);
assert.equal(reference.artifacts.ffprobe, probeSha256);
const wasmSha256 = sha(readFileSync('.build/codecs/flac/edge-flac.wasm'));
const corpus = JSON.parse(readFileSync(sourcePath, 'utf8'));
const sources = new Map();
for (const row of corpus.rows.filter(row => row.id.endsWith('/s32le'))) {
  const bytes = Buffer.from(row.input, 'base64');
  assert(bytes.length <= limit);
  assert.equal(sha(bytes), row.inputSha256);
  sources.set(row.id.split('/')[0], {bytes, provenance:{path:sourcePath, rowId:row.id, inputSha256:row.inputSha256}});
}
function directory(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'fLaC');
  let offset = 4;
  const blocks = [];
  for (;;) {
    assert(offset + 4 <= bytes.length);
    const type = bytes[offset] & 127, last = Boolean(bytes[offset] & 128), length = bytes.readUIntBE(offset + 1, 3);
    assert(offset + 4 + length <= bytes.length);
    const payload = bytes.subarray(offset + 4, offset + 4 + length);
    const block = {type, length, payloadSha256:sha(payload)};
    if (type === 4) {
      let at = 0;
      const text = () => {const size = payload.readUInt32LE(at); at += 4; assert(at + size <= payload.length); const value = payload.toString('utf8', at, at + size); at += size; return value;};
      block.vendor = text();
      const count = payload.readUInt32LE(at); at += 4;
      block.comments = Array.from({length:count}, text);
    }
    blocks.push(block);
    offset += length + 4;
    if (last) return {audioOffset:offset, audioBytes:bytes.length - offset, audioSha256:sha(bytes.subarray(offset)), blocks};
  }
}
// Deterministic metadata-only derivative of canonical clean audio, not an encoder invocation.
const taggedBase = sources.get('16-2-ramp-5');
const baseDirectory = directory(taggedBase.bytes);
const field = text => {const bytes = Buffer.from(text); const size = Buffer.alloc(4); size.writeUInt32LE(bytes.length); return Buffer.concat([size, bytes]);};
const count = Buffer.alloc(4); count.writeUInt32LE(2);
const comment = Buffer.concat([field('independent-remux-fixture'), count, field('TITLE=Remux π'), field('ARTIST=Canonical source')]);
const header = Buffer.alloc(4); header[0] = 0x84; header.writeUIntBE(comment.length, 1, 3);
const tagged = Buffer.concat([taggedBase.bytes.subarray(0, 42), header, comment, taggedBase.bytes.subarray(baseDirectory.audioOffset)]);
sources.set('tagged-16', {bytes:tagged, provenance:{...taggedBase.provenance, transform:'Preserve STREAMINFO and all audio bytes; replace all other metadata with one final Vorbis comment containing vendor independent-remux-fixture, TITLE=Remux π, ARTIST=Canonical source.', canonicalAudioSha256:baseDirectory.audioSha256}});

const plans = [];
for (const source of [...sources.keys()].filter(id => id !== 'tagged-16')) {
  plans.push({id:source + '/default', source, options:[]});
  plans.push({id:source + '/bitexact-stripped', source, options:['-fflags', '+bitexact', '-map_metadata', '-1']});
}
for (const [id, options, extra] of [
  ['short-read-1', [], {inputOptions:['-blocksize', '1']}],
  ['short-read-7', [], {inputOptions:['-blocksize', '7']}],
  ['frames-0', ['-frames:a', '0'], {}],
  ['frames-1', ['-frames:a', '1'], {}],
  ['frames-2', ['-frames:a', '2'], {}],
  ['overwrite-y', [], {overwrite:'-y', existing:true}],
  ['overwrite-n', [], {overwrite:'-n', existing:true}],
  ['duplicate-audio', [], {maps:['0:a:0', '0:a:0']}],
]) plans.push({id, source:'16-2-ramp-5', options, ...extra});
plans.push({id:'tagged/default', source:'tagged-16', options:[]});
plans.push({id:'tagged/bitexact-stripped', source:'tagged-16', options:['-bitexact', '-map_metadata', '-1']});
const invocationPrefix = ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-threads', '1'];
const fingerprint = sha(JSON.stringify({generatorSha256:sha(readFileSync(generator)), binarySha256, probeSha256, wasmSha256, plans, sources:[...sources].map(([id, source]) => [id, sha(source.bytes)])}));
function validate(data) {
  assert.equal(data.fingerprint, fingerprint);
  assert.equal(data.binarySha256, binarySha256);
  assert.equal(data.wasmSha256, wasmSha256);
  assert.equal(data.rows.length, plans.length);
  assert(data.limits.actualNativeCalls <= 64);
  for (const [index, row] of data.rows.entries()) {
    assert.equal(row.id, plans[index].id);
    const input = Buffer.from(row.input, 'base64');
    assert(input.length <= limit); assert.equal(sha(input), row.inputSha256);
    assert(input.equals(sources.get(plans[index].source).bytes));
    if (row.output !== null) {const output = Buffer.from(row.output, 'base64'); assert(output.length <= limit); assert.equal(sha(output), row.outputSha256);}
    else assert.equal(row.outputSha256, null);
    assert(Number.isInteger(row.exitCode)); assert.equal(typeof row.stderr, 'string');
    assert(row.args.includes('/in.flac')); assert.equal(row.args.at(-1), '/out');
    assert(Array.isArray(row.selectedStreamIds)); assert(Array.isArray(row.descriptors));
  }
}
if (existsSync(destination)) {
  const data = JSON.parse(readFileSync(destination, 'utf8'));
  if (data.fingerprint === fingerprint) {validate(data); console.log(JSON.stringify({cached:true, nativeCalls:0, rows:data.rows.length})); process.exit(0);}
}
if (process.argv.includes('--verify')) throw Error('Matching evidence absent; verification never regenerates');
mkdirSync('.build/temp', {recursive:true});
const root = mkdtempSync(resolve('.build/temp/flac-max-remux-'));
let nativeCalls = 0;
const cleanStderr = text => text.replaceAll(root, '<fixture>').replaceAll(/0x[0-9a-f]+/g, '<address>');
function run(executable, args) {
  assert(++nativeCalls <= 64, 'Native call budget exhausted');
  const result = spawnSync(executable, args, {encoding:'utf8', timeout:10000, maxBuffer:limit});
  if (result.error || result.status === null) throw result.error ?? Error('Native terminated without exit status');
  return {exitCode:result.status, stdout:result.stdout, stderr:cleanStderr(result.stderr)};
}
// Independent fixture-only packet boundaries: valid FLAC header CRC8 and complete
// frame CRC16. This does not import the production demuxer or claim decoded PCM.
function crc(bytes, bits, polynomial) {
  let value = 0;
  for (const byte of bytes) {
    value ^= byte << (bits - 8);
    for (let bit = 0; bit < 8; bit++) value = ((value << 1) ^ (value & (1 << (bits - 1)) ? polynomial : 0)) & ((1 << bits) - 1);
  }
  return value;
}
function inspect(bytes) {
  const metadata = directory(bytes), word = bytes.readBigUInt64BE(18);
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
const rows = [], sentinel = Buffer.from('existing-output-must-survive\n');
try {
  // One bounded multi-output invocation observes the valid matrix without
  // re-encoding or rerunning identical input/output data for packet probes.
  const grouped = plans.filter(plan => !['overwrite-y', 'overwrite-n', 'duplicate-audio'].includes(plan.id));
  const batchArgs = [];
  for (const [index, plan] of grouped.entries()) {
    const inputPath = join(root, `input-${index}.flac`);
    writeFileSync(inputPath, sources.get(plan.source).bytes);
    batchArgs.push(...(plan.inputOptions ?? []), '-i', inputPath);
  }
  for (const [index, plan] of grouped.entries()) batchArgs.push('-map', `${index}:a:0`, '-c:a', 'copy', ...(plan.options.includes('-map_metadata') ? [] : ['-map_metadata', String(index)]), ...plan.options, '-f', 'flac', join(root, `output-${index}`));
  const batchResult = run(binary, [...invocationPrefix, '-y', ...batchArgs]);
  assert.equal(batchResult.exitCode, 0, batchResult.stderr);
  for (const plan of plans) {
    const source = sources.get(plan.source), inputProbe = inspect(source.bytes);
    writeFileSync(join(root, 'in.flac'), source.bytes);
    rmSync(join(root, 'out'), {force:true});
    if (plan.existing) writeFileSync(join(root, 'out'), sentinel);
    const maps = plan.maps ?? ['0:a:0'];
    const args = [plan.overwrite ?? '-y', ...(plan.inputOptions ?? []), '-i', '/in.flac', ...maps.flatMap(map => ['-map', map]), '-c:a', 'copy', ...plan.options, '-f', 'flac', '/out'];
    const actual = args.map(arg => arg === '/in.flac' ? join(root, 'in.flac') : arg === '/out' ? join(root, 'out') : arg);
    const groupIndex = grouped.indexOf(plan);
    const result = groupIndex >= 0 ? batchResult : run(binary, [...invocationPrefix, ...actual]);
    if (groupIndex >= 0) renameSync(join(root, `output-${groupIndex}`), join(root, 'out'));
    if (existsSync(join(root, 'out'))) assert(statSync(join(root, 'out')).size <= limit);
    const output = existsSync(join(root, 'out')) ? readFileSync(join(root, 'out')) : null;
    const successfulFlac = result.exitCode === 0 && output !== null && output.toString('ascii', 0, 4) === 'fLaC';
    const outputProbe = successfulFlac ? inspect(output) : null;
    const sourcePackets = inputProbe.packets, outputPackets = outputProbe?.packets ?? [];
    const packetIdentity = packet => [packet.bytes, packet.dataSha256];
    const row = {id:plan.id, input:source.bytes.toString('base64'), inputSha256:sha(source.bytes), args, exitCode:result.exitCode, output:output?.toString('base64') ?? null, outputSha256:output === null ? null : sha(output), stderr:result.stderr, source:source.provenance, selectedStreamIds:maps.map(() => 0), descriptors:inputProbe.descriptors, inputMetadata:directory(source.bytes), inputPackets:sourcePackets, outputProbe, outputMetadata:successfulFlac ? directory(output) : null, exactBytes:{inputEqualsOutput:output?.equals(source.bytes) ?? false, defaultOutputEqualsOutput:null}, semanticPackets:outputProbe === null ? null : {allPacketFieldsEqual:JSON.stringify(sourcePackets) === JSON.stringify(outputPackets), payloadSequenceEqual:JSON.stringify(sourcePackets.map(packetIdentity)) === JSON.stringify(outputPackets.map(packetIdentity)), payloadSequenceIsInputPrefix:outputPackets.length <= sourcePackets.length && JSON.stringify(sourcePackets.slice(0, outputPackets.length).map(packetIdentity)) === JSON.stringify(outputPackets.map(packetIdentity)), inputPacketCount:sourcePackets.length, outputPacketCount:outputPackets.length}, ...(plan.existing ? {existingOutput:sentinel.toString('base64'), existingOutputSha256:sha(sentinel), existingOutputPreserved:output?.equals(sentinel) ?? false} : {}), ...(plan.inputOptions ? {inputReadBoundBytes:Number(plan.inputOptions[1]), shortReadMechanism:'Pinned Native file protocol blocksize caps each file_read call; not a Workers provider test.'} : {})};
    rows.push(row);
  }
  for (const row of rows) {
    const plan = plans.find(plan => plan.id === row.id);
    const baseline = rows.find(candidate => candidate.id === plan.source + '/default' || plan.source === 'tagged-16' && candidate.id === 'tagged/default');
    row.exactBytes.defaultOutputEqualsOutput = baseline ? row.output === baseline.output : null;
  }
  const data = {reference, binarySha256, wasmSha256, probeSha256, fingerprint, generator, invocationPrefix, capture:{groupedRowIds:grouped.map(plan => plan.id), groupedArgv:batchArgs.map(arg => arg.replaceAll(root, '<fixture>')), note:'Grouped rows share one Native invocation and its stderr/exitCode; args on each row are the equivalent isolated virtual command. overwrite and duplicate-stream rows are isolated. Packet interpretation is independent CRC-validated fixture analysis, not ffprobe or PCM decoding.'}, limits:{maxNativeCalls:64, actualNativeCalls:nativeCalls, maxInputBytes:limit, maxOutputBytes:limit, sequential:true}, rows};
  validate(data);
  mkdirSync('compat/behavior-specs/flac-max-remux', {recursive:true});
  writeFileSync(join(root, 'cases.json'), JSON.stringify(data, null, 2) + '\n');
  renameSync(join(root, 'cases.json'), destination);
  console.log(JSON.stringify({nativeCalls, rows:rows.length, successes:rows.filter(row => row.exitCode === 0).length, failures:rows.filter(row => row.exitCode !== 0).map(row => ({id:row.id, exitCode:row.exitCode, stderr:row.stderr})), packetDifferences:rows.filter(row => row.semanticPackets && !row.semanticPackets.payloadSequenceEqual).map(row => row.id)}));
} finally {
  rmSync(root, {recursive:true, force:true});
}
