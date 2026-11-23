import {expect,it} from 'vitest';
import {aacConfiguration} from '../../packages/containers/src/mp4/aac.js';
function entry(payload:number[]){
 const specific=[5,payload.length,...payload],decoder=[4,13+specific.length,0x40,0x15,...new Array<number>(11).fill(0),...specific],es=[3,3+decoder.length,0,1,0,...decoder],bytes=new Uint8Array(48+es.length),view=new DataView(bytes.buffer);
 view.setUint32(0,bytes.length);bytes.set([109,112,52,97],4);view.setUint32(36,12+es.length);bytes.set([101,115,100,115],40);bytes.set(es,48);return bytes;
}
it('reads Native-equivalent explicit AAC frequency and rejects truncated bits',()=>{
 // AAC-LC mono44100: standard ASC1208 and explicit ASC1780562208.
 const expected={sampleRate:44100,channels:1,frameSamples:1024};
 expect(aacConfiguration(entry([0x12,0x08]))).toEqual(expected);
 expect(aacConfiguration(entry([0x17,0x80,0x56,0x22,0x08]))).toEqual(expected);
 expect(()=>aacConfiguration(entry([0x17,0x80,0x56,0x22]))).toThrow(/Truncated AAC configuration bits/);
});
