import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {decodeRawVideo} from '@edge-ffmpeg/avcodec';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
const sources=[['gray',3,2],['rgba',2,1],['yuva420p',2,2],['gbrp',2,1]] as const;
function run(root:string,text:string,format:string,width:number,height:number,arithmetic:ReturnType<typeof referencePixelArithmetic>){
 const input=Uint8Array.from({length:pixelLayout(format,width,height).bytes},(_,i)=>(i*29+7)&255),file=join(root,'input.raw');writeFileSync(file,input);
 const native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','rawvideo','-pixel_format',format,'-s',`${width}x${height}`,'-i',file,'-vf',text,'-f','rawvideo','-'],{timeout:10000});expect(native.error,text).toBeUndefined();expect(native.signal,text).toBeNull();let bytes:Buffer|null=null;
 try{const plan=compileVideoFilterChain(text).plan(format,width,height,{arithmetic}),frame=decodeRawVideo({streamIndex:0,data:input,pts:0n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:format,width,height},{maxFrameBytes:64});bytes=Buffer.concat(plan.apply(frame,{maxFrameBytes:64,maxStateBytes:plan.stateBytes}).planes);}catch{/* compared with native acceptance below */}
 return {native,bytes};
}
it('matches native negate option parsing, component availability and malformed option rejection',()=>{
 const arithmetic=referencePixelArithmetic(),root=mkdtempSync(join(tmpdir(),'edge-negate-options-'));let count=0,accepted=0;
 try{
  for(const suffix of ['','=','=y','=u','=v','=r','=g','=b','=a','=components=y','=y:1','=y:negate_alpha=1','=negate_alpha=1','=negate_alpha=true','=negate_alpha=YES','=negate_alpha=off','=negate_alpha=','=negate_alpha=01','=negate_alpha=+1','=negate_alpha=4294967297','=negate_alpha=2','=negate_alpha=-1','=negate_alpha=auto','=negate_alpha=bogus',
   '=components=','=components=none','=components=0','=components=all','=components=default','=components=max','=components=min','=components=119','=components=0x10','=components=0X77','=components=010','=components=16+32','=components=4294967295','=components=4294967296','=components=+y','=components=-y','=components=-a','=components=+a','=components=y+','=components=Y','=components=y+u-u','=components=u+y','=components=y:components=+u','=components=y:components=-y','=components=y|u',"=components=' y'","=components=\\ y",'=components=all-r-g-b','=components=all-r-g-b-y-u-v-a','=components=r+g+b','=components=r+a','=components=y+u+v+a','=components=y+u+v+r+g+b',
   '=y:1:2','=components=y:1','=foo=1','=y::','=negate_alpha=1:components=a']){
   const text='negate'+suffix;
   for(const [format,width,height]of sources){
    const {native,bytes}=run(root,text,format,width,height,arithmetic);
    expect(bytes!==null,`${text}/${format}`).toBe(native.status===0);if(bytes){expect(bytes,`${text}/${format}`).toEqual(native.stdout);accepted++;}count++;
   }
  }
  expect([count,accepted]).toEqual([248,116]);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
it('rejects native-valid negate forms that remain unimplemented instead of dropping them',()=>{
 const arithmetic=referencePixelArithmetic(),root=mkdtempSync(join(tmpdir(),'edge-negate-unsupported-'));let count=0;
 try{
  // Timeline/generic context options and av_expr component expressions are accepted natively.
  for(const suffix of ['=enable=1',"=enable='between(t,0,1)'",'=threads=2','=components=1e1','=components=y*2','=components=++y','=components=(y)'])for(const [format,width,height]of sources){
   const text='negate'+suffix,{native,bytes}=run(root,text,format,width,height,arithmetic);
   expect(bytes,`${text}/${format}`).toBeNull();expect(()=>compileVideoFilterChain(text).plan(format,width,height,{arithmetic})).toThrow();if(native.status===0)count++;
  }
  expect(count).toBe(20);
 }finally{rmSync(root,{recursive:true,force:true});}
},60000);
