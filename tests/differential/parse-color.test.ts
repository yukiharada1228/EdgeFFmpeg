import {expect,it} from 'vitest';
import {spawn} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {constants} from 'node:os';
import {resolve} from 'node:path';
import {parseColor,ColorParseError} from '@edge-ffmpeg/avutil';
// av_parse_color reached through AV_OPT_TYPE_COLOR: the color source's c= option drawn into one rgba pixel, whose
// ff_draw_color bytes are the parsed RGBA. Values avoid the filter-graph and option-string specials ([],;:=' and \)
// and leading or trailing whitespace, which av_get_token strips before the option is set.
const native=resolve('.build/reference/ffmpeg'),metadata=resolve('.build/reference/build-metadata.json');
function run(color:string):Promise<{status:number|null;stdout:Buffer;stderr:string}>{
  return new Promise((done,fail)=>{
    const child=spawn(native,['-nostdin','-hide_banner','-v','error','-filter_complex',`color=c=${color}:s=1x1:d=1,format=rgba`,'-frames:v','1','-f','rawvideo','-'],{stdio:['ignore','pipe','pipe']});
    const out:Buffer[]=[],err:Buffer[]=[];child.stdout.on('data',chunk=>out.push(chunk));child.stderr.on('data',chunk=>err.push(chunk));
    child.on('error',fail);child.on('close',status=>done({status,stdout:Buffer.concat(out),stderr:Buffer.concat(err).toString('utf8')}));
  });
}
async function all<T,R>(items:readonly T[],work:(item:T)=>Promise<R>,width=4):Promise<R[]>{const results:R[]=new Array(items.length);let next=0;await Promise.all(Array.from({length:width},async()=>{while(next<items.length){const index=next++;results[index]=await work(items[index]!);}}));return results;}
const edge=(text:string)=>{try{return {rgba:Buffer.from(parseColor(text)).toString('hex'),code:null,message:null};}catch(error){if(!(error instanceof ColorParseError))throw error;return {rgba:null,code:error.code,message:error.message};}};
const source=readFileSync('upstream/ffmpeg/libavutil/parseutils.c','utf8'),start=source.indexOf('color_table[] = {');
const names=[...source.slice(start,source.indexOf('};',start)).matchAll(/\{ "([A-Za-z]+)",/g)].map(match=>match[1]!);
const swapped=(name:string)=>[...name].map((char,index)=>index%2?char.toUpperCase():char.toLowerCase()).join('');
const valid=[
  ...names,...names.map(name=>name.toLowerCase()),...names.map(swapped),
  '#ff0000','0x00ff00','0000ff','#ff000080','0x12345678','ABCDEF','abcdef01','0x0xff00ff','#0xff0000','#0xabcd','#-fffff','#+fffff','# fffff','#\tfffff','#-0000000','#-1234567','#0X12ab','0x-12345','#+0x12345','#-0xabcde',
  'red@0.5','red@1','red@0','red@-0','red@.5','red@5e-1','red@+0.25','red@ 0.5','red@\t1e0','red@0x7f','red@0xFF','red@0x00000080','#00ff00@0.5','#11223344@0x55','AliceBlue@0x7f','red@ 0x1p-1','red@+0x.8','red@-0x0p0',
  'red@0.9999999999999999','red@1e-400','red@0.0039215686274509','red@0.00392156862745098','red@1.0e0','red@100e-2','red@0.50000000000000001','red@+0x1p-1074','red@+0X1.FP-1','#ff0000@0.'+'5'.repeat(118)+'x','red@'+'0'.repeat(123)+'x',
];
const invalid=[
  '#ff00','#ff00000','#fff','0x','#','ff00zz','#ff00zz','0Xff0000','#0x12zz','#0x0x12','#--fffff','#+-ffff','0x+-ffff','#0xg0000','nosuchcolor','redd','ré','#ff0000@0.'+'5'.repeat(117)+'x','red@'+'0'.repeat(122)+'x',
  'red@','red@1.5','red@-0.1','red@0x100','red@0x','red@0x-1','red@0xg','red@0.5x','red@inf','red@-infinity','red@0X80','red@1e','red@0.5@0.5','nosuchcolor@0.5','#ff00@0.5','random@2','red@nan(','#ff0000@2','red@0x1p-1','red@+0x1p1','#+0x1234','#-0xabcdef',
];
const unsupported=['random','RANDOM','bikeshed','#random','0xrandom','random@0.5','red@nan','red@-NaN','red@nan(123)','red@ nan'];
// The macOS libc rounds this literal to the smallest negative subnormal (alpha refused) and glibc 2.36 to -0 (alpha 0).
const platformDependent=['red@-0x1.00000000000008p-1075'];

it('parses colors exactly as the AV_OPT_TYPE_COLOR path of the pinned reference',async()=>{
  expect(existsSync(native),'npm run bootstrap -- --only npm,submodule,reference --allow-unpinned-reference').toBe(true);
  const build=JSON.parse(readFileSync(metadata,'utf8'));expect(build.commit).toBe('946fcce07b6dcd0331c8cc609192aeff5e1924f8');expect(build.flags).toContain('--disable-x86asm');
  expect(names.length).toBe(140);
  const status=256-constants.errno.EINVAL;
  const results=await all([...valid,...invalid,...unsupported,...platformDependent],run);let index=0;
  for(const text of valid){const result=results[index++]!,ours=edge(text);expect([result.status,result.stderr],text).toEqual([0,'']);expect(ours,text).toEqual({rgba:result.stdout.toString('hex'),code:null,message:null});}
  for(const text of invalid){
    const result=results[index++]!,ours=edge(text);expect(result.status,text).toBe(status);expect(result.stdout.length,text).toBe(0);expect(ours.code,text).toBe('invalid');
    // Edge's message is native's av_parse_color log line.
    expect(result.stderr,text).toContain(ours.message!);expect(result.stderr,text).toContain('as color');
  }
  // Native succeeds with a random (or, for NaN, undefined) value; Edge refuses before any value is used.
  for(const text of unsupported){const result=results[index++]!;expect([result.status,result.stdout.length],text).toEqual([0,4]);expect(edge(text).code,text).toBe('unsupported');}
  for(const text of platformDependent){const result=results[index++]!;expect(result.status,text).toBe(process.platform==='darwin'?status:0);expect(edge(text).code,text).toBe('unsupported');}
},120000);
