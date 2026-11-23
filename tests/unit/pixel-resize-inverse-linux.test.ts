import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {pixelResizeStateBytes,resizeVideoFrame} from '@edge-ffmpeg/swscale';
it('matches 1008 locked Linux default and independent scalar resized YUV to RGB outputs',()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/resize-inverse-linux.json','utf8')) as {reference:{commit:string;platform:string;arch:string;flags:string[];artifacts:{ffmpeg:string}};cases:{id:string;format:string;destination:string;sw:number;sh:number;dw:number;dh:number;inputSha256:string;native:{default:string;scalar:string}}[]},hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
 expect(fixture.reference).toMatchObject({commit:'946fcce07b6dcd0331c8cc609192aeff5e1924f8',platform:'linux',arch:'x64',artifacts:{ffmpeg:'5e43da9ad1ee070f7e27c171b2ed2a311100f3d484d86f97f182e46d8ba68c91'}});expect(fixture.reference.flags).toEqual(['--disable-autodetect','--disable-doc','--disable-debug','--disable-x86asm']);expect(fixture.cases).toHaveLength(1008);expect(new Set(fixture.cases.map(c=>c.id)).size).toBe(1008);
 for(const c of fixture.cases){
  let seed=73;const input=Uint8Array.from({length:pixelLayout(c.format,c.sw,c.sh).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});expect(hash(input),c.id).toBe(c.inputSha256);
  const frame=decodeRawVideo({streamIndex:0,data:input,pts:0n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:c.format,width:c.sw,height:c.sh},{maxFrameBytes:524288});
  for(const [profile,arithmetic]of [['default','x86_64'],['scalar','scalar']] as const){const output=resizeVideoFrame(frame,c.dw,c.dh,{outputPixelFormat:c.destination,arithmetic,maxFrameBytes:524288,maxStateBytes:pixelResizeStateBytes(c.format,c.sw,c.sh,c.dw,c.dh,c.destination,arithmetic)});expect(hash(Buffer.concat(output.planes)),`${c.id}/${profile}`).toBe(c.native[profile]);}
 }
});
