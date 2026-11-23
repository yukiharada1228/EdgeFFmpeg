import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileVideoFilterChain} from '@edge-ffmpeg/avfilter';
import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native declared transpose options and malformed option rejection',()=>{
 const arithmetic=referencePixelArithmetic(),root=mkdtempSync(join(tmpdir(),'edge-transpose-options-')),file=join(root,'input.raw');writeFileSync(file,Uint8Array.of(1,2,3,4,5,6));let count=0;
 try{
 for(const suffix of ['', '=','=0','=1','=2','=3','=4','=5','=6','=7','=clock','=cclock','=clock_flip','=cclock_flip',"='clock'",'=dir=clock','=clock:portrait','=dir=2:passthrough=landscape','=dir=1:dir=3','=passthrough=3','=dir=7:passthrough=portrait','=passthrough=portrait:dir=4','=00','=dir=1:passthrough=none', '=-1','=8','=dir=999999999999999999999','=bogus','=dir=bogus:dir=clock','=passthrough=-1','=passthrough=2147483648','=foo=1','=clock:portrait:3','=dir=1:2','=dir=','=passthrough=', '=dir=1::','=enable=1']){
 const text='transpose'+suffix,native=spawnSync('.build/reference/ffmpeg',['-v','error','-f','rawvideo','-pixel_format','gray','-s','3x2','-i',file,'-vf',text,'-f','rawvideo','-'],{timeout:10000});expect(native.error,text).toBeUndefined();expect(native.signal,text).toBeNull();let bytes:Buffer|null=null;
 try{const plan=compileVideoFilterChain(text).plan('gray',3,2,{arithmetic});bytes=Buffer.concat(plan.apply({width:3,height:2,pixelFormat:'gray',planes:[Uint8Array.of(1,2,3,4,5,6)],linesizes:[3],pts:null,metadata:{}},{maxFrameBytes:64,maxStateBytes:plan.stateBytes}).planes);}catch{}
 expect(bytes!==null,text).toBe(native.status===0);if(bytes)expect(bytes,text).toEqual(native.stdout);count++;
 }expect(count).toBe(38);
 }finally{rmSync(root,{recursive:true,force:true});}
});
