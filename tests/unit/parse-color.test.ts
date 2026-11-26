import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {parseColor,ColorParseError} from '@edge-ffmpeg/avutil';
// Values follow libavutil/parseutils.c av_parse_color; tests/differential/parse-color.test.ts checks every case here against native.
const hex=(rgba:readonly number[])=>rgba.map(value=>value.toString(16).padStart(2,'0')).join('');
const failure=(text:string)=>{try{parseColor(text);}catch(error){if(error instanceof ColorParseError)return [error.code,error.message];throw error;}return null;};
it('parses every color_table name case-insensitively, with the upstream table sorted for bsearch',()=>{
  const source=readFileSync('upstream/ffmpeg/libavutil/parseutils.c','utf8'),table=source.slice(source.indexOf('color_table[] = {'),source.indexOf('};',source.indexOf('color_table[] = {')));
  const rows=[...table.matchAll(/\{ "([A-Za-z]+)",\s*\{ 0x(..), 0x(..), 0x(..) \} \}/g)].map(match=>[match[1]!,(match[2]!+match[3]!+match[4]!).toLowerCase()+'ff'] as const);
  expect(rows.length).toBe(140);
  const names=rows.map(([name])=>name.toLowerCase());expect(names).toEqual([...names].sort());
  for(const [name,rgba] of rows)for(const variant of [name,name.toLowerCase(),name.toUpperCase()])expect(hex(parseColor(variant)),variant).toBe(rgba);
  expect(Object.isFrozen(parseColor('red'))).toBe(true);
});
it('parses #, 0x and bare RRGGBB[AA] through LP64 strtoul',()=>{
  for(const [text,rgba] of [['#ff0000','ff0000ff'],['0x00ff00','00ff00ff'],['0000ff','0000ffff'],['#ff000080','ff000080'],['0x12345678','12345678'],['ABCDEF','abcdefff'],['abcdef01','abcdef01'],
    // strtoul skips whitespace and a sign and accepts a second 0x prefix; all count toward the 6 or 8 characters.
    ['0x0xff00ff','00ff00ff'],['#0xff0000','00ff0000'],['#0xabcd','00abcdff'],['#-fffff','f00001ff'],['#+fffff','0fffffff'],['# fffff','0fffffff'],['#\tfffff','0fffffff'],['#-0000000','00000000'],['#-1234567','fedcba99']] as const)
    expect(hex(parseColor(text)),text).toBe(rgba);
  for(const text of ['#ff00','#ff00000','#fff','0x','#','','ff00zz','#ff00zz','0Xff0000','#0x12zz','#0x0x12','# ffff ','#--fffff','#+-ffff','0x+-ffff','#0xg0000'])
    expect(failure(text)?.[0],text).toBe('invalid');
  expect(failure('#ff00')).toEqual(['invalid',"Invalid 0xRRGGBB[AA] color string: 'ff00'"]);
  expect(failure('nosuchcolor')).toEqual(['invalid',"Cannot find color 'nosuchcolor'"]);
  expect(failure('0Xff0000')).toEqual(['invalid',"Cannot find color '0Xff0000'"]);
});
it('applies @ alpha as 0x.. (at most 255) or a 0..1 strtod float scaled by 255 and truncated',()=>{
  for(const [text,rgba] of [['red@0.5','ff00007f'],['red@1','ff0000ff'],['red@0','ff000000'],['red@-0','ff000000'],['red@.5','ff00007f'],['red@5e-1','ff00007f'],['red@+0.25','ff00003f'],['red@ 0.5','ff00007f'],['red@\t1e0','ff0000ff'],
    ['red@0x7f','ff00007f'],['red@0xFF','ff0000ff'],['red@0x00000080','ff000080'],['#00ff00@0.5','00ff007f'],['#11223344@0x55','11223355'],['AliceBlue@0x7f','f0f8ff7f'],
    ['red@ 0x1p-1','ff00007f'],['red@+0x.8','ff00007f'],['red@-0x0p0','ff000000'],['red@0.9999999999999999','ff0000fe'],['red@1e-400','ff000000'],['red@0.0039215686274509','ff000000'],['red@0.00392156862745098','ff000001']] as const)
    expect(hex(parseColor(text)),text).toBe(rgba);
  for(const text of ['red@','red@1.5','red@-0.1','red@0x100','red@0x','red@0x-1','red@0xg','red@0.5 ','red@0.5x','red@inf','red@-infinity','red@0X80','red@1e','red@0.5@0.5','red@,','nosuchcolor@0.5','#ff00@0.5'])
    expect(failure(text)?.[0],text).toBe('invalid');
  expect(failure('red@1.5')).toEqual(['invalid',"Invalid alpha value specifier '1.5' in 'red@1.5'"]);
  expect(failure('#ff0000@2')).toEqual(['invalid',"Invalid alpha value specifier '2' in '#ff0000@2'"]);
});
it('refuses random colors and NaN or platform-dependent alphas, and copies the text as C bytes',()=>{
  for(const text of ['random','RANDOM','bikeshed','#random','0xrandom','random@0.5','red@nan','red@-NaN','red@nan(123)','red@ nan']) expect(failure(text)?.[0],text).toBe('unsupported');
  // Native checks the alpha of a random color before it would be used, so an invalid alpha is still EINVAL.
  expect(failure('random@2')?.[0]).toBe('invalid');expect(failure('red@nan(')?.[0]).toBe('invalid');
  // Subnormal hex literals that the macOS libc rounds to the smallest negative subnormal and glibc 2.36 to -0.
  expect(failure('red@-0x1.00000000000008p-1075')?.[0]).toBe('unsupported');expect(hex(parseColor('red@+0x1p-1074'))).toBe('ff000000');
  // The value ends at a NUL and after 127 bytes past the prefix: the truncated text is what is parsed.
  expect(hex(parseColor('red\0junk'))).toBe('ff0000ff');
  expect(hex(parseColor('#ff0000@0.'+'5'.repeat(118)+'x'))).toBe('ff00008d');expect(failure('#ff0000@0.'+'5'.repeat(117)+'x')?.[0]).toBe('invalid');
  expect(hex(parseColor('red@'+'0'.repeat(123)+'x'))).toBe('ff000000');expect(failure('red@'+'0'.repeat(122)+'x')?.[0]).toBe('invalid');
  expect(failure('ré')).toEqual(['invalid',"Cannot find color 'ré'"]);
});
