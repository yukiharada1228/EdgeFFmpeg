import {expect,it} from 'vitest';import {execFileSync} from 'node:child_process';import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {pixelLayout} from '@edge-ffmpeg/avutil';import {decodeRawVideo} from '@edge-ffmpeg/avcodec';import {compileVideoFilterGraph as compileFrameGraph} from '@edge-ffmpeg/avfilter';import {referencePixelArithmetic} from '../helpers/reference-pixel-profile.js';
it('matches native synchronized stack joins through shared negotiation and plane placement',()=>{
 const arithmetic=referencePixelArithmetic(),root=mkdtempSync(join(tmpdir(),'edge-video-fork-')),formats=['gray','yuv420p','yuv422p','yuv444p','yuva420p','nv12','nv21','rgb24','bgr24','rgba','bgra','argb','abgr','gbrp'],graphs=[
 '[0:v]split[a][b];[a][b]hstack[out]',
 '[0:v]split[a][b];[a][b]vstack[out]',
 '[a][b]hstack[out];[x]hflip[a];[y]vflip[b];[0:v]split[x][y]',
 '[0:v]split[a][b];[a]format=rgba[x];[b]format=nv12[y];[x][y]hstack[out]',
 '[0:v]split=3[a][b][c];[a]scale=4:4[x];[b]scale=6:4[y];[c]scale=2:4[z];[x][y][z]hstack=3[out]',
 '[0:v]split=3[a][b][c];[a][b]hstack[x];[x]scale=5:3[y];[y][c]vstack[out]'
 ];let cases=0,outputs=0;
 try{for(const source of formats){const bytes=pixelLayout(source,5,3).bytes,input=Uint8Array.from({length:bytes*3},(_,i)=>(i*37+137)&255),file=join(root,'input.raw');writeFileSync(file,input);
  for(const description of graphs)for(const targets of [[null],['rgba'],['yuv420p'],['nv12']])for(const trim of [false,true])for(const scalar of [false,true]){
   const graph=compileFrameGraph(description),plan=graph.plan({format:source,width:5,height:3},targets,{inputTrim:trim,arithmetic:scalar?'scalar':arithmetic}),selected=trim?1:0,frame=decodeRawVideo({streamIndex:0,data:input.slice(selected*bytes,(selected+1)*bytes),pts:9007199254740993n,dts:null,duration:1n,timeBase:{num:1n,den:25n},flags:1},{pixelFormat:source,width:5,height:3},{maxFrameBytes:65536}),before=Buffer.concat(frame.planes),actual=plan.apply(frame,{maxFrameBytes:65536,maxStateBytes:plan.stateBytes,maxResidentBytes:1024*1024}),outputArgs=graph.graph.outputs.flatMap((pad,index)=>['-map',`[${pad.label}]`,...(targets[index]?['-pix_fmt',targets[index]!]:[]),'-frames:v','1','-f','rawvideo',join(root,index+'.raw')]);
   execFileSync('.build/reference/ffmpeg',['-y','-v','error',...(scalar?['-cpuflags','0']:[]),'-f','rawvideo','-pixel_format',source,'-s','5x3',...(trim?['-ss','0.02']:[]),'-i',file,'-filter_complex',description,...outputArgs]);
   expect(actual).toHaveLength(1);for(const [index,result]of actual.entries()){expect(Buffer.concat(result.planes),`${source}/${description}/${targets}/${trim}/${scalar}/${index}`).toEqual(readFileSync(join(root,index+'.raw')));expect(result.pts).toEqual(frame.pts);expect(result.metadata).toEqual({});outputs++;}expect(Buffer.concat(frame.planes)).toEqual(before);cases++;
  }
 }expect(cases).toBe(1344);expect(outputs).toBe(1344);}finally{rmSync(root,{recursive:true,force:true});}
},120000);
