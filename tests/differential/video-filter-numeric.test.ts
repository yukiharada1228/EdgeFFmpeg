import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout,parseVideoSize} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native fixed-reference numeric formats empty candidates and aliases in linear graphs',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-filter-flip-')),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'],defaultArithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const source of formats)for(const [width,height]of [[5,3]] as const){
   let seed=109;const input=Uint8Array.from({length:pixelLayout(source,width,height).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),input);
   const frame=decodeRawVideo({streamIndex:0,data:input,pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width,height},{maxFrameBytes:65536});
   for(const target of [null,...formats])for(const description of ["format=0", "format=+2,scale=13:7", "scale=13:7,format=0x1a,scale", "format=|8,hflip,format=26|", "format=pix_fmts=,scale=13:7,vflip", "format=71|4,scale=13:7", "format=-9223372036854775809,hflip,scale=13:7", "format=gray|0,scale=13:7,format=26|71", "format =  0", "format = pix_fmts = rgb32", "format= y8|+2,hflip,format=  bgr32", "format= |Y8,scale=13:7", "format=gray|,vflip", "format=0x1a|GRAY8,scale=13:7,format = 71", "hflip,format = 23|gray8,scale=13:7"])for(const size of [null,'3x2'])for(const scalar of [false,true]){
    const arithmetic=scalar?'scalar':defaultArithmetic,plan=compileVideoFilterChain(description).plan(source,width,height,{...(target?{outputPixelFormat:target}:{}),...(size?{outputSize:parseVideoSize(size)}:{}),arithmetic}),actual=plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes}),native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...(scalar?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-i',join(root,'input.raw'),'-vf',description,...(size?['-s',size]:[]),...(target?['-pix_fmt',target]:[]),'-f','rawvideo','-']);
    expect(Buffer.concat(actual.planes),`${source}/${width}x${height}/${target}/${description}/${size}/${arithmetic}`).toEqual(native);expect(actual.pts).toEqual(frame.pts);count++;
   }
  }
  expect(count).toBe(12600);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);

it('matches native numeric pixel-format spellings and LP64 boundaries with implicit raw output',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-format-numeric-tokens-')),arithmetic=referencePixelArithmetic();let count=0;
 try{
  let seed=109;const input=Uint8Array.from({length:60},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),input);
  const frame=decodeRawVideo({streamIndex:0,data:input,pts:null,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:'rgba',width:5,height:3},{maxFrameBytes:65536}),args=['-v','error','-f','rawvideo','-pixel_format','rgba','-s','5x3','-i',join(root,'input.raw')];
  const run=(value:string)=>execFileSync(resolve('.build/reference/ffmpeg'),[...args,'-vf','format=pix_fmts='+value,'-f','rawvideo','-']);
  for(const [name,id]of [['yuv420p',0],['rgb24',2],['bgr24',3],['yuv422p',4],['yuv444p',5],['gray',8],['nv12',23],['nv21',24],['argb',25],['rgba',26],['abgr',27],['bgra',28],['yuva420p',33],['gbrp',71]] as const){
   const canonical=run(name);for(const value of [String(id),'+'+id,'0x'+id.toString(16),'0'+id.toString(8),String(4294967296+id),String(id-4294967296)]){
    const plan=compileVideoFilterChain('format=pix_fmts='+value).plan('rgba',5,3,{arithmetic}),native=run(value),actual=plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes});expect(plan.pixelFormat).toBe(name);expect(native).toEqual(canonical);expect(Buffer.concat(actual.planes)).toEqual(native);count++;
   }
  }
  for(const value of ['','0b10','08','09','0x','+','-','2x','9223372036854775807','9223372036854775808','-9223372036854775808','-9223372036854775809','18446744073709551616','-'+'9'.repeat(128)+'x']){
   const native=spawnSync(resolve('.build/reference/ffmpeg'),[...args,'-vf','format=pix_fmts='+value,'-f','rawvideo','-']);let rejected=false;try{compileVideoFilterChain('format=pix_fmts='+value);}catch{rejected=true;}expect(rejected,value).toBe(native.status!==0);if(!rejected){const plan=compileVideoFilterChain('format=pix_fmts='+value).plan('rgba',5,3,{arithmetic});expect(plan.pixelFormat).toBe('yuv420p');expect(Buffer.concat(plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes}).planes)).toEqual(native.stdout);}count++;
  }
  expect(count).toBe(98);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
