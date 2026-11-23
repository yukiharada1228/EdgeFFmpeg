import {expect,it} from 'vitest';
import {parseVideoSize} from '@edge-ffmpeg/avutil';
it('parses LP64 native video size separators signs aliases and signed32 narrowing',()=>{
 for(const text of ['2x3','2X3','2:3','2/3','2 3','  +002x+03','4294967298x3','-4294967294x3'])expect(parseVideoSize(text),text).toEqual({width:2,height:3});
 expect(parseVideoSize('qcif')).toEqual({width:176,height:144});expect(parseVideoSize('uhd4320')).toEqual({width:7680,height:4320});
 for(const text of ['2xx3','2x3 ','PAL','toString','0x3','-1x3','2','2×3','9223372036854775808x3','-9223372036854775809x3','2x0','2x3foo','2x3\n'])expect(()=>parseVideoSize(text),text).toThrow();
});
