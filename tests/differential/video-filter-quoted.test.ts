import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout,parseVideoSize} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native quoted linear graph parsing and option precedence across declared formats',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-filter-flip-')),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'],defaultArithmetic=referencePixelArithmetic();let count=0;
 try{
  for(const source of formats)for(const [width,height]of [[5,3]] as const){
   let seed=181;const input=Uint8Array.from({length:pixelLayout(source,width,height).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),input);
   const frame=decodeRawVideo({streamIndex:0,data:input,pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width,height},{maxFrameBytes:65536});
   for(const target of [null,...formats])for(const description of ["'null'", "n\\ull", "format='rgba|gray'", "format=\\'rgba|gray\\'", "format=rgba\\|gray", "format='pix_fmts=0'", "format=pix_fmts='0'", "format='rgba", "format=rgba:pix_fmts=gray", "format=pix_fmts=gray:pix_fmts=rgba", "scale='13:7'", "scale=w='13':h='7'", "scale=13\\:7", "scale=13:7:bicubic", "scale=13:h=7", "scale=h=7", "scale='13,7'", "scale=size='13x7'", "scale=flags=bicubic", "scale=13:7:w=5:h=3,hflip", "hflip, ", "format='rgba|gray',"])for(const size of [null,'3x2'])for(const scalar of [false,true]){
    const arithmetic=scalar?'scalar':defaultArithmetic,plan=compileVideoFilterChain(description).plan(source,width,height,{...(target?{outputPixelFormat:target}:{}),...(size?{outputSize:parseVideoSize(size)}:{}),arithmetic}),actual=plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes}),native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...(scalar?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-i',join(root,'input.raw'),'-vf',description,...(size?['-s',size]:[]),...(target?['-pix_fmt',target]:[]),'-f','rawvideo','-']);
    expect(Buffer.concat(actual.planes),`${source}/${width}x${height}/${target}/${description}/${size}/${arithmetic}`).toEqual(native);expect(actual.pts).toEqual(frame.pts);count++;
   }
  }
  expect(count).toBe(18480);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);


it('matches native quoted option precedence and malformed linear-filter rejection',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-filter-quoted-corpus-')),arithmetic=referencePixelArithmetic();let count=0;
 try{
  const input=Uint8Array.from({length:60},(_,i)=>(i*37+13)&255);writeFileSync(join(root,'input.raw'),input);const frame=decodeRawVideo({streamIndex:0,data:input,pts:null,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:'rgba',width:5,height:3},{maxFrameBytes:65536});
  for(const description of ["'null'", "'null", "n\\ull", "format='rgba|gray'", "format=\\'rgba|gray\\'", "format=rgba\\|gray", "format='pix_fmts=0'", "format=pix_fmts='0'", "format=pix_fmts=' 0 '", "format=pix_fmts=\\' 0 \\'", "format=pix_fmts=\\' gray \\'", "format='rgba", "format=rgba:pix_fmts=gray", "format=pix_fmts=gray:pix_fmts=rgba", "format=0:8", "scale='13:7'", "scale=w='13':h='7'", "scale=13\\:7", "scale=13:7:bicubic", "scale=w=13:7", "scale=13:h=7", "scale=h=7", "scale=w=13", "scale='13,7'", "format=rgba\\,null", "format=rgba\\\\,null", "format=rgba;null", "format=rgba\\", "format=bogus:pix_fmts=rgba", "scale=w=bogus:h=7:w=13", "scale=w=13:h=7:w=bogus", "scale=13:7:flags=bogus:flags=bicubic", "scale=13:7:flags=bicubic:flags=bogus", "scale=flags=bogus:flags=bicubic", "scale=flags=bicubic:flags=", "format=rgba:pix_fmts=0:pix_fmts=rgba", "null,", "null;", "null,   ", "null,;", "null;null", "format=''", "format=' '", "scale=''", "scale=' '"]){
   const native=spawnSync(resolve('.build/reference/ffmpeg'),['-v','error','-f','rawvideo','-pixel_format','rgba','-s','5x3','-i',join(root,'input.raw'),'-vf',description,'-pix_fmt','rgba','-f','rawvideo','-']);let actual:Uint8Array|null=null;try{const plan=compileVideoFilterChain(description).plan('rgba',5,3,{outputPixelFormat:'rgba',arithmetic});actual=Buffer.concat(plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes}).planes);}catch{}expect(actual!==null,description).toBe(native.status===0);if(actual!==null)expect(Buffer.from(actual),description).toEqual(native.stdout);count++;
  }
  expect(count).toBe(45);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
