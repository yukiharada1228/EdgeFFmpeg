import {it,expect} from 'vitest';
import {avcPacketToAnnexB} from '@edge-ffmpeg/avcodec';
it('rejects an oversized or invalid AVC prefix before allocating its copy',()=>{
 const Original=globalThis.Uint8Array,prefix=new Original(1048576),data=Original.of(1,101);let copies=0;
 try{
  globalThis.Uint8Array=new Proxy(Original,{construct(target,args,newTarget){if(args[0]===prefix||args[0]===1048576)copies++;return Reflect.construct(target,args,newTarget);}});
  expect(()=>avcPacketToAnnexB(data,1,16,1,prefix)).toThrow('AVC parameter prefix exceeds allocation budget');
  expect(()=>avcPacketToAnnexB(data,1,16,1,1048576 as unknown as Uint8Array)).toThrow('Invalid AVC parameter prefix');
  expect(copies).toBe(0);
 }finally{globalThis.Uint8Array=Original;}
});
it('preserves owned AnnexB bytes across prefix and NAL length boundaries',()=>{
 let cases=0;
 for(const lengthSize of [1,2,3,4] as const)for(const count of [1,2,3,4])for(const payloadSize of [0,1,2,7])for(const prefixSize of [0,6,16,48,64,65]){
  const prefix=Uint8Array.from({length:prefixSize},(_,i)=>i),parts:number[]=[],expected=[...prefix];
  for(let i=0;i<count;i++){const payload=Uint8Array.from({length:payloadSize},(_,j)=>101+i+j),head=new Uint8Array(lengthSize);let size=payload.length;for(let j=lengthSize-1;j>=0;j--){head[j]=size&255;size>>>=8;}parts.push(...head,...payload);if(payload.length)expected.push(0,0,0,1,...payload);}
  const input=Uint8Array.from(parts),allowed=input.length<=64&&prefixSize<=64&&expected.length<=64;
  if(allowed){const output=avcPacketToAnnexB(input,lengthSize,64,4,prefix);prefix.fill(255);input.fill(255);expect([...output]).toEqual(expected);}else expect(()=>avcPacketToAnnexB(input,lengthSize,64,4,prefix)).toThrow();cases++;
 }
 expect(cases).toBe(384);
});
