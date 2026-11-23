// Development-only oracle; independent of all production time/trim helpers.
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const binarySha256 = '1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92';
const binary = resolve('.build/reference/ffmpeg');
const limit = 512 * 1024;
const corpusPath = 'compat/behavior-specs/flac-decode-cli/cases.json';
const destination = 'compat/behavior-specs/flac-max-time/cases.json';
const generator = 'tools/differential-runner/flac-max-time/generate.mjs';
const reference = JSON.parse(readFileSync('.build/reference/build-metadata.json', 'utf8'));
if (sha(readFileSync(binary)) !== binarySha256 || reference.artifacts.ffmpeg !== binarySha256 || reference.commit !== '946fcce07b6dcd0331c8cc609192aeff5e1924f8') throw Error('Pinned Native mismatch');
const wasmSha256 = sha(readFileSync('.build/codecs/flac/edge-flac.wasm'));
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const source = corpus.rows.find(row => row.id === '16-2-ramp-5/s16le');
if (!source) throw Error('Missing canonical clean FLAC source');
const input = Buffer.from(source.input, 'base64');
const canonical = Buffer.from(source.output, 'base64');
if (input.length > limit || sha(input) !== source.inputSha256 || sha(canonical) !== source.outputSha256) throw Error('Canonical source hash/bound mismatch');
const word = input.readBigUInt64BE(18);
const descriptor = {streamId:0, mediaType:'audio', codec:'flac', sampleRate:Number(word >> 44n), channels:Number((word >> 41n) & 7n) + 1, bitsPerSample:Number((word >> 36n) & 31n) + 1, totalSamples:Number(word & ((1n << 36n) - 1n)), minBlockSamples:input.readUInt16BE(8), maxBlockSamples:input.readUInt16BE(10), channelLayout:'stereo', timeBase:{num:1, den:Number(word >> 44n)}};
if (descriptor.channels !== 2 || descriptor.bitsPerSample !== 16 || canonical.length !== descriptor.totalSamples * 4) throw Error('Unexpected canonical PCM geometry');
const plans = [
  ['baseline', [], []],
  ['ss-input', ['-ss','0.008'], []],
  ['ss-output', [], ['-ss','0.008']],
  ['repeat-ss-t-input', ['-ss','0.030','-ss','0.008','-t','0.001','-t','0.010'], []],
  ['repeat-ss-t-output', [], ['-ss','0.030','-ss','0.008','-t','0.001','-t','0.010']],
  ['t-zero-input', ['-t','0'], []],
  ['t-zero-output', [], ['-t','0']],
  ['t-tiny-input', ['-t','0.000001'], []],
  ['t-tiny-output', [], ['-t','0.000001']],
  ['t-negative-input', ['-t','-0.001'], []],
  ['t-negative-output', [], ['-t','-0.001']],
  ['to-zero-input', ['-to','0'], []],
  ['to-zero-output', [], ['-to','0']],
  ['to-negative-input', ['-to','-0.001'], []],
  ['to-negative-output', [], ['-to','-0.001']],
  ['ss-beyond-eof-input', ['-ss','1'], []],
  ['ss-beyond-eof-output', [], ['-ss','1']],
  ['repeat-to-range-input', ['-ss','0.008','-to','0.001','-to','0.025'], []],
  ['repeat-to-range-output', [], ['-ss','0.008','-to','0.001','-to','0.025']],
  ['mixed-input-output', ['-ss','0.008','-t','0.020','-to','0.009'], ['-ss','0.004','-to','0.012']],
  ['negative-t-overridden', ['-t','-1','-t','0.010'], ['-t','-1','-t','0.005']],
];
const variants = [{id:'raw', format:'s16le'}, {id:'wav', format:'wav'}, {id:'framecrc', format:'framecrc'}];
const invocationPrefix = ['-nostdin','-hide_banner','-loglevel','warning','-y','-threads','1'];
const argsFor = (before, after, format) => [...before, '-i','/in.flac','-map','0:a:0','-map_metadata','-1',...after,'-c:a','pcm_s16le','-f',format,'/out'];
const fingerprint = sha(JSON.stringify({version:1, plans, variants, source:source.inputSha256, binarySha256, wasmSha256, invocationPrefix}));
function wavPcm(bytes) {
  if (bytes.toString('ascii',0,4) !== 'RIFF' || bytes.toString('ascii',8,12) !== 'WAVE') throw Error('Invalid WAV header');
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), end = offset + 8 + size;
    if (end > bytes.length) throw Error('Truncated WAV chunk');
    if (bytes.toString('ascii',offset,offset + 4) === 'data') return bytes.subarray(offset + 8,end);
    offset = end + (size & 1);
  }
  throw Error('Missing WAV data');
}
function annotate(row, bytes) {
  if (row.exitCode !== 0 || bytes === null) return;
  if (row.variant === 'framecrc') {
    row.framecrc = bytes.toString('utf8');
    row.packets = row.framecrc.split('\n').filter(line => /^\d+,/.test(line)).map(line => {
      const f = line.split(',').map(value => value.trim());
      return {streamId:Number(f[0]), dts:Number(f[1]), pts:Number(f[2]), duration:Number(f[3]), bytes:Number(f[4]), checksum:f[5]};
    });
    row.sampleCount = row.packets.reduce((n, packet) => n + packet.duration, 0);
    return;
  }
  const pcm = row.variant === 'wav' ? wavPcm(bytes) : bytes;
  if (pcm.length % 4) throw Error('Unaligned PCM');
  row.sampleCount = pcm.length / 4;
  row.pcmSha256 = sha(pcm);
  row.firstSamples = pcm.length ? [pcm.readInt16LE(0), pcm.readInt16LE(2)] : [];
  row.lastSamples = pcm.length ? [pcm.readInt16LE(pcm.length - 4), pcm.readInt16LE(pcm.length - 2)] : [];
  const start = pcm.length ? canonical.indexOf(pcm) : -1;
  row.canonicalSlice = pcm.length ? {firstSample:start / 4, endSampleExclusive:start / 4 + row.sampleCount, exactMatch:start >= 0 && start % 4 === 0} : null;
  if (pcm.length && !row.canonicalSlice.exactMatch) throw Error('Output is not a canonical PCM slice');
}
function validate(data) {
  if (data.fingerprint !== fingerprint || data.binarySha256 !== binarySha256 || data.wasmSha256 !== wasmSha256 || data.rows.length !== plans.length * variants.length) throw Error('Evidence identity mismatch');
  for (const [index, row] of data.rows.entries()) {
    const [id, before, after] = plans[Math.floor(index / variants.length)], variant = variants[index % variants.length];
    const output = row.output === null ? null : Buffer.from(row.output,'base64');
    if (row.id !== id + '/' + variant.id || row.input !== source.input || row.inputSha256 !== source.inputSha256 || JSON.stringify(row.args) !== JSON.stringify(argsFor(before,after,variant.format))) throw Error('Evidence case mismatch');
    if (!Number.isInteger(row.exitCode) || typeof row.stderr !== 'string' || output !== null && (output.length > limit || sha(output) !== row.outputSha256) || output === null && row.outputSha256 !== null) throw Error('Evidence hash/schema/bound mismatch');
    const derived = {exitCode:row.exitCode, variant:variant.id};
    annotate(derived,output);
    for (const key of Object.keys(derived)) if (JSON.stringify(row[key]) !== JSON.stringify(derived[key])) throw Error('Derived evidence mismatch: ' + row.id + '/' + key);
  }
  for (const [id] of plans) {
    const rows = data.rows.filter(row => row.scenario === id), good = rows.filter(row => row.exitCode === 0);
    if (good.length && good.length !== variants.length) throw Error('Format-dependent exit status: ' + id);
    if (good.length && (new Set(good.map(row => row.sampleCount)).size !== 1 || good[0].pcmSha256 !== good[1].pcmSha256)) throw Error('Format-dependent samples: ' + id);
  }
}
if (existsSync(destination)) {
  const existing = JSON.parse(readFileSync(destination,'utf8'));
  if (existing.fingerprint === fingerprint) {
    validate(existing);
    console.log(JSON.stringify({cached:true, nativeCalls:0, rows:existing.rows.length, verified:true}));
    process.exit(0);
  }
  throw Error('Evidence identity changed; refusing implicit Native regeneration');
}
if (process.argv.includes('--verify')) throw Error('No matching captured evidence');
if (plans.length * variants.length > 64) throw Error('Native call budget exceeded');
mkdirSync('.build/temp',{recursive:true});
const root = mkdtempSync(resolve('.build/temp/flac-max-time-'));
const rows = [];
try {
  writeFileSync(join(root,'in.flac'),input);
  for (const [scenario, before, after] of plans) for (const variant of variants) {
    const args = argsFor(before,after,variant.format);
    const actual = args.map(arg => arg === '/in.flac' ? join(root,'in.flac') : arg === '/out' ? join(root,'out') : arg);
    rmSync(join(root,'out'),{force:true});
    const result = spawnSync(binary,[...invocationPrefix,...actual],{encoding:'utf8',timeout:10000,maxBuffer:limit});
    if (result.error || result.status === null) throw result.error ?? Error('Native did not terminate');
    if (existsSync(join(root,'out')) && statSync(join(root,'out')).size > limit) throw Error('Native output exceeds bound');
    const output = existsSync(join(root,'out')) ? readFileSync(join(root,'out')) : null;
    const row = {id:scenario + '/' + variant.id, input:source.input, inputSha256:source.inputSha256, args, exitCode:result.status, output:output?.toString('base64') ?? null, outputSha256:output === null ? null : sha(output), stderr:result.stderr.replaceAll(root,'<fixture>').replaceAll(/0x[0-9a-f]+/g,'<address>'), scenario, variant:variant.id, source:{path:corpusPath,rowId:source.id,inputSha256:source.inputSha256,canonicalPcmSha256:source.outputSha256}, selectedStreamIds:[0], selectionVerified:result.status === 0, descriptors:[descriptor]};
    annotate(row,output);
    rows.push(row);
  }
  const data = {reference,binarySha256,wasmSha256,fingerprint,generator,invocationPrefix,limits:{nativeCalls:rows.length,maxInputBytes:limit,maxOutputBytes:limit,sequential:true},rows};
  validate(data);
  mkdirSync('compat/behavior-specs/flac-max-time',{recursive:true});
  const temporary = join(root,'cases.json');
  writeFileSync(temporary,JSON.stringify(data,null,2) + '\n');
  renameSync(temporary,destination);
  console.log(JSON.stringify({nativeCalls:rows.length,rows:rows.length,successes:rows.filter(row => row.exitCode === 0).length,failures:rows.filter(row => row.exitCode !== 0).map(row => row.id)}));
} finally {
  rmSync(root,{recursive:true,force:true});
}
