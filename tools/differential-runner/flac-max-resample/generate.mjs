// Development-only pinned Native oracle; deliberately imports no production helpers.
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const binary = resolve('.build/reference/ffmpeg');
const binarySha256 = '1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92';
const wasmSha256 = sha(readFileSync('.build/codecs/flac/edge-flac.wasm'));
const reference = JSON.parse(readFileSync('.build/reference/build-metadata.json', 'utf8'));
if (sha(readFileSync(binary)) !== binarySha256 || reference.artifacts.ffmpeg !== binarySha256)
  throw Error('Pinned Native binary mismatch');
const corpusPath = 'compat/behavior-specs/flac-decode-cli/cases.json';
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const destination = 'compat/behavior-specs/flac-max-resample/cases.json';
const limit = 512 * 1024;
const rates = [8000, 11025, 16000, 44100, 48000];
const variants = ['s16le', 'wav', 'framecrc'];
const prefix = ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-y', '-threads', '1', '-filter_threads', '1'];
const canonical = id => {
  const row = corpus.rows.find(row => row.id === id + '/s16le');
  if (!row) throw Error('Missing canonical input ' + id);
  const bytes = Buffer.from(row.input, 'base64');
  if (bytes.length > limit || sha(bytes) !== row.inputSha256) throw Error('Canonical input hash/bound mismatch');
  const pcm = Buffer.from(row.output, 'base64');
  if (pcm.length > limit || sha(pcm) !== row.outputSha256) throw Error('Canonical PCM hash/bound mismatch');
  return {row, bytes, pcm};
};
const ramp = canonical('16-2-ramp-5'), empty = canonical('16-2-empty-5');
const fingerprint = sha(JSON.stringify({version:1, rates, variants, prefix, binarySha256, wasmSha256, canonical:[ramp.row.inputSha256, ramp.row.outputSha256, empty.row.inputSha256], preparations:[['short-16-8000',8000,16],['ramp-257-48000',48000,257]]}));
function descriptor(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'fLaC' || (bytes[4] & 127) !== 0) throw Error('Expected FLAC STREAMINFO');
  const word = bytes.readBigUInt64BE(18);
  return {streamId:0, codec:'flac', sampleRate:Number(word >> 44n), channels:Number((word >> 41n) & 7n) + 1, bitsPerSample:Number((word >> 36n) & 31n) + 1, totalSamples:Number(word & ((1n << 36n) - 1n)), minBlockSamples:bytes.readUInt16BE(8), maxBlockSamples:bytes.readUInt16BE(10), channelLayout:'stereo'};
}
function wavPayload(bytes) {
  if (bytes.toString('ascii',0,4) !== 'RIFF' || bytes.toString('ascii',8,12) !== 'WAVE') throw Error('Expected RIFF WAVE');
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + length > bytes.length) throw Error('Truncated WAV chunk');
    if (bytes.toString('ascii',offset,offset+4) === 'data') return bytes.subarray(offset+8,offset+8+length);
    offset += 8 + length + length % 2;
  }
  throw Error('Missing WAV data chunk');
}
function packets(bytes) {
  return bytes.toString('utf8').split('\n').filter(line => /^\d+,/.test(line)).map(line => {
    const fields = line.split(',').map(value => value.trim());
    return {streamId:Number(fields[0]), dts:Number(fields[1]), pts:Number(fields[2]), duration:Number(fields[3]), bytes:Number(fields[4]), checksum:fields[5]};
  });
}
function validate(data) {
  if (data.fingerprint !== fingerprint || data.binarySha256 !== binarySha256 || data.wasmSha256 !== wasmSha256 || data.rows.length !== 60) throw Error('Evidence identity mismatch');
  const ids = new Set();
  for (const row of data.rows) {
    const input = Buffer.from(row.input, 'base64'), output = row.output === null ? null : Buffer.from(row.output, 'base64');
    if (ids.has(row.id)) throw Error('Duplicate case');
    ids.add(row.id);
    if (input.length > limit || sha(input) !== row.inputSha256 || (output !== null && (output.length > limit || sha(output) !== row.outputSha256)) || (output === null && row.outputSha256 !== null)) throw Error('Evidence hash/bound mismatch: ' + row.id);
    if (!Number.isInteger(row.exitCode) || typeof row.stderr !== 'string' || row.args[1] !== '/in.flac' || row.args.at(-1) !== '/out' || JSON.stringify(row.descriptors) !== JSON.stringify([descriptor(input)]) || JSON.stringify(row.selectedStreamIds) !== '[0]') throw Error('Evidence schema mismatch');
    if (row.exitCode !== 0 || output === null) continue;
    const count = row.variant === 'framecrc' ? packets(output).reduce((sum, packet) => sum + packet.duration, 0) : (row.variant === 'wav' ? wavPayload(output) : output).length / 4;
    if (!Number.isInteger(count) || count !== row.sampleCount) throw Error('Sample count mismatch: ' + row.id);
  }
  for (const source of data.sources) {
    const bytes = Buffer.from(source.input, 'base64');
    if (bytes.length > limit || sha(bytes) !== source.inputSha256) throw Error('Prepared source mismatch');
    if (source.preparation) {
      const pcm = Buffer.from(source.preparation.input, 'base64');
      if (sha(pcm) !== source.preparation.inputSha256 || source.preparation.exitCode !== 0 || source.preparation.outputSha256 !== source.inputSha256) throw Error('Preparation evidence mismatch');
    }
    for (const rate of rates) {
      const group = data.rows.filter(row => row.sourceId === source.id && row.outputSampleRate === rate);
      if (group.length !== variants.length) throw Error('Missing output variant');
      if (group.every(row => row.exitCode === 0 && row.output !== null)) {
        const raw = Buffer.from(group.find(row => row.variant === 's16le').output, 'base64');
        const wav = wavPayload(Buffer.from(group.find(row => row.variant === 'wav').output, 'base64'));
        if (!raw.equals(wav) || group.some(row => row.sampleCount !== group[0].sampleCount)) throw Error('Native cross-container difference');
      }
    }
  }
}
if (existsSync(destination)) {
  const existing = JSON.parse(readFileSync(destination, 'utf8'));
  if (existing.fingerprint === fingerprint) {
    validate(existing);
    console.log(JSON.stringify({cached:true,nativeCalls:0,rows:existing.rows.length}));
    process.exit(0);
  }
}
if (process.argv.includes('--verify')) throw Error('No matching evidence to verify');
mkdirSync('.build/temp', {recursive:true});
const root = mkdtempSync(resolve('.build/temp/flac-max-resample-'));
let nativeCalls = 0;
function run(args, inputName, input) {
  if (++nativeCalls > 64 || input.length > limit) throw Error('Native call/input bound exceeded');
  writeFileSync(join(root,inputName),input);
  rmSync(join(root,'out'),{force:true});
  const actual = args.map(arg => arg === '/' + inputName ? join(root,inputName) : arg === '/out' ? join(root,'out') : arg);
  const result = spawnSync(binary,[...prefix,...actual],{encoding:'utf8',timeout:15000,maxBuffer:limit});
  if (result.error || result.status === null) throw result.error ?? Error('Native did not terminate');
  if (existsSync(join(root,'out')) && statSync(join(root,'out')).size > limit) throw Error('Native output exceeds bound');
  const output = existsSync(join(root,'out')) ? readFileSync(join(root,'out')) : null;
  return {args,exitCode:result.status,output:output?.toString('base64') ?? null,outputSha256:output === null ? null : sha(output),stderr:result.stderr.replaceAll(root,'<fixture>').replaceAll(/0x[0-9a-f]+/g,'<address>')};
}
try {
  const sources = [
    {id:'empty-8000', input:empty.row.input, inputSha256:empty.row.inputSha256, provenance:{path:corpusPath,rowId:empty.row.id}},
    {id:'ramp-257-8000', input:ramp.row.input, inputSha256:ramp.row.inputSha256, provenance:{path:corpusPath,rowId:ramp.row.id}},
  ];
  for (const [id,rate,samples] of [['short-16-8000',8000,16],['ramp-257-48000',48000,257]]) {
    // Reinterpret canonical decoded PCM at the requested rate; do not pre-resample it.
    const pcm = ramp.pcm.subarray(0,samples * 4);
    const evidence = run(['-f','s16le','-ar',String(rate),'-ac','2','-i','/in.pcm','-map_metadata','-1','-c:a','flac','-compression_level','5','-f','flac','/out'],'in.pcm',pcm);
    if (evidence.exitCode !== 0 || evidence.output === null) throw Error('Native source preparation failed: ' + evidence.stderr);
    const {output,...preparation} = evidence;
    sources.push({id,input:output,inputSha256:evidence.outputSha256,provenance:{path:corpusPath,rowId:ramp.row.id,canonicalInputSha256:ramp.row.inputSha256,canonicalPcmSha256:ramp.row.outputSha256,pcmSlice:{firstSample:0,sampleCount:samples},rateReinterpretation:true},preparation:{...preparation,input:pcm.toString('base64'),inputSha256:sha(pcm)}});
  }
  const rows = [];
  for (const source of sources) {
    const input = Buffer.from(source.input,'base64'), info = descriptor(input);
    for (const rate of rates) for (const variant of variants) {
      const args = ['-i','/in.flac','-map','0:a:0','-map_metadata','-1','-ar',String(rate),'-c:a','pcm_s16le','-f',variant,'/out'];
      const evidence = run(args,'in.flac',input);
      const row = {id:source.id + '/' + rate + '/' + variant,input:source.input,inputSha256:source.inputSha256,...evidence,sourceId:source.id,source:source.provenance,variant,selectedStreamIds:[0],descriptors:[info],outputSampleRate:rate,direction:rate === info.sampleRate ? 'passthrough' : rate < info.sampleRate ? 'downsample' : 'upsample',eofDrain:true};
      if (evidence.exitCode === 0 && evidence.output !== null) {
        const output = Buffer.from(evidence.output,'base64');
        if (variant === 'framecrc') {
          row.framecrc = output.toString('utf8');
          row.packets = packets(output);
          row.sampleCount = row.packets.reduce((sum,packet) => sum + packet.duration,0);
          row.finalPacketSamples = row.packets.at(-1)?.duration ?? 0;
          row.packetCount = row.packets.length;
        } else {
          const pcm = variant === 'wav' ? wavPayload(output) : output;
          row.sampleCount = pcm.length / 4;
          row.pcmSha256 = sha(pcm);
        }
      }
      rows.push(row);
    }
  }
  const data = {reference,binarySha256,wasmSha256,fingerprint,generator:'tools/differential-runner/flac-max-resample/generate.mjs',invocationPrefix:prefix,limits:{nativeCalls:64,actualNativeCalls:nativeCalls,maxInputBytes:limit,maxOutputBytes:limit,sequential:true},flushObservation:'All CLI runs drain through EOF. Framecrc preserves Native packet boundaries and the final packet sample count; direct swr_convert pre/post-flush counts are not observed.',sources,rows};
  validate(data);
  mkdirSync('compat/behavior-specs/flac-max-resample',{recursive:true});
  const temporary = join(root,'cases.json');
  writeFileSync(temporary,JSON.stringify(data,null,2)+'\n');
  renameSync(temporary,destination);
  console.log(JSON.stringify({nativeCalls,rows:rows.length,successes:rows.filter(row => row.exitCode === 0).length,failures:rows.filter(row => row.exitCode !== 0).map(row => row.id)}));
} finally {
  rmSync(root,{recursive:true,force:true});
}
