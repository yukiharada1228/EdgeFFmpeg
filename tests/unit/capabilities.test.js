import { expect, it } from 'vitest';
import { parseListing } from '../../tools/extract-capabilities/parse.mjs';
it('separates demuxers/muxers, expands aliases and excludes legends', () => {
  expect(parseListing('format', ' D. = Demuxing supported\n .E = Muxing supported\n DE matroska,webm Matroska / WebM\n D  mov QuickTime\n')).toEqual([
    { name: 'matroska', kind: 'demuxer', flags: 'DE' },
    { name: 'matroska', kind: 'muxer', flags: 'DE' },
    { name: 'webm', kind: 'demuxer', flags: 'DE' },
    { name: 'webm', kind: 'muxer', flags: 'DE' },
    { name: 'mov', kind: 'demuxer', flags: 'D' }
  ]);
});
it('keeps protocol directions and excludes headings', () => {
  expect(parseListing('protocol', 'Supported file protocols:\nInput:\n  file\n  http\nOutput:\n  file\n')).toEqual([
    { name: 'file', direction: 'input' }, { name: 'http', direction: 'input' }, { name: 'file', direction: 'output' }
  ]);
});
it('handles codecs, filters and sample formats', () => {
  expect(parseListing('decoder', ' V....D h264 H.264 decoder\n')).toEqual([{ name: 'h264', flags: 'V....D' }]);
  expect(parseListing('filter', ' TSC scale V->V Scale video\n')).toEqual([{ name: 'scale', flags: 'TSC' }]);
  expect(parseListing('sampleFormat', 'name depth\ns16 16\nfltp 32\n')).toEqual([{ name: 's16', bits: 16 }, { name: 'fltp', bits: 32 }]);
});
