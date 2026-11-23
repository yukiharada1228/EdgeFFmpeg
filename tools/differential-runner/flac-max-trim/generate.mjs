// Development-only independent Native evidence. Never imported by production.
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {preserveSampleEvidence} from './sample-evidence.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const binary = resolve('.build/reference/ffmpeg');
const binarySha256 = '1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92';
const limit = 512 * 1024;
const corpusPath = 'compat/behavior-specs/flac-decode-cli/cases.json';
const destination = 'compat/behavior-specs/flac-max-trim/cases.json';
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const reference = JSON.parse(readFileSync('.build/reference/build-metadata.json', 'utf8'));
const lock = JSON.parse(readFileSync('compat/upstream.lock.json', 'utf8'));
if (sha(readFileSync(binary)) !== binarySha256 || reference.artifacts.ffmpeg !== binarySha256)
  throw Error('Pinned Native binary mismatch');
if (reference.commit !== lock.commit || lock.commit !== '946fcce07b6dcd0331c8cc609192aeff5e1924f8')
  throw Error('Pinned upstream commit mismatch');
const wasmSha256 = sha(readFileSync('.build/codecs/flac/edge-flac.wasm'));
const invocationPrefix = ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-y', '-threads', '1', '-filter_threads', '1'];
const plans = [
  ['baseline', []],
  ['ss-exact-sample', ['-ss', '0.000125']],
  ['ss-before-half', ['-ss', '0.000062']],
  ['ss-half-sample', ['-ss', '0.0000625']],
  ['ss-after-half', ['-ss', '0.000063']],
  ['t-exact-sample', ['-t', '0.000125']],
  ['t-half-sample', ['-t', '0.0000625']],
  ['to-half-sample', ['-to', '0.0000625']],
  ['to-exact-frame', ['-to', '0.024']],
  ['ss-exact-frame', ['-ss', '0.024']],
  ['t-half-after-frame', ['-t', '0.0240625']],
  ['ss-t-cross-frame', ['-ss', '0.023875', '-t', '0.000375']],
  ['ss-to-cross-frame', ['-ss', '0.023875', '-to', '0.02425']],
  ['to-half-after-frame', ['-to', '0.0240625']],
  ['24bit-last-sample', ['-ss', '0.032']],
  ['32bit-t-exact-frame', ['-t', '0.024']],
];
const variants = [
  {id:'packed-raw', codec:'pcm_s32le', format:'s32le', planar:false},
  {id:'planar-raw', codec:'pcm_s32le_planar', format:'s32le', planar:true},
  {id:'packed-framecrc', codec:'pcm_s32le', format:'framecrc', planar:false},
  {id:'planar-framecrc', codec:'pcm_s32le_planar', format:'framecrc', planar:true},
];
const sourceFor = id => id.startsWith('24bit') ? '24-2-extremes-5' : id.startsWith('32bit') ? '32-2-ramp-5' : '16-2-ramp-5';
const sources = new Map([...new Set(plans.map(([id]) => sourceFor(id)))].map(id => {
  const row = corpus.rows.find(row => row.id === id + '/s32le');
  if (!row) throw Error('Missing canonical source ' + id);
  const bytes = Buffer.from(row.input, 'base64');
  const canonical = Buffer.from(row.output, 'base64');
  if (bytes.length > limit || sha(bytes) !== row.inputSha256 || canonical.length > limit || sha(canonical) !== row.outputSha256 || row.exitCode !== 0) throw Error('Invalid canonical source');
  const word = bytes.readBigUInt64BE(18);
  return [id, {row, bytes, descriptor:{streamId:0, codec:'flac', sampleRate:Number(word >> 44n), channels:Number((word >> 41n) & 7n) + 1, bitsPerSample:Number((word >> 36n) & 31n) + 1, totalSamples:Number(word & ((1n << 36n) - 1n)), minBlockSamples:bytes.readUInt16BE(8), maxBlockSamples:bytes.readUInt16BE(10), channelLayout:'stereo'}}];
}));
const fingerprint = sha(JSON.stringify({version:2, plans, variants, invocationPrefix, inputs:[...sources].map(([id, source]) => [id, source.row.inputSha256, source.row.outputSha256]), binarySha256, wasmSha256}));
function adler32(bytes) {
  let a = 0, b = 0;
  for (const value of bytes) { a = (a + value) % 65521; b = (b + a) % 65521; }
  return '0x' + ((b * 65536 + a) >>> 0).toString(16).padStart(8, '0');
}
function validate(data) {
  if (data.fingerprint !== fingerprint || data.binarySha256 !== binarySha256 || data.wasmSha256 !== wasmSha256 || data.rows.length !== plans.length * variants.length) throw Error('Evidence identity mismatch');
  const expectedIds = new Set(plans.flatMap(([boundary]) => variants.map(variant => boundary + '/' + variant.id)));
  for (const row of data.rows) {
    const input = Buffer.from(row.input, 'base64');
    const output = row.output === null ? null : Buffer.from(row.output, 'base64');
    if (input.length > limit || sha(input) !== row.inputSha256 || output && (output.length > limit || sha(output) !== row.outputSha256)) throw Error('Evidence hash/bound mismatch: ' + row.id);
    if (!expectedIds.delete(row.id) || !Number.isInteger(row.exitCode) || typeof row.stderr !== 'string' || Buffer.byteLength(row.stderr) > limit || row.args[1] !== '/in.flac' || row.args.at(-1) !== '/out' || (output === null && row.outputSha256 !== null)) throw Error('Evidence schema mismatch');
    const source = sources.get(sourceFor(row.boundary));
    if (row.inputSha256 !== source.row.inputSha256 || row.source.rowId !== source.row.id || JSON.stringify(row.selectedStreamIds) !== '[0]' || JSON.stringify(row.descriptors) !== JSON.stringify([source.descriptor])) throw Error('Evidence provenance mismatch');
    if (row.variant.endsWith('framecrc') && output && row.framecrc !== output.toString('utf8')) throw Error('Framecrc text mismatch');
  }
  for (const [boundary] of plans) for (const variant of variants.filter(variant => variant.format === 's32le')) {
    const raw = data.rows.find(row => row.id === boundary + '/' + variant.id);
    const crc = data.rows.find(row => row.id === boundary + '/' + (variant.planar ? 'planar-framecrc' : 'packed-framecrc'));
    if (raw.exitCode !== 0 || crc.exitCode !== 0 || raw.output === null) continue;
    const bytes = Buffer.from(raw.output, 'base64');
    let offset = 0;
    for (const packet of crc.packets) {
      if (packet.bytes !== packet.duration * 8 || adler32(bytes.subarray(offset, offset + packet.bytes)) !== packet.checksum) throw Error('Independent raw/framecrc checksum mismatch: ' + raw.id);
      offset += packet.bytes;
    }
    if (offset !== bytes.length || raw.sampleCount * 8 !== bytes.length) throw Error('Raw/framecrc size mismatch');
  }
}
if (existsSync(destination)) {
  const existing = JSON.parse(readFileSync(destination, 'utf8'));
  if (existing.fingerprint === fingerprint) {
    validate(existing);
    const before = JSON.stringify(existing);
    preserveSampleEvidence(existing);
    if (JSON.stringify(existing) !== before) {
      mkdirSync('.build/temp', {recursive:true});
      const temporary = mkdtempSync(resolve('.build/temp/flac-max-trim-enrich-'));
      try {
        writeFileSync(join(temporary, 'cases.json'), JSON.stringify(existing, null, 2) + '\n');
        renameSync(join(temporary, 'cases.json'), destination);
      } finally { rmSync(temporary, {recursive:true, force:true}); }
    }
    console.log(JSON.stringify({cached:true, nativeCalls:0, rows:existing.rows.length}));
    process.exit(0);
  }
}
if (process.argv.includes('--verify')) throw Error('No matching evidence to verify');
mkdirSync('.build/temp', {recursive:true});
const root = mkdtempSync(resolve('.build/temp/flac-max-trim-'));
const rows = [];
try {
  for (const [boundary, options] of plans) {
    const sourceId = sourceFor(boundary), source = sources.get(sourceId);
    writeFileSync(join(root, 'in.flac'), source.bytes);
    for (const variant of variants) {
      const args = ['-i', '/in.flac', '-map', '0:a:0', '-map_metadata', '-1', ...options, '-c:a', variant.codec, '-f', variant.format, '/out'];
      const actual = args.map(arg => arg === '/in.flac' ? join(root, 'in.flac') : arg === '/out' ? join(root, 'out') : arg);
      rmSync(join(root, 'out'), {force:true});
      const result = spawnSync(binary, [...invocationPrefix, ...actual], {encoding:'utf8', timeout:10000, maxBuffer:limit});
      if (result.error || result.status === null) throw result.error ?? Error('Native terminated without exit status');
      if (existsSync(join(root, 'out')) && statSync(join(root, 'out')).size > limit) throw Error('Native output exceeds bound');
      const output = existsSync(join(root, 'out')) ? readFileSync(join(root, 'out')) : null;
      const row = {id:boundary + '/' + variant.id, input:source.row.input, inputSha256:source.row.inputSha256, args, exitCode:result.status, output:output?.toString('base64') ?? null, outputSha256:output === null ? null : sha(output), stderr:result.stderr.replaceAll(root, '<fixture>'), boundary, variant:variant.id, source:{path:corpusPath, rowId:source.row.id, inputSha256:source.row.inputSha256, decodedOutputSha256:source.row.outputSha256}, selectedStreamIds:[0], descriptors:[source.descriptor]};
      if (variant.format === 'framecrc' && output) {
        row.framecrc = output.toString('utf8');
        row.packets = row.framecrc.split('\n').filter(line => /^\d+,/.test(line)).map(line => {
          const fields = line.split(',').map(value => value.trim());
          return {streamId:Number(fields[0]), dts:Number(fields[1]), pts:Number(fields[2]), duration:Number(fields[3]), bytes:Number(fields[4]), checksum:fields[5]};
        });
      }
      rows.push(row);
    }
    for (const planar of [false, true]) {
      const raw = rows.find(row => row.id === boundary + (planar ? '/planar-raw' : '/packed-raw'));
      const crc = rows.find(row => row.id === boundary + (planar ? '/planar-framecrc' : '/packed-framecrc'));
      if (raw.exitCode !== 0 || crc.exitCode !== 0 || raw.output === null) continue;
      const bytes = Buffer.from(raw.output, 'base64'), samples = bytes.length / 8;
      if (!Number.isInteger(samples) || crc.packets.reduce((n, packet) => n + packet.duration, 0) !== samples) throw Error('Raw/framecrc sample count mismatch');
      const interleaved = Buffer.alloc(bytes.length);
      if (!planar) bytes.copy(interleaved);
      else {
        let offset = 0;
        for (const packet of crc.packets) {
          for (let i = 0; i < packet.duration; i++) for (let channel = 0; channel < 2; channel++)
            bytes.copy(interleaved, offset + (i * 2 + channel) * 4, offset + (channel * packet.duration + i) * 4, offset + (channel * packet.duration + i + 1) * 4);
          offset += packet.bytes;
        }
        if (offset !== bytes.length) throw Error('Planar packet byte mismatch');
      }
      raw.sampleCount = samples;
      raw.firstSamples = samples ? [interleaved.readInt32LE(0), interleaved.readInt32LE(4)] : [];
      raw.lastSamples = samples ? [interleaved.readInt32LE(bytes.length - 8), interleaved.readInt32LE(bytes.length - 4)] : [];
      const canonical = Buffer.from(source.row.output, 'base64');
      const start = samples ? canonical.indexOf(interleaved) : -1;
      raw.canonicalSlice = samples ? {firstSample:start / 8, endSampleExclusive:start / 8 + samples, exactMatch:start >= 0 && start % 8 === 0} : null;
      if (samples && !raw.canonicalSlice.exactMatch) throw Error('Trimmed samples are not a canonical contiguous slice');
    }
  }
  const data = {reference, binarySha256, wasmSha256, fingerprint, generator:'tools/differential-runner/flac-max-trim/generate.mjs', invocationPrefix, limits:{nativeCalls:64, maxInputBytes:limit, maxOutputBytes:limit, sequential:true}, rows};
  preserveSampleEvidence(data);
  validate(data);
  mkdirSync('compat/behavior-specs/flac-max-trim', {recursive:true});
  const temporary = join(root, 'cases.json');
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n');
  renameSync(temporary, destination);
  console.log(JSON.stringify({nativeCalls:64, rows:rows.length, successes:rows.filter(row => row.exitCode === 0).length, failures:rows.filter(row => row.exitCode !== 0).map(row => row.id)}));
} finally {
  rmSync(root, {recursive:true, force:true});
}
