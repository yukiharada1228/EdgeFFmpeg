// Development-only byte-level checks; no production decoder or trimming helper.
import {createHash} from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function adler32(bytes) {
  let a = 0, b = 0;
  for (const value of bytes) { a = (a + value) % 65521; b = (b + a) % 65521; }
  return '0x' + ((b * 65536 + a) >>> 0).toString(16).padStart(8, '0');
}
const samplesAt = (bytes, at) => [bytes.readInt32LE(at), bytes.readInt32LE(at + 4)];
export function preserveSampleEvidence(data) {
  for (const raw of data.rows.filter(row => row.variant === 'packed-raw' && row.exitCode === 0 && row.output !== null)) {
    const bytes = Buffer.from(raw.output, 'base64');
    for (const variant of ['packed-framecrc', 'planar-framecrc']) {
      const row = data.rows.find(row => row.boundary === raw.boundary && row.variant === variant);
      if (!row || row.exitCode !== 0) continue;
      let offset = 0;
      for (const packet of row.packets) {
        const packed = bytes.subarray(offset, offset + packet.bytes);
        if (packed.length !== packet.bytes || packet.bytes !== packet.duration * 8) throw Error('Packet sample bounds: ' + row.id);
        let encoded = packed;
        if (variant === 'planar-framecrc') {
          encoded = Buffer.alloc(packed.length);
          for (let sample = 0; sample < packet.duration; sample++) for (let channel = 0; channel < 2; channel++) {
            packed.copy(encoded, (channel * packet.duration + sample) * 4, (sample * 2 + channel) * 4, (sample * 2 + channel + 1) * 4);
          }
        }
        if (adler32(encoded) !== packet.checksum) throw Error('Native packet sample checksum differs: ' + row.id);
        packet.firstSamples = packet.duration ? samplesAt(packed, 0) : [];
        packet.lastSamples = packet.duration ? samplesAt(packed, packed.length - 8) : [];
        packet.sampleEvidence = 'Packed Native PCM, packet-local layout conversion, verified against Native framecrc Adler-32';
        offset += packet.bytes;
      }
      if (offset !== bytes.length) throw Error('Native packet totals differ: ' + row.id);
      row.sampleCount = raw.sampleCount;
      row.firstSamples = raw.firstSamples;
      row.lastSamples = raw.lastSamples;
      row.canonicalSlice = raw.canonicalSlice;
      row.interleavedPcmSha256 = sha(bytes);
      row.sampleEvidenceSource = raw.id;
    }
  }
}
