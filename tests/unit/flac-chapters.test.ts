import {expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createVorbisChapterState} from '../../packages/containers/src/flac/chapters.js';
import type {VorbisChapterHook} from '../../packages/containers/src/flac/chapters.js';
interface NativeRow {
 id: string; groups: string[][]; input: string; inputSha256: string;
 native: {chapters: {id: number; start: number; end: number; tags?: Record<string,string>}[]};
}
const evidence = readFileSync(new URL('../../compat/behavior-specs/flac-chapters/native-chapters.json', import.meta.url));
const corpus = JSON.parse(evidence.toString()) as {rows: NativeRow[]};
it('preserves the finite hashed Native chapter corpus', () => {
 expect(createHash('sha256').update(evidence).digest('hex')).toBe('4563bf9c34dbc0af60e373fa1fef50359849da2bd23d1259a43e44548b316d19');
 expect(corpus.rows).toHaveLength(20);
 for (const row of corpus.rows) expect(createHash('sha256').update(Buffer.from(row.input,'base64')).digest('hex'), row.id).toBe(row.inputSha256);
});
it.each(corpus.rows)('matches Native chapter state: $id', row => {
 const state = createVorbisChapterState();
 const hook: VorbisChapterHook = state;
 for (const group of row.groups) for (const entry of group) {
  const equals = entry.indexOf('='); hook.consume(entry.slice(0, equals), entry.slice(equals + 1));
 }
 expect(state.finish({durationUs:32125n})).toEqual(row.native.chapters.map(c => ({id:c.id,timeBase:{num:1n,den:1000n},start:BigInt(c.start),end:BigInt(c.end),tags:c.tags ?? {}})));
});
it('retains API aliases, duplicate reset, immutable snapshots and count bounds', () => {
 const state = createVorbisChapterState({maxChapters:1});
 expect(state.consume).toBe(state.accept); expect(state.snapshot).toBe(state.finish);
 expect(state.consume('CHAPTER001NAME','orphan')).toBe(false);
 expect(state.accept('CHAPTER001','0:0:0.010')).toBe(true);
 state.consume('CHAPTER001NAME','old'); const old = state.snapshot();
 expect(Object.isFrozen(old)).toBe(true); expect(Object.isFrozen(old[0])).toBe(true);
 expect(Object.isFrozen(old[0]?.tags)).toBe(true); expect(Object.isFrozen(old[0]?.timeBase)).toBe(true);
 expect(() => state.consume('CHAPTER002','0:0:0.020')).toThrow(/budget/);
 expect(state.consume('CHAPTER001','0:0:0.020')).toBe(true);
 expect(state.snapshot()[0]).toMatchObject({start:20n,end:20n,tags:{}});
 expect(old[0]).toMatchObject({start:10n,end:10n,tags:{title:'old'}});
});
it.each([0,-1,1.5,Infinity,NaN,Number.MAX_SAFE_INTEGER + 1])('rejects invalid chapter limit %s', maxChapters => {
 expect(() => createVorbisChapterState({maxChapters})).toThrow(RangeError);
});
it('applies signed scanf widths and ASCII whitespace without timestamp range validation', () => {
 const state = createVorbisChapterState();
 expect(state.consume('CHAPTER+12',' \t+1: -1:\n+2.-03trailing')).toBe(true);
 expect(state.snapshot()[0]).toMatchObject({id:12,start:3541997n});
 expect(state.consume('CHAPTER001','+12:00:00.001')).toBe(false);
 expect(state.consume('CHAPTER002','00:00:00.+123')).toBe(true);
 expect(state.snapshot()[1]?.start).toBe(12n);
 expect(state.consume('CHAPTER003','\u00a00:00:00.001')).toBe(false);
 expect(state.consume('CHAPTER+','00:00:00.001')).toBe(false);
});
it('preserves UTF-8 key byte-length branching without encoded scratch copies', () => {
 const state = createVorbisChapterState();
 expect(state.consume('CHAPTER1é','0:0:0.1')).toBe(true);
 expect(state.consume('CHAPTER12é','0:0:0.1')).toBe(false);
 expect(state.consume('CHAPTER1😀','0:0:0.1')).toBe(false);
 expect(state.consume('CHAPTER1\ud800','0:0:0.1')).toBe(false);
 expect(state.consume('chapter1suffixNAME','title')).toBe(true);
 expect(state.snapshot()[0]?.tags).toEqual({title:'title'});
});
it('uses sorted next starts, rounds known duration and clamps ends to starts', () => {
 const state = createVorbisChapterState();
 state.consume('CHAPTER002','0:0:0.010'); state.consume('CHAPTER001','0:0:0.010'); state.consume('CHAPTER003','0:0:0.020');
 expect(state.snapshot().map(c => [c.id,c.end])).toEqual([[2,20n],[1,10n],[3,20n]]);
 expect(state.snapshot({durationUs:20500n}).map(c => c.end)).toEqual([20n,21n,21n]);
 expect(state.snapshot({durationUs:1n}).map(c => c.end)).toEqual([10n,10n,20n]);
 expect(state.snapshot({durationUs:0n})).toEqual(state.snapshot());
 expect(() => state.snapshot({durationUs:-1n})).toThrow(RangeError);
});
