import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pixelLayout} from '@edge-ffmpeg/avutil';
import {convertVideoFrame,pixelConversionStateBytes,resizeVideoFrame,pixelResizeStateBytes} from '@edge-ffmpeg/swscale';
interface Case {fullRange:boolean;source:string;matrix:number;sw:number;sh:number;dw:number;dh:number;output:string;arithmetic:'x86_64'|'scalar';resize:boolean;inputSha256:string;nativeSha256:string}
it('matches 5120 locked canonical Linux limited and full-range matrix conversion outputs',()=>{
 const fixture=JSON.parse(readFileSync('compat/behavior-specs/fullrange-linux.json','utf8')) as {reference:{commit:string;platform:string;arch:string;artifacts:{ffmpeg:string}};image:string;cases:Case[]},hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
 expect(fixture.reference).toMatchObject({commit:'946fcce07b6dcd0331c8cc609192aeff5e1924f8',platform:'linux',arch:'x64',artifacts:{ffmpeg:'5e43da9ad1ee070f7e27c171b2ed2a311100f3d484d86f97f182e46d8ba68c91'}});expect(fixture.image).toBe(JSON.parse(readFileSync('compat/reference-container.lock.json','utf8')).image);expect(fixture.cases).toHaveLength(5120);
 const ids=new Set<string>();for(const row of fixture.cases){const {source,matrix,sw,sh,dw,dh,output,arithmetic}=row,id=[row.fullRange,source,matrix,sw,sh,output,arithmetic,row.resize].join('/');expect(ids.has(id),id).toBe(false);ids.add(id);const layout=pixelLayout(source,sw,sh);let seed=matrix*37;const data=Uint8Array.from({length:layout.bytes},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});expect(hash(data),id).toBe(row.inputSha256);
  const frame={width:sw,height:sh,pixelFormat:source,planes:layout.planes.map(p=>data.subarray(p.offset,p.offset+p.bytes)),linesizes:layout.planes.map(p=>p.rowBytes),pts:null,metadata:{colorSpace:matrix,colorRange:row.fullRange?2:1}},state=row.resize?pixelResizeStateBytes(source,sw,sh,dw,dh,output,arithmetic):pixelConversionStateBytes(source,output,sw,sh,arithmetic),actual=row.resize?resizeVideoFrame(frame,dw,dh,{maxFrameBytes:1048576,maxStateBytes:state,outputPixelFormat:output,arithmetic}):convertVideoFrame(frame,output,{maxFrameBytes:1048576,maxStateBytes:state,arithmetic});expect(hash(Buffer.concat(actual.planes)),id).toBe(row.nativeSha256);
 }
},30000);
