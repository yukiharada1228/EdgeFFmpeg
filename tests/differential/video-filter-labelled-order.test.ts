import {expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout,parseVideoSize} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native format negotiation for every declaration order of a labelled path',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-filter-flip-')),defaultArithmetic=referencePixelArithmetic();let count=0;
 try{
  const nodes=['[external]format=rgba|gray[a]','[a]format=nv12|gray[b]','[b]scale=13:7[c]','[c]format=rgba|gbrp[result]'];const permutations=(list:readonly string[]):string[][]=>list.length?list.flatMap((value,index)=>permutations(list.filter((_,other)=>other!==index)).map(rest=>[value,...rest])):[[]];const graphs=permutations(nodes).map(chain=>chain.join(';'));
  for(const source of ['rgba','nv12','gray'])for(const [width,height]of [[5,3]] as const){
   let seed=223;const input=Uint8Array.from({length:pixelLayout(source,width,height).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),input);
   const frame=decodeRawVideo({streamIndex:0,data:input,pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width,height},{maxFrameBytes:65536});
   for(const target of [null,'rgba','nv12','gbrp'])for(const description of graphs)for(const size of [null,'3x2'])for(const scalar of [false,true]){
    const arithmetic=scalar?'scalar':defaultArithmetic,plan=compileVideoFilterChain(description).plan(source,width,height,{...(target?{outputPixelFormat:target}:{}),...(size?{outputSize:parseVideoSize(size)}:{}),arithmetic}),actual=plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes}),native=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error',...(scalar?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-i',join(root,'input.raw'),'-vf',description,...(size?['-s',size]:[]),...(target?['-pix_fmt',target]:[]),'-f','rawvideo','-']);
    expect(Buffer.concat(actual.planes),`${source}/${width}x${height}/${target}/${description}/${size}/${arithmetic}`).toEqual(native);expect(actual.pts).toEqual(frame.pts);count++;
   }
  }
  expect(count).toBe(1152);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);


it('matches native labelled pad linking and malformed single-path graph rejection',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-filter-label-corpus-')),arithmetic=referencePixelArithmetic();let count=0;
 try{
  const input=Uint8Array.from({length:60},(_,i)=>(i*37+13)&255);writeFileSync(join(root,'input.raw'),input);const frame=decodeRawVideo({streamIndex:0,data:input,pts:null,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:'rgba',width:5,height:3},{maxFrameBytes:65536});
  for(const description of ["[in]hflip[out]", "[foo]hflip[bar]", "[in]hflip", "hflip[out]", "[in]hflip[x];[x]vflip[out]", "[x]vflip[out];[in]hflip[x]", "hflip[x];[x]scale=13:7[out]", "[x]scale=13:7[out];hflip[x]", "[in]format=nv12[x];[x]scale=13:7[out]", "[x]scale=13:7[out];[in]format=nv12[x]", "hflip@flip1", "hflip@", "format@f=pix_fmts=0", "[in]hflip[x],vflip[out]", "[in]hflip[x],[x]vflip[out]", "[in]hflip[x];[x]vflip[x]", "[x]hflip[x]", "[in]hflip[x];[x]vflip[y];[y]scale=13:7[out]", "[in]hflip[x];[x]vflip[out];[x]null", "hflip;vflip", "[in]hflip[out];", "[in]hflip[out],", "['input x']hflip['output x']", "[\u00e9]hflip[\u7d42]", "[in]hflip[\u00e9];[\u00e9]vflip[out]", "[in]hflip[e\u0301];[\u00e9]vflip[out]", "[in]hflip[a\\]b];[a\\]b]vflip[out]", "[in]hflip['a]b'];['a]b']vflip[out]", "[in]hflip['a b'];['a b']vflip[out]", "[in]hflip[a ];[a]vflip[out]", "[in]hflip['a '];[a]vflip[out]", "[in]hflip[ x];[x]vflip[out]", "[in]hflip[' '];[' ']vflip[out]", "[ ]hflip[out]", "hflip@'instance x'", "hflip@name@other", "'hflip@quote name'", "hflip@' '", "null;[a]hflip[b];[b]vflip[a]", "null;[a]format=gray[b];[b]null[a]", "[in]hflip[\ud800];[\ud801]vflip[out]", "[in]hflip[\udc00];[\udfff]vflip[out]", "[in]hflip[\ud800\udc00];[\ud800\udc00]vflip[out]", "\ufeffnull", "[in]hflip[\ud800];[\ufffd]vflip[out]", "hflip@\ud800"]){
   const native=spawnSync(resolve('.build/reference/ffmpeg'),['-v','error','-f','rawvideo','-pixel_format','rgba','-s','5x3','-i',join(root,'input.raw'),'-vf',description,'-pix_fmt','rgba','-f','rawvideo','-'],{timeout:10000});expect(native.error,description).toBeUndefined();expect(native.signal,description).toBeNull();let actual:Uint8Array|null=null;try{const plan=compileVideoFilterChain(description).plan('rgba',5,3,{outputPixelFormat:'rgba',arithmetic});actual=Buffer.concat(plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes}).planes);}catch{}expect(actual!==null,description).toBe(native.status===0);if(actual!==null)expect(Buffer.from(actual),description).toEqual(native.stdout);count++;
  }
  expect(count).toBe(46);
 }finally{rmSync(root,{recursive:true,force:true});}
},30000);
