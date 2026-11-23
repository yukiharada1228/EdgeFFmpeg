// Development-only independent pinned Native evidence; no production imports.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const binary = resolve('.build/reference/ffmpeg');
const binarySha256 = '1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92';
const limit = 512 * 1024;
const destination = 'compat/behavior-specs/flac-max-remix/cases.json';
const generator = 'tools/differential-runner/flac-max-remix/generate.mjs';
const corpusPath = 'compat/behavior-specs/flac-decode-cli/cases.json';
const monoPath = 'compat/behavior-specs/flac-metadata/cases.json';
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const monoCorpus = JSON.parse(readFileSync(monoPath, 'utf8'));
const reference = JSON.parse(readFileSync('.build/reference/build-metadata.json', 'utf8'));
assert.equal(sha(readFileSync(binary)), binarySha256, 'Pinned Native binary mismatch');
assert.equal(reference.artifacts.ffmpeg, binarySha256);
assert.equal(reference.commit, corpus.reference.commit);
const wasmSha256 = sha(readFileSync('.build/codecs/flac/edge-flac.wasm'));
const invocationPrefix = ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-y', '-threads', '1'];
const variants = [
  {id:'s32le', codec:'pcm_s32le', format:'s32le', width:4},
  {id:'f32le', codec:'pcm_f32le', format:'f32le', width:4},
  {id:'s32le-framecrc', codec:'pcm_s32le', format:'framecrc', width:4},
  {id:'f32le-framecrc', codec:'pcm_f32le', format:'framecrc', width:4},
];
const supplement = channels => channels === 2
  ? {id:'s16le', codec:'pcm_s16le', format:'s16le', width:2}
  : {id:'f64le', codec:'pcm_f64le', format:'f64le', width:8};
function descriptor(bytes) {
  assert.equal(bytes.subarray(0, 4).toString(), 'fLaC');
  assert.equal(bytes[4] & 127, 0);
  assert.equal(bytes.readUIntBE(5, 3), 34);
  const word = bytes.readBigUInt64BE(18);
  const channels = Number((word >> 41n) & 7n) + 1;
  return {streamId:0, codec:'flac', sampleRate:Number(word >> 44n), channels,
    bitsPerSample:Number((word >> 36n) & 31n) + 1,
    totalSamples:Number(word & ((1n << 36n) - 1n)),
    minBlockSamples:bytes.readUInt16BE(8), maxBlockSamples:bytes.readUInt16BE(10),
    channelLayout:channels === 1 ? 'mono' : 'stereo'};
}
let sources = [];
for (const bits of [16, 24, 32]) for (const pattern of ['ramp', 'extremes']) {
  const id = `${bits}-2-${pattern}-5`;
  const row = corpus.rows.find(row => row.id === `${id}/s32le`);
  assert(row, `Missing canonical source ${id}`);
  sources.push({id, bits, pattern, channels:2, row, path:corpusPath});
  const monoId = `${bits}-1-${pattern}-5`;
  const monoRow = pattern === 'ramp' ? monoCorpus.rows.find(row => row.id === monoId) : row;
  assert(monoRow, `Missing canonical source ${monoId}`);
  sources.push({id:monoId, bits, pattern, channels:1, row:monoRow,
    path:pattern === 'ramp' ? monoPath : corpusPath, derive:pattern === 'extremes'});
}
const sourceOption = process.argv.find(arg => arg.startsWith('--source='));
if (sourceOption) {
  const id = sourceOption.slice('--source='.length);
  sources = sources.filter(source => source.id === id);
  assert.equal(sources.length, 1, 'Unknown source selection');
}
const expectedRows = sources.length * 5;
const expectedDerivations = sources.filter(source => source.derive).length;
const expectedCalls = expectedRows + expectedDerivations;
for (const source of sources) {
  source.bytes = Buffer.from(source.row.input, 'base64');
  assert(source.bytes.length <= limit);
  assert.equal(sha(source.bytes), source.row.inputSha256);
}
const fingerprint = sha(JSON.stringify({version:1, generatorSha256:sha(readFileSync(generator)),
  binarySha256, wasmSha256, invocationPrefix, variants,
  inputs:sources.map(source => [source.id, source.row.inputSha256, source.derive ?? false]),
  supplements:[supplement(1), supplement(2)]}));
function adler32(bytes) {
  let a = 0, b = 0;
  for (const value of bytes) { a = (a + value) % 65521; b = (b + a) % 65521; }
  return '0x' + ((b * 65536 + a) >>> 0).toString(16).padStart(8, '0');
}
function packets(text) {
  return text.split('\n').filter(line => /^\d+,/.test(line)).map(line => {
    const fields = line.split(',').map(field => field.trim());
    return {streamId:Number(fields[0]), dts:Number(fields[1]), pts:Number(fields[2]),
      duration:Number(fields[3]), bytes:Number(fields[4]), checksum:fields[5]};
  });
}
function validate(data) {
  assert.equal(data.fingerprint, fingerprint);
  assert.equal(data.binarySha256, binarySha256);
  assert.equal(data.wasmSha256, wasmSha256);
  assert.equal(data.rows.length, expectedRows);
  assert.equal(new Set(data.rows.map(row => row.id)).size, expectedRows);
  for (const row of data.rows) {
    const input = Buffer.from(row.input, 'base64');
    const output = row.output === null ? null : Buffer.from(row.output, 'base64');
    assert(input.length <= limit);
    assert.equal(sha(input), row.inputSha256);
    assert.equal(row.outputSha256, output === null ? null : sha(output));
    assert(output === null || output.length <= limit);
    assert(Number.isInteger(row.exitCode));
    assert.equal(typeof row.stderr, 'string');
    assert.deepEqual(row.selectedStreamIds, [0]);
    assert.deepEqual(row.descriptors, [descriptor(input)]);
    assert.equal(row.args[1], '/in.flac');
    assert.equal(row.args.at(-1), '/out');
    assert.equal(row.outputDescriptor.sampleRate, row.descriptors[0].sampleRate);
    if (row.exitCode !== 0) continue; // Native failures remain evidence, never fabricated successes.
    assert(output !== null);
    if (row.format === 'framecrc') {
      assert.equal(row.framecrc, output.toString('utf8'));
      assert.deepEqual(row.packets, packets(row.framecrc));
      const raw = data.rows.find(candidate => candidate.id === row.rawPartner);
      assert(raw && raw.exitCode === 0 && raw.output !== null);
      const rawBytes = Buffer.from(raw.output, 'base64');
      let offset = 0, duration = 0;
      for (const packet of row.packets) {
        assert.equal(packet.streamId, 0);
        assert.equal(packet.pts, duration);
        assert.equal(packet.dts, duration);
        assert.equal(packet.bytes, packet.duration * row.outputDescriptor.channels * 4);
        assert.equal(adler32(rawBytes.subarray(offset, offset + packet.bytes)), packet.checksum);
        offset += packet.bytes;
        duration += packet.duration;
      }
      assert.equal(offset, rawBytes.length);
      assert.equal(duration, row.descriptors[0].totalSamples);
    } else {
      assert.equal(output.length, row.descriptors[0].totalSamples * row.outputDescriptor.channels * row.sampleWidth);
      assert.equal(row.sampleCount, row.descriptors[0].totalSamples);
    }
  }
  assert.equal(data.derivations.length, expectedDerivations);
  for (const derivation of data.derivations) {
    assert.equal(derivation.exitCode, 0);
    const source = sources.find(source => source.id === derivation.id);
    assert(source?.derive);
    assert.equal(derivation.inputSha256, source.row.inputSha256);
    const row = data.rows.find(row => row.sourceId === derivation.id);
    assert.equal(derivation.outputSha256, row.inputSha256);
    assert.equal(derivation.inputDescriptor.channels, 2);
    assert.equal(derivation.outputDescriptor.channels, 1);
    assert.equal(derivation.outputDescriptor.bitsPerSample, source.bits);
    assert.equal(derivation.outputDescriptor.totalSamples, derivation.inputDescriptor.totalSamples);
  }
}
let existing;
if (existsSync(destination)) {
  existing = JSON.parse(readFileSync(destination, 'utf8'));
  if (existing.fingerprint === fingerprint) {
    validate(existing);
    console.log(JSON.stringify({cached:true, nativeCalls:0, rows:existing.rows.length}));
    process.exit(0);
  }
  assert.equal(existing.binarySha256,binarySha256);assert.equal(existing.wasmSha256,wasmSha256);
  for(const row of existing.rows){assert.equal(sha(Buffer.from(row.input,'base64')),row.inputSha256);assert.equal(sha(Buffer.from(row.output,'base64')),row.outputSha256);}
}
if (process.argv.includes('--verify')) throw Error('No matching evidence to verify');
mkdirSync('.build/temp', {recursive:true});
const root = mkdtempSync(resolve('.build/temp/flac-max-remix-'));
let nativeCalls = 0;
function native(input, args) {
  assert(input.length <= limit);
  assert(++nativeCalls <= 64);
  writeFileSync(join(root, 'in.flac'), input);
  rmSync(join(root, 'out'), {force:true});
  const actual = args.map(arg => arg === '/in.flac' ? join(root, 'in.flac') : arg === '/out' ? join(root, 'out') : arg);
  const result = spawnSync(binary, [...invocationPrefix, ...actual], {encoding:'utf8', timeout:10000, maxBuffer:limit});
  if (result.error || result.status === null) throw result.error ?? Error('Native terminated without exit status');
  assert(!existsSync(join(root, 'out')) || statSync(join(root, 'out')).size <= limit);
  const output = existsSync(join(root, 'out')) ? readFileSync(join(root, 'out')) : null;
  return {exitCode:result.status, output, stderr:result.stderr.replaceAll(root, '<fixture>').replaceAll(/0x[0-9a-f]+/g, '<address>')};
}
const rows = [], derivations = [];
let reusedRows=0,reusedDerivations=0;
try {
  for (const source of sources) {
    if (source.derive) {
      const retained=existing?.rows.find(row=>row.sourceId===source.id);
      const derivation=existing?.derivations.find(item=>item.id===source.id&&item.inputSha256===source.row.inputSha256);
      if(retained&&derivation&&derivation.outputSha256===retained.inputSha256){
        assert.equal(derivation.exitCode,0);source.bytes=Buffer.from(retained.input,'base64');
        assert.deepEqual(descriptor(source.bytes),derivation.outputDescriptor);
        derivations.push(derivation);reusedDerivations++;
      }else{
      const args = ['-i', '/in.flac', '-map', '0:a:0', '-map_metadata', '-1', '-af', 'pan=mono|c0=c0',
        '-c:a', 'flac', '-sample_fmt', source.bits === 16 ? 's16' : 's32',
        '-bits_per_raw_sample', String(source.bits), '-strict', 'experimental', '-compression_level', '5', '-f', 'flac', '/out'];
      const result = native(source.bytes, args);
      const derivation = {id:source.id, source:{path:source.path, rowId:source.row.id},
        inputSha256:sha(source.bytes), args, exitCode:result.exitCode,
        outputSha256:result.output === null ? null : sha(result.output), stderr:result.stderr,
        inputDescriptor:descriptor(source.bytes), outputDescriptor:result.output ? descriptor(result.output) : null,
        operation:'Lossless left-channel selection from canonical stereo extrema; no remix used to create mono source.'};
      derivations.push(derivation);
      assert.equal(result.exitCode, 0, result.stderr);
      assert(result.output);
      source.bytes = result.output;
      }
    }
    const inputDescriptor = descriptor(source.bytes), channels = source.channels === 1 ? 2 : 1;
    assert.equal(inputDescriptor.channels, source.channels);
    assert.equal(inputDescriptor.bitsPerSample, source.bits);
    assert.equal(inputDescriptor.sampleRate, 8000);
    assert.equal(inputDescriptor.totalSamples, 257);
    for (const variant of [...variants, supplement(source.channels)]) {
      const args = ['-i', '/in.flac', '-map', '0:a:0', '-map_metadata', '-1', '-ac', String(channels),
        '-ar', String(inputDescriptor.sampleRate), '-c:a', variant.codec, '-f', variant.format, '/out'];
      const retained=existing?.rows.find(row=>row.id===`${source.id}/ac${channels}/${variant.id}`&&row.inputSha256===sha(source.bytes)&&JSON.stringify(row.args)===JSON.stringify(args));
      if(retained){rows.push(retained);reusedRows++;continue;}
      const result = native(source.bytes, args), output = result.output;
      const row = {id:`${source.id}/ac${channels}/${variant.id}`, input:source.bytes.toString('base64'),
        inputSha256:sha(source.bytes), args, exitCode:result.exitCode,
        output:output?.toString('base64') ?? null, outputSha256:output === null ? null : sha(output), stderr:result.stderr,
        sourceId:source.id, pattern:source.pattern, source:{path:source.path, rowId:source.row.id,
          inputSha256:source.row.inputSha256, derivationId:source.derive ? source.id : null},
        selectedStreamIds:[0], descriptors:[inputDescriptor],
        outputDescriptor:{streamId:0, codec:variant.codec, channels, channelLayout:channels === 1 ? 'mono' : 'stereo', sampleRate:inputDescriptor.sampleRate},
        format:variant.format, sampleWidth:variant.width};
      if (variant.format === 'framecrc' && output) {
        row.framecrc = output.toString('utf8');
        row.packets = packets(row.framecrc);
        row.rawPartner = `${source.id}/ac${channels}/${variant.id.replace('-framecrc', '')}`;
      } else if (output && result.exitCode === 0) row.sampleCount = output.length / (channels * variant.width);
      rows.push(row);
    }
  }
  assert.equal(nativeCalls+reusedRows+reusedDerivations, expectedCalls);
  const data = {reference, binarySha256, wasmSha256, fingerprint, generator, invocationPrefix,
    coverage:{complete:!sourceOption, selectedSources:sources.map(source => source.id), plannedFullRows:60},
    limits:{nativeCalls,evidenceCalls:expectedRows-reusedRows,sourceDerivationCalls:expectedDerivations-reusedDerivations,reusedEvidenceRows:reusedRows,reusedSourceDerivations:reusedDerivations,retainedEvidenceRows:expectedRows,retainedSourceDerivations:expectedDerivations,maxInputBytes:limit,maxOutputBytes:limit,sequential:true},
    generationHistory:{priorTaskActualCalls:66,priorDiscardedCalls:60,priorPublishedCalls:6,priorTaskCallCapExceeded:true,continuationActualCalls:nativeCalls,continuationCallCap:64,historicalActualCalls:66+nativeCalls,reusedRows,reusedDerivations},
    scope:'Same-rate default mono/stereo rematrix only. Native evidence, not a production conformance claim.', derivations, rows};
  validate(data);
  mkdirSync('compat/behavior-specs/flac-max-remix', {recursive:true});
  const temporary = join(root, 'cases.json');
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n');
  renameSync(temporary, destination);
  console.log(JSON.stringify({nativeCalls, rows:rows.length, successes:rows.filter(row => row.exitCode === 0).length,
    failures:rows.filter(row => row.exitCode !== 0).map(row => row.id), framecrcPairs:rows.filter(row => row.format === 'framecrc').length}));
} finally { rmSync(root, {recursive:true, force:true}); }
