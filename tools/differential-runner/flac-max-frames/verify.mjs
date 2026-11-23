// Offline development evidence checks; never invokes Native or production APIs.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const data = json('compat/behavior-specs/flac-max-frames/cases.json');
assert.equal(data.rows.length, 64);
assert.equal(data.binarySha256, '1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');
assert.equal(data.limits.nativeCalls, 64);
assert.deepEqual(data.differences, []);
const coverage = new Set();
let rawChecks = 0, checksumChecks = 0;
function adler(bytes) {
  let a = 0, b = 0;
  for (const byte of bytes) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  return '0x' + ((b * 65536 + a) >>> 0).toString(16).padStart(8, '0');
}
for (const row of data.rows) {
  assert.equal(row.exitCode, 0, row.id + ': ' + row.stderr);
  const input = Buffer.from(row.input, 'base64'), output = Buffer.from(row.output, 'base64');
  assert(input.length <= 512 * 1024 && output.length <= 512 * 1024);
  assert.equal(sha(input), row.inputSha256);
  assert.equal(sha(output), row.outputSha256);
  const descriptor = row.descriptors[0];
  coverage.add(`${descriptor.bitsPerSample}/${descriptor.channels}`);
  assert.deepEqual(row.selectedStreamIds, [0]);
  let pts = 0;
  for (const frame of row.decodedFrames) {
    assert.equal(frame.pts, pts);
    assert.equal(frame.sampleFormat, descriptor.sampleFormat);
    assert.equal(frame.channels, descriptor.channels);
    assert.equal(frame.sampleRate, descriptor.sampleRate);
    pts += frame.samples;
  }
  if (row.maxFrames === null) assert.equal(pts, descriptor.totalSamples);
  if (row.variant !== 'raw') continue;
  rawChecks++;
  const width = row.pcmStorageBits / 8;
  assert.equal(row.sampleCount, output.length / (width * descriptor.channels));
  for (let offset = 0; offset < output.length; offset += width)
    assert.equal(output.readIntLE(offset, width) % 2 ** descriptor.pcmShift || 0, 0);
  if (row.maxFrames === 0) { assert.equal(output.length, 0); continue; }
  const packetRow = data.rows.find(candidate => candidate.id === row.packetEvidenceRowId);
  assert(packetRow);
  let offset = 0, sample = 0;
  for (const packet of packetRow.packets) {
    assert.equal(packet.pts, sample);
    assert.equal(packet.dts, sample);
    assert.equal(packet.bytes, packet.duration * width * descriptor.channels);
    assert.equal(adler(output.subarray(offset, offset + packet.bytes)), packet.checksum);
    offset += packet.bytes;
    sample += packet.duration;
    checksumChecks++;
  }
  assert.equal(offset, output.length);
  assert.equal(sample, row.sampleCount);
  if (row.maxFrames === 1) assert(packetRow.packets.length <= 1);
  if (row.maxFrames === null) assert.equal(sample, descriptor.totalSamples);
  if (row.source.path.endsWith('flac-decode-cli/cases.json') && row.maxFrames === null) {
    const canonical = json(row.source.path).rows.find(candidate => candidate.id === row.source.rowId);
    const wide = Buffer.from(canonical.output, 'base64');
    assert.equal(wide.length / 4, output.length / width);
    for (let index = 0; index < wide.length / 4; index++)
      assert.equal(output.readIntLE(index * width, width), wide.readInt32LE(index * 4) / 2 ** (32 - row.pcmStorageBits));
  }
}
assert.deepEqual([...coverage].sort(), ['16/1', '16/2', '24/1', '24/2', '32/1', '32/2']);
console.log(JSON.stringify({rows:data.rows.length, rawChecks, checksumChecks, coverage:[...coverage].sort(), nativeCalls:0}));
