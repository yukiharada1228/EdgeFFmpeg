import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
export function referenceRemixArithmetic():'fused'|'separate'{
  const data=new Uint8Array(8),view=new DataView(data.buffer);view.setFloat32(0,0.734375,true);view.setFloat32(4,-0.9765625,true);
  const value=execFileSync(resolve('.build/reference/ffmpeg'),['-v','error','-cpuflags','0','-f','f32le','-ar','8000','-ac','2','-i','pipe:0','-ac','1','-f','f32le','-'],{input:data}).readFloatLE(0);
  if(value===-0.17125239968299866)return 'fused';if(value===-0.17125242948532104)return 'separate';throw new Error('Unrecognized native scalar remix contraction profile');
}
