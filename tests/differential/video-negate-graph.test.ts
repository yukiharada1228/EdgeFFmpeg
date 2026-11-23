import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pixelLayout,parseVideoSize} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native linear negate with negotiated conversion across every declared format pair',()=>{
 const root=mkdtempSync(join(tmpdir(),'edge-filter-negate-')),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'],defaultArithmetic=referencePixelArithmetic();let accepted=0,rejected=0;
 try{
  for(const source of formats)for(const [width,height]of [[5,3],[6,4]] as const){
   let seed=89;const input=Uint8Array.from({length:pixelLayout(source,width,height).bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});writeFileSync(join(root,'input.raw'),input);
   const frame=decodeRawVideo({streamIndex:0,data:input,pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width,height},{maxFrameBytes:65536});
   for(const target of [null,...formats])for(const description of ['negate','negate=negate_alpha=1','hflip,negate,scale=13:7','format=nv12,negate','format=rgba|gray,negate=a,format=nv12|gray','scale=13:7,negate=u+v,vflip'])for(const size of [null,'3x2'])for(const scalar of [false,true]){
    const arithmetic=scalar?'scalar':defaultArithmetic,label=`${source}/${width}x${height}/${target}/${description}/${size}/${arithmetic}`,native=spawnSync(resolve('.build/reference/ffmpeg'),['-v','error',...(scalar?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',source,'-s',`${width}x${height}`,'-i',join(root,'input.raw'),'-vf',description,...(size?['-s',size]:[]),...(target?['-pix_fmt',target]:[]),'-f','rawvideo','-'],{timeout:10000});
    expect(native.error,label).toBeUndefined();let actual:Buffer|null=null,pts:unknown;
    try{const plan=compileVideoFilterChain(description).plan(source,width,height,{...(target?{outputPixelFormat:target}:{}),...(size?{outputSize:parseVideoSize(size)}:{}),arithmetic}),output=plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes});actual=Buffer.concat(output.planes);pts=output.pts;}catch(error){expect((error as Error).message,label).toBe('Requested components not available');}
    expect(actual!==null,label).toBe(native.status===0);
    if(actual){expect(actual,label).toEqual(native.stdout);expect(pts).toEqual(frame.pts);accepted++;}else{expect(native.stderr.toString(),label).toContain('Requested components not available');rejected++;}
   }
  }
  expect([accepted,rejected]).toEqual([8936,1144]);
 }finally{rmSync(root,{recursive:true,force:true});}
},240000);
it('plans negate as a format-preserving stage with semiplanar conversion and explicit component failures',()=>{
 const plan=compileVideoFilterChain('negate,negate=y,negate=negate_alpha=1').plan('nv12',5,3);
 expect(plan.stages.map(stage=>[stage.operation??'scale',stage.pixelFormat,stage.negate?.components,stage.negate?.negateAlpha])).toEqual([['scale','yuv420p',undefined,undefined],['negate','yuv420p',0x77,false],['negate','yuv420p',0x10,false],['negate','yuv420p',0x77,true]]);
 expect(plan.pixelFormat).toBe('yuv420p');expect(plan.stages.slice(1).every(stage=>stage.stateBytes===0)).toBe(true);expect(Object.isFrozen(plan.stages[1]!.negate)).toBe(true);
 expect(compileVideoFilterChain('negate').plan('rgba',5,3,{outputPixelFormat:'nv12'}).stages.map(stage=>[stage.operation??'scale',stage.pixelFormat])).toEqual([['negate','rgba'],['scale','nv12']]);
 for(const [description,format]of [['negate=a','rgb24'],['negate=u','gray'],['negate=r','yuv444p'],['negate=y','gbrp'],['negate=all','rgba'],['format=rgb24,negate=a','rgba']] as const)expect(()=>compileVideoFilterChain(description).plan(format,5,3),description).toThrow('Requested components not available');
});
