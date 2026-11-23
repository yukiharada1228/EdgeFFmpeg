// Development-only Native oracle. No production imports or runtime fallback.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const tool = 'tools/differential-runner/flac-max-frames/generate.mjs';
const destination = 'compat/behavior-specs/flac-max-frames/cases.json';
const binary = resolve('.build/reference/ffmpeg');
const binarySha256 = '1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92';
const reference = json('.build/reference/build-metadata.json');
const lock = json('compat/upstream.lock.json');
const wasmSha256 = sha(readFileSync('.build/codecs/flac/edge-flac.wasm'));
const limit = 512 * 1024;
assert.equal(sha(readFileSync(binary)), binarySha256);
assert.equal(reference.artifacts.ffmpeg, binarySha256);
assert.equal(reference.commit, lock.commit);
const sourceFiles = ['libavcodec/flacdec.c', 'libavformat/flacdec.c', 'libavformat/framecrcenc.c'];
const sourcePins = Object.fromEntries(sourceFiles.map(path => {
  const result = spawnSync('git', ['-C', 'upstream/ffmpeg', 'show', `${lock.commit}:${path}`], {maxBuffer:limit});
  assert.equal(result.status, 0);
  const digest = sha(readFileSync('upstream/ffmpeg/' + path));
  assert.equal(digest, sha(result.stdout));
  return [path, digest];
}));
const canonicalPath = 'compat/behavior-specs/flac-decode-cli/cases.json';
const monoPath = 'compat/behavior-specs/flac-metadata/cases.json';
const canonical = json(canonicalPath), mono = json(monoPath);
const sources = [];
for (const bits of [16, 24, 32]) {
  for (const pattern of ['empty', 'ramp', 'extremes']) {
    const id = `${bits}-2-${pattern}-5`;
    sources.push({id, path:canonicalPath, row:canonical.rows.find(row => row.id === id + '/s32le')});
  }
  for (const pattern of ['empty', 'ramp']) {
    const id = `${bits}-1-${pattern}-5`;
    sources.push({id, path:monoPath, row:mono.rows.find(row => row.id === id)});
  }
}
for (const source of sources) {
  assert(source.row, 'Missing canonical source ' + source.id);
  const bytes = Buffer.from(source.row.input, 'base64');
  assert(bytes.length <= limit);
  assert.equal(sha(bytes), source.row.inputSha256);
  assert.equal(bytes.subarray(0, 4).toString(), 'fLaC');
  assert.equal(bytes[4] & 127, 0);
  const word = bytes.readBigUInt64BE(18);
  const bits = Number((word >> 36n) & 31n) + 1;
  const channels = Number((word >> 41n) & 7n) + 1;
  source.descriptor = {streamId:0, mediaType:'audio', codec:'flac', sampleRate:Number(word >> 44n), channels,
    bitsPerSample:bits, totalSamples:Number(word & ((1n << 36n) - 1n)),
    minBlockSamples:bytes.readUInt16BE(8), maxBlockSamples:bytes.readUInt16BE(10),
    channelLayout:channels === 1 ? 'mono' : 'stereo', sampleFormat:bits <= 16 ? 's16' : 's32',
    pcmAlignment:bits <= 16 ? 'signed-16-left-aligned' : 'signed-32-left-aligned',
    pcmShift:bits <= 16 ? 16 - bits : 32 - bits};
}
const plans = sources.flatMap(source => [
  {source, variant:'raw', frames:null}, {source, variant:'framecrc', frames:null},
  {source, variant:'raw', frames:1}, {source, variant:'framecrc', frames:1},
]);
for (const id of ['16-2-ramp-5', '24-2-ramp-5', '32-2-ramp-5', '16-1-ramp-5'])
  plans.push({source:sources.find(source => source.id === id), variant:'raw', frames:0});
assert.equal(plans.length, 64);
const fingerprint = sha(JSON.stringify({version:1, generatorSha256:sha(readFileSync(tool)), binarySha256, wasmSha256,
  sourcePins, plans:plans.map(({source, variant, frames}) => [source.id, source.row.inputSha256, variant, frames])}));
function packets(bytes) {
  return bytes.toString().split('\n').filter(line => /^\d+,/.test(line)).map(line => {
    const fields = line.split(',').map(value => value.trim());
    return {streamId:Number(fields[0]), dts:Number(fields[1]), pts:Number(fields[2]), duration:Number(fields[3]), bytes:Number(fields[4]), checksum:fields[5]};
  });
}
function validate(data) {
  assert.equal(data.fingerprint, fingerprint);
  assert.equal(data.binarySha256, binarySha256);
  assert.equal(data.wasmSha256, wasmSha256);
  assert.equal(data.rows.length, plans.length);
  assert.equal(new Set(data.rows.map(row => row.id)).size, plans.length);
  for (const [index, row] of data.rows.entries()) {
    const plan = plans[index];
    assert.equal(row.id, `${plan.source.id}/${plan.variant}/frames-${plan.frames ?? 'all'}`);
    assert.equal(row.inputSha256, plan.source.row.inputSha256);
    const input = Buffer.from(row.input, 'base64');
    assert(input.length <= limit);
    assert.equal(sha(input), row.inputSha256);
    assert(Number.isInteger(row.exitCode));
    assert.equal(typeof row.stderr, 'string');
    assert.equal(row.args[1], '/in.flac');
    assert.equal(row.args.at(-1), '/out');
    assert.deepEqual(row.selectedStreamIds, [0]);
    assert.deepEqual(row.descriptors, [plan.source.descriptor]);
    if (row.output !== null) {
      const output = Buffer.from(row.output, 'base64');
      assert(output.length <= limit);
      assert.equal(sha(output), row.outputSha256);
      if (plan.variant === 'framecrc') assert.deepEqual(row.packets, packets(output));
    } else assert.equal(row.outputSha256, null);
  }
}
if (existsSync(destination)) {
  const existing = json(destination);
  if (existing.fingerprint === fingerprint) {
    validate(existing);
    console.log(JSON.stringify({cached:true, nativeCalls:0, rows:existing.rows.length}));
    process.exit(0);
  }
}
if (process.argv.includes('--verify')) throw Error('No matching cached evidence');
mkdirSync('.build/temp', {recursive:true});
const temporary = mkdtempSync(resolve('.build/temp/flac-max-frames-'));
const prefix = ['-nostdin', '-hide_banner', '-loglevel', 'info', '-y', '-threads', '1'];
const rows = [];
let calls = 0;
try {
  for (const {source, variant, frames} of plans) {
    const descriptor = source.descriptor;
    const format = descriptor.sampleFormat + 'le';
    const args = ['-i', '/in.flac', '-map', '0:a:0', '-map_metadata', '-1', '-af', 'ashowinfo',
      ...(frames === null ? [] : ['-frames:a', String(frames)]), '-c:a', 'pcm_' + format,
      '-threads:a', '1', '-fs', String(limit + 1), '-f', variant === 'raw' ? format : 'framecrc', '/out'];
    writeFileSync(join(temporary, 'in.flac'), Buffer.from(source.row.input, 'base64'));
    rmSync(join(temporary, 'out'), {force:true});
    assert(++calls <= 64);
    const result = spawnSync(binary, [...prefix, ...args.map(arg => arg === '/in.flac' ? join(temporary, 'in.flac') : arg === '/out' ? join(temporary, 'out') : arg)],
      {encoding:'utf8', maxBuffer:limit, timeout:15000});
    if (result.error || result.status === null) throw result.error ?? Error('Native terminated without exit status');
    if (existsSync(join(temporary, 'out'))) assert(statSync(join(temporary, 'out')).size <= limit);
    const output = existsSync(join(temporary, 'out')) ? readFileSync(join(temporary, 'out')) : null;
    const stderr = result.stderr.replaceAll(temporary, '<fixture>').replaceAll(/0x[0-9a-f]+/g, '<address>').replaceAll(/speed=\s*\S+/g, 'speed=<runtime>').replaceAll(/elapsed=\S+/g, 'elapsed=<runtime>');
    const decodedFrames = [...stderr.matchAll(/n:(\d+) pts:(-?\d+) pts_time:(\S+).*?fmt:(\S+) channels:(\d+) chlayout:(\S+) rate:(\d+) nb_samples:(\d+)/g)].map(match =>
      ({index:Number(match[1]), pts:Number(match[2]), ptsTime:match[3], sampleFormat:match[4], channels:Number(match[5]), channelLayout:match[6], sampleRate:Number(match[7]), samples:Number(match[8])}));
    const row = {id:`${source.id}/${variant}/frames-${frames ?? 'all'}`, input:source.row.input,
      inputSha256:source.row.inputSha256, args, exitCode:result.status, output:output?.toString('base64') ?? null,
      outputSha256:output === null ? null : sha(output), stderr, source:{path:source.path, rowId:source.row.id, inputSha256:source.row.inputSha256},
      selectedStreamIds:[0], descriptors:[descriptor], variant, maxFrames:frames, decodedFrames};
    if (variant === 'framecrc' && output) row.packets = packets(output);
    if (variant === 'raw' && output) {
      const width = descriptor.sampleFormat === 's16' ? 2 : 4;
      row.sampleCount = output.length / (width * descriptor.channels);
      row.pcmStorageBits = width * 8;
      row.firstSamples = Array.from({length:Math.min(output.length / width, 12)}, (_, index) => output.readIntLE(index * width, width));
      row.lastSamples = Array.from({length:Math.min(output.length / width, 12)}, (_, index) => output.readIntLE(output.length - Math.min(output.length / width, 12) * width + index * width, width));
    }
    rows.push(row);
  }
  const differences = [];
  for (const source of sources) for (const frames of [null, 1]) {
    const selected = rows.filter(row => row.source.rowId === source.row.id && row.source.path === source.path && row.maxFrames === frames);
    const raw = selected.find(row => row.variant === 'raw'), crc = selected.find(row => row.variant === 'framecrc');
    if (raw.exitCode || crc.exitCode || raw.output === null || crc.output === null) continue;
    const byteCount = Buffer.from(raw.output, 'base64').length;
    if (crc.packets.reduce((sum, packet) => sum + packet.bytes, 0) !== byteCount) differences.push({sourceId:source.id, frames, reason:'raw/framecrc byte count mismatch'});
    if (crc.packets.reduce((sum, packet) => sum + packet.duration, 0) !== raw.sampleCount) differences.push({sourceId:source.id, frames, reason:'raw/framecrc sample count mismatch'});
    const allRaw = rows.find(row => row.id === `${source.id}/raw/frames-all`);
    if (frames === 1 && allRaw.output !== null && !Buffer.from(allRaw.output, 'base64').subarray(0, byteCount).equals(Buffer.from(raw.output, 'base64')))
      differences.push({sourceId:source.id, frames, reason:'limited output differs from full prefix'});
    raw.packetEvidenceRowId = crc.id;
  }
  const data = {reference, binarySha256, wasmSha256, fingerprint, sourcePins, generator:tool, invocationPrefix:prefix,
    limits:{nativeCalls:calls, maxInputBytes:limit, maxOutputBytes:limit, sequential:true},
    scope:'Pinned Native source-format PCM, frame limits, decoded frame PTS and encoded PCM packet boundaries; no production conformance claim.',
    gaps:['No mono extrema canonical source in selected corpora.', 'No planar PCM request or multichannel coverage.', 'No malformed input or cancellation evidence; production integration and full 22-chapter target remain separate.'],
    differences, rows};
  validate(data);
  mkdirSync('compat/behavior-specs/flac-max-frames', {recursive:true});
  writeFileSync(join(temporary, 'cases.json'), JSON.stringify(data, null, 2) + '\n');
  renameSync(join(temporary, 'cases.json'), destination);
  console.log(JSON.stringify({nativeCalls:calls, rows:rows.length, successes:rows.filter(row => row.exitCode === 0).length,
    failures:rows.filter(row => row.exitCode !== 0).map(row => row.id), differences}));
} finally {
  rmSync(temporary, {recursive:true, force:true});
}
