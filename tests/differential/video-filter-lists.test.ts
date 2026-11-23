import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout,parseVideoSize} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
import {createNativeOracle,runBoundedCases} from '../helpers/native-oracle.js';
it('matches native candidate-list negotiation across all declared input and output formats',async({signal})=>{
 const root=mkdtempSync(join(tmpdir(),'edge-filter-bounded-')),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'],referenceArithmetic=referencePixelArithmetic(),oracle=createNativeOracle();let count=0;
 try{for(const source of formats){let seed=197;const input=Uint8Array.from({length:pixelLayout(source,5,3).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;}),file=join(root,source+'.raw');writeFileSync(file,input);
  const frame=decodeRawVideo({streamIndex:0,data:input,pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:5,height:3},{maxFrameBytes:65536});
  function* cases(){for(const target of [null,...formats])for(const[a,b]of [['gray|rgba','gray|nv12'],['rgba|nv12','yuva420p|nv12'],['rgb24|gbrp','gbrp|yuv422p'],['nv12|yuv420p','yuv444p|rgba']])for(const description of [`format=${a},format=${b}`,`format=${a},scale=13:7,format=${b},scale`,`scale=13:7,format=${a},format=${b},scale=5:3`])for(const size of [null,'3x2'])for(const scalar of [false,true])yield {target,description,size,scalar};}
  await runBoundedCases(cases(),2,signal,async({target,description,size,scalar},caseSignal)=>{
   const arithmetic=scalar?'scalar':referenceArithmetic,plan=compileVideoFilterChain(description).plan(source,5,3,{...(target?{outputPixelFormat:target}:{}),...(size?{outputSize:parseVideoSize(size)}:{}),arithmetic}),actual=plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes}),native=await oracle.run(resolve('.build/reference/ffmpeg'),['-v','error',...(scalar?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',source,'-s','5x3','-i',file,'-vf',description,...(size?['-s',size]:[]),...(target?['-pix_fmt',target]:[]),'-f','rawvideo','-'],caseSignal);
   expect(Buffer.concat(actual.planes),`${source}/${target}/${description}/${size}/${arithmetic}`).toEqual(native);expect(actual.pts).toEqual(frame.pts);count++;
  });
 }expect(count).toBe(10080);expect(oracle.metrics).toEqual({calls:10080,active:0,peak:2,failures:0});
 }finally{rmSync(root,{recursive:true,force:true});}
},120000);
