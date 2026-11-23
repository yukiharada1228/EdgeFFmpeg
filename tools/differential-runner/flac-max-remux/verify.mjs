// Offline evidence integrity and observed-behavior checks; never launches Native.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const path = 'compat/behavior-specs/flac-max-remux/cases.json';
const data = JSON.parse(readFileSync(path, 'utf8'));
assert.equal(data.binarySha256, '1b86106f46cfa087eec387b83bc37ba95bdea5043e738259cac9b7c01c2eab92');
assert.equal(data.reference.artifacts.ffmpeg, data.binarySha256);
assert.equal(data.rows.length, 28);
assert.equal(new Set(data.rows.map(row => row.id)).size, 28);
assert(data.limits.actualNativeCalls <= 64);
const rows = new Map(data.rows.map(row => [row.id, row]));
for (const row of data.rows) {
  const input = Buffer.from(row.input, 'base64');
  assert.equal(sha(input), row.inputSha256);
  assert(input.length <= 524288);
  if (row.output !== null) {
    const output = Buffer.from(row.output, 'base64');
    assert.equal(sha(output), row.outputSha256);
    assert(output.length <= 524288);
  } else assert.equal(row.outputSha256, null);
  assert(row.args.includes('/in.flac')); assert.equal(row.args.at(-1), '/out');
  assert.deepEqual(row.selectedStreamIds, row.id === 'duplicate-audio' ? [0, 0] : [0]);
  assert.equal(row.descriptors[0].codec, 'flac');
  assert.equal(row.descriptors[0].channels, 2);
  if (!row.semanticPackets) continue;
  const inputDirectory = row.inputMetadata, outputDirectory = row.outputMetadata;
  const payload = Buffer.from(row.output, 'base64').subarray(outputDirectory.audioOffset);
  assert.equal(sha(payload), outputDirectory.audioSha256);
  assert.equal(row.outputProbe.packets.reduce((sum, packet) => sum + packet.bytes, 0), payload.length);
  let offset = 0;
  for (const packet of row.outputProbe.packets) {
    assert.equal(sha(payload.subarray(offset, offset + packet.bytes)), packet.dataSha256);
    offset += packet.bytes;
  }
  assert(row.semanticPackets.payloadSequenceIsInputPrefix, row.id);
  if (!['frames-0', 'frames-1'].includes(row.id)) {
    assert(row.semanticPackets.allPacketFieldsEqual, row.id);
    assert.equal(outputDirectory.audioSha256, inputDirectory.audioSha256);
  }
}
for (const bits of [16, 24, 32]) for (const signal of ['empty', 'ramp', 'extremes']) {
  const baseline = rows.get(`${bits}-2-${signal}-5/default`);
  const stripped = rows.get(`${bits}-2-${signal}-5/bitexact-stripped`);
  assert.equal(baseline.descriptors[0].bitsPerSample, bits);
  assert.equal(baseline.exitCode, 0); assert.equal(stripped.exitCode, 0);
  const comments = stripped.outputMetadata.blocks.find(block => block.type === 4);
  assert.equal(comments.vendor, 'ffmpeg'); assert.deepEqual(comments.comments, []);
  if (signal === 'empty') assert.equal(stripped.outputProbe.packets.length, 0);
}
for (const id of ['short-read-1', 'short-read-7', 'frames-2', 'overwrite-y']) assert.equal(rows.get(id).outputSha256, rows.get('16-2-ramp-5/default').outputSha256);
assert.equal(rows.get('frames-0').outputProbe.packets.length, 0);
assert.equal(rows.get('frames-1').outputProbe.packets.length, 1);
assert.equal(rows.get('overwrite-y').existingOutputPreserved, false);
assert.equal(rows.get('overwrite-n').existingOutputPreserved, true);
// Preserve this pinned build's surprising exit status rather than normalize it.
assert.equal(rows.get('overwrite-n').exitCode, 0);
assert.match(rows.get('overwrite-n').stderr, /already exists/);
assert.equal(rows.get('duplicate-audio').exitCode, 234);
assert.match(rows.get('duplicate-audio').stderr, /Exactly one FLAC/);
assert(rows.get('tagged/default').outputMetadata.blocks.find(block => block.type === 4).comments.includes('TITLE=Remux π'));
assert.deepEqual(rows.get('tagged/bitexact-stripped').outputMetadata.blocks.find(block => block.type === 4).comments, []);
console.log(JSON.stringify({verifiedRows:data.rows.length, nativeCalls:0, exactByteChecks:true, packetPayloadChecks:true, productionConformance:'not evaluated'}));
