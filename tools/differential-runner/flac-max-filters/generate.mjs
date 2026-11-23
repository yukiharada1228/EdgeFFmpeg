// Development-only independent pinned Native evidence; no production imports.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const binary = resolve('.build/reference/ffmpeg');
const binarySha256 = '1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92';
const limit = 512 * 1024;
const generator = 'tools/differential-runner/flac-max-filters/generate.mjs';
const destination = 'compat/behavior-specs/flac-max-filters/cases.json';
const corpusPath = 'compat/behavior-specs/flac-decode-cli/cases.json';
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const reference = JSON.parse(readFileSync('.build/reference/build-metadata.json', 'utf8'));
const lock = JSON.parse(readFileSync('compat/upstream.lock.json', 'utf8'));
assert.equal(sha(readFileSync(binary)), binarySha256, 'Pinned Native binary mismatch');
assert.equal(reference.artifacts.ffmpeg, binarySha256);
assert.equal(reference.commit, lock.commit);
assert.equal(execFileSync('git', ['-C', 'upstream/ffmpeg', 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim(), lock.commit);
const sourcePins = {};
for (const file of ['af_anull.c', 'af_volume.c', 'af_asetrate.c', 'af_aformat.c', 'af_asetnsamples.c', 'af_apad.c']) {
  const path = 'libavfilter/' + file;
  const bytes = readFileSync('upstream/ffmpeg/' + path);
  assert.equal(sha(bytes), sha(execFileSync('git', ['-C', 'upstream/ffmpeg', 'show', lock.commit + ':' + path])));
  sourcePins[path] = sha(bytes);
}
const wasmSha256 = sha(readFileSync('.build/codecs/flac/edge-flac.wasm'));
assert.equal(corpus.binarySha256, binarySha256);
const plans = [];
function add(id, filter, sourceId = '16-2-ramp-5', expectation = 'success', profile = 'supported') {
  plans.push({id, filter, sourceId, expectation, profile});
}
add('anull-16-ramp', 'anull');
add('anull-24-extremes', 'anull', '24-2-extremes-5');
add('anull-32-extremes', 'anull', '32-2-extremes-5');
for (const precision of ['fixed', 'float', 'double']) {
  for (const gain of ['0.5', '0', '2', '6dB']) {
    add('volume-' + gain + '-' + precision, 'volume=' + gain + ':precision=' + precision, '32-2-extremes-5');
  }
}
add('asetrate-half', 'asetrate=4000');
add('asetrate-double-chain', 'asetrate=r=16000,anull');
add('aformat-s16', 'aformat=sample_fmts=s16', '24-2-extremes-5');
add('aformat-fltp', 'aformat=f=fltp', '32-2-extremes-5');
add('aformat-dblp', 'aformat=sample_fmts=dblp', '32-2-extremes-5');
add('asetnsamples-64-unpadded', 'asetnsamples=n=64:p=0');
add('asetnsamples-64-padded', 'asetnsamples=nb_out_samples=64:pad=1');
add('asetnsamples-192-default-pad', 'asetnsamples=192');
add('apad-zero', 'apad=pad_len=0');
add('apad-seven-packets-three', 'apad=pad_len=7:packet_size=3');
add('apad-whole-shorter', 'apad=whole_len=128');
add('apad-whole-longer', 'apad=whole_len=300:packet_size=17');
add('apad-duration', 'apad=pad_dur=0.00025:packet_size=1');
add('apad-whole-duration', 'apad=whole_dur=0.04:packet_size=32');
add('apad-empty', 'apad=pad_len=7:packet_size=3', '16-2-empty-5');
add('invalid-volume-precision', 'volume=0.5:precision=bogus', undefined, 'error', 'invalid-native-grammar');
add('invalid-asetrate-zero', 'asetrate=0', undefined, 'error', 'invalid-native-grammar');
add('invalid-aformat', 'aformat=sample_fmts=bogus', undefined, 'error', 'invalid-native-grammar');
add('invalid-apad-conflict', 'apad=pad_len=1:whole_len=300', undefined, 'error', 'invalid-native-grammar');
const variants = [{id:'pcm', format:'s32le'}, {id:'framecrc', format:'framecrc'}];
const prefix = ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-y', '-threads', '1', '-filter_threads', '1'];
const sources = new Map([...new Set(plans.map(plan => plan.sourceId))].map(id => {
  const row = corpus.rows.find(row => row.id === id + '/s32le');
  assert(row, 'Missing canonical source ' + id);
  const bytes = Buffer.from(row.input, 'base64');
  assert(bytes.length <= limit && sha(bytes) === row.inputSha256);
  assert.equal(bytes.subarray(0, 4).toString(), 'fLaC');
  const word = bytes.readBigUInt64BE(18);
  const descriptor = {streamId:0, codec:'flac', sampleRate:Number(word >> 44n), channels:Number((word >> 41n) & 7n) + 1, bitsPerSample:Number((word >> 36n) & 31n) + 1, totalSamples:Number(word & ((1n << 36n) - 1n)), minBlockSamples:bytes.readUInt16BE(8), maxBlockSamples:bytes.readUInt16BE(10), channelLayout:'stereo'};
  assert.equal(descriptor.channels, 2);
  assert.equal(descriptor.sampleRate, 8000);
  return [id, {row, bytes, descriptor}];
}));
const invocations = plans.flatMap(plan => (plan.expectation === 'error' ? variants.slice(0, 1) : variants).map(variant => ({plan, variant})));
assert.equal(invocations.length, 64);
const argsFor = (plan, variant) => ['-i', '/in.flac', '-map', '0:a:0', '-map_metadata', '-1', '-af', plan.filter, '-c:a', 'pcm_s32le', '-f', variant.format, '-fs', String(limit + 1), '/out'];
const fingerprint = sha(JSON.stringify({version:1, plans, variants, prefix, sourcePins, sources:[...sources].map(([id, source]) => [id, source.row.inputSha256]), binarySha256, wasmSha256}));
function adler(bytes) {
  let a = 0, b = 0;
  for (const value of bytes) { a = (a + value) % 65521; b = (b + a) % 65521; }
  return '0x' + ((b * 65536 + a) >>> 0).toString(16).padStart(8, '0');
}
function validate(data) {
  assert.equal(data.fingerprint, fingerprint);
  assert.equal(data.binarySha256, binarySha256);
  assert.equal(data.wasmSha256, wasmSha256);
  assert.equal(data.rows.length, invocations.length);
  for (const [index, {plan, variant}] of invocations.entries()) {
    const row = data.rows[index], source = sources.get(plan.sourceId);
    assert.equal(row.id, plan.id + '/' + variant.id);
    assert.equal(row.input, source.row.input);
    assert.equal(row.inputSha256, sha(Buffer.from(row.input, 'base64')));
    assert.deepEqual(row.args, argsFor(plan, variant));
    assert.deepEqual(row.selectedStreamIds, [0]);
    assert.deepEqual(row.descriptors, [source.descriptor]);
    assert(Number.isInteger(row.exitCode));
    assert.equal(typeof row.stderr, 'string');
    assert(Buffer.byteLength(row.stderr) <= limit);
    assert.equal(row.expectedOutcome, plan.expectation);
    if (row.output === null) assert.equal(row.outputSha256, null);
    else {
      const bytes = Buffer.from(row.output, 'base64');
      assert(bytes.length <= limit);
      assert.equal(sha(bytes), row.outputSha256);
    }
    if (plan.expectation === 'error') {
      assert.notEqual(row.exitCode, 0, 'Invalid grammar unexpectedly accepted');
      assert(row.stderr.length > 0);
    } else {
      assert.equal(row.exitCode, 0, row.id + ': ' + row.stderr);
      assert.notEqual(row.output, null);
      if (variant.id === 'pcm') assert.equal(Buffer.from(row.output, 'base64').length, row.sampleCount * 8);
      else {
        assert.equal(Buffer.from(row.output, 'base64').toString(), row.framecrc);
        const raw = data.rows.find(candidate => candidate.id === plan.id + '/pcm');
        const bytes = Buffer.from(raw.output, 'base64');
        let offset = 0;
        for (const packet of row.packets) {
          assert.equal(packet.streamId, 0);
          assert.equal(packet.pts, packet.dts);
          assert.equal(packet.bytes, packet.duration * 8);
          assert.equal(packet.checksum, adler(bytes.subarray(offset, offset + packet.bytes)));
          offset += packet.bytes;
        }
        assert.equal(offset, bytes.length);
        assert.equal(row.packets.reduce((total, packet) => total + packet.duration, 0), raw.sampleCount);
      }
    }
  }
}
if (existsSync(destination)) {
  const existing = JSON.parse(readFileSync(destination, 'utf8'));
  if (existing.fingerprint === fingerprint) {
    validate(existing);
    console.log(JSON.stringify({cached:true, nativeCalls:0, rows:existing.rows.length, verified:true}));
    process.exit(0);
  }
}
if (process.argv.includes('--verify')) throw Error('No matching evidence to verify');
mkdirSync('.build/temp', {recursive:true});
const root = mkdtempSync(resolve('.build/temp/flac-max-filters-'));
let nativeCalls = 0;
try {
  const rows = [];
  for (const {plan, variant} of invocations) {
    const source = sources.get(plan.sourceId);
    writeFileSync(join(root, 'in.flac'), source.bytes);
    rmSync(join(root, 'out'), {force:true});
    const args = argsFor(plan, variant);
    const actual = args.map(arg => arg === '/in.flac' ? join(root, 'in.flac') : arg === '/out' ? join(root, 'out') : arg);
    assert(++nativeCalls <= 64);
    const result = spawnSync(binary, [...prefix, ...actual], {encoding:'utf8', timeout:10000, maxBuffer:limit});
    if (result.error || result.status === null) throw result.error ?? Error('Native terminated without exit status');
    assert(Buffer.byteLength(result.stderr) <= limit);
    const exists = existsSync(join(root, 'out'));
    if (exists) assert(statSync(join(root, 'out')).size <= limit, 'Native output bound exceeded');
    const output = exists ? readFileSync(join(root, 'out')) : null;
    const row = {id:plan.id + '/' + variant.id, input:source.row.input, inputSha256:source.row.inputSha256, args, exitCode:result.status, output:output?.toString('base64') ?? null, outputSha256:output === null ? null : sha(output), stderr:result.stderr.replaceAll(root, '<fixture>').replaceAll(/0x[0-9a-f]+/g, '<address>'), filter:plan.filter, expectedOutcome:plan.expectation, grammarProfile:plan.profile, source:{path:corpusPath, rowId:source.row.id, inputSha256:source.row.inputSha256}, selectedStreamIds:[0], descriptors:[source.descriptor]};
    if (variant.id === 'pcm' && output && result.status === 0) {
      assert.equal(output.length % 8, 0);
      row.sampleCount = output.length / 8;
      row.firstSamples = output.length ? [output.readInt32LE(0), output.readInt32LE(4)] : [];
      row.lastSamples = output.length ? [output.readInt32LE(output.length - 8), output.readInt32LE(output.length - 4)] : [];
    }
    if (variant.id === 'framecrc' && output) {
      row.framecrc = output.toString('utf8');
      row.packets = row.framecrc.split('\n').filter(line => /^\d+,/.test(line)).map(line => {
        const fields = line.split(',').map(field => field.trim());
        return {streamId:Number(fields[0]), dts:Number(fields[1]), pts:Number(fields[2]), duration:Number(fields[3]), bytes:Number(fields[4]), checksum:fields[5]};
      });
      row.outputSampleRate = Number(row.framecrc.match(/^#sample_rate 0: (\d+)$/m)?.[1]);
      assert(Number.isInteger(row.outputSampleRate) && row.outputSampleRate > 0);
    }
    rows.push(row);
  }
  const data = {reference, binarySha256, wasmSha256, fingerprint, generator, invocationPrefix:prefix, sourcePins, limits:{nativeCalls:64, maxInputBytes:limit, maxOutputBytes:limit, sequential:true, timeoutMs:10000}, stderrNormalization:['temporary directory replaced by <fixture>', 'hexadecimal runtime addresses replaced by <address>'], rows};
  // Retain actual failures before validation: never disguise Native differences.
  mkdirSync('compat/behavior-specs/flac-max-filters', {recursive:true});
  const temporary = join(root, 'cases.json');
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n');
  renameSync(temporary, destination);
  validate(data);
  console.log(JSON.stringify({nativeCalls, rows:rows.length, successes:rows.filter(row => row.exitCode === 0).length, expectedErrors:rows.filter(row => row.exitCode !== 0).map(row => row.id), verified:true}));
} finally {
  rmSync(root, {recursive:true, force:true});
}
