import {describe,expect,it} from 'vitest';
import type {MediaPacket} from '@edge-ffmpeg/avutil';
import {containerFormat,containerOutputListing} from '@edge-ffmpeg/containers';
import {adler32Update,crc32IeeeLe,createDigest,digestHex} from '../../packages/containers/src/hash/digests.js';
import {crc,hash,md5,muxHash,streamhash,validateHashOutput} from '../../packages/containers/src/hash/hash-mux.js';
const text=(value:string)=>new TextEncoder().encode(value),repeat=(value:string,count:number)=>text(value.repeat(count));
const hexOf=(name:string,...parts:Uint8Array[])=>{const digest=createDigest(name)!;for(const part of parts)digest.update(part);return digestHex(digest);};
const pseudo=(length:number)=>{const bytes=new Uint8Array(length);let x=0x12345678;for(let i=0;i<length;i++){x=(Math.imul(x,1103515245)+12345)>>>0;bytes[i]=x>>>24;}return bytes;};
function sink(options:{failWrite?:number}={}){
  const chunks:Uint8Array[]=[],state={commits:0,aborts:0,writes:0,max:0};
  return {chunks,state,handle:{async write(chunk:Uint8Array){state.writes++;if(state.writes===options.failWrite)throw new Error('write failed');state.max=Math.max(state.max,chunk.length);chunks.push(chunk.slice());},async commit(){state.commits++;},async abort(){state.aborts++;}},text:()=>new TextDecoder().decode(Buffer.concat(chunks))};
}
async function* packetsOf(parts:readonly Uint8Array[],streamIndex=0):AsyncIterable<MediaPacket>{let pts=0n;for(const data of parts){yield {streamIndex,data,pts,dts:pts,duration:BigInt(data.length/2),timeBase:{num:1n,den:8000n},flags:1};pts+=BigInt(data.length/2);}}
describe('hash digests',()=>{
  it('matches RFC 1321 MD5 test vectors',()=>{
    const vectors:[string,string][]=[['','d41d8cd98f00b204e9800998ecf8427e'],['a','0cc175b9c0f1b6a831c399e269772661'],['abc','900150983cd24fb0d6963f7d28e17f72'],['message digest','f96b697d7cb7938d525a2f31aaf161d0'],['abcdefghijklmnopqrstuvwxyz','c3fcd3d76192e4007dfb496cca67e13b'],['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789','d174ab98d277d9f5a5611c2c9f419d9f'],['1234567890'.repeat(8),'57edf4a22be3c955ac49da2e2107b67a']];
    for(const [input,expected] of vectors)expect(hexOf('md5',text(input)),input).toBe(expected);
  });
  it('matches FIPS 180-4 SHA-1 SHA-224 and SHA-256 test vectors',()=>{
    const two='abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',million=repeat('a',1000000);
    expect(hexOf('sha160',text('abc'))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(hexOf('sha160',text(two))).toBe('84983e441c3bd26ebaae4aa1f95129e5e54670f1');
    expect(hexOf('sha160',million)).toBe('34aa973cd4c4daa4f61eeb2bdbad27316534016f');
    expect(hexOf('sha224',text('abc'))).toBe('23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7');
    expect(hexOf('sha224',text(two))).toBe('75388b16512776cc5dba5da1fd890150b0c6455cb4f58b1952522525');
    expect(hexOf('sha256',text(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hexOf('sha256',text('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hexOf('sha256',text(two))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(hexOf('sha256',million)).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
    expect(createDigest('SHA256')!.name).toBe('SHA256');
  });
  it('matches CRC32 IEEE and adler32 test vectors with their seeds',()=>{
    expect(hexOf('crc32',text('123456789'))).toBe('cbf43926');
    expect(hexOf('crc32',text('The quick brown fox jumps over the lazy dog'))).toBe('414fa339');
    expect(hexOf('crc32',new Uint8Array(0))).toBe('00000000');
    expect(crc32IeeeLe(0xffffffff,text('123456789'))^0xffffffff).toBe(0xcbf43926|0);
    expect(hexOf('adler32',text('Wikipedia'))).toBe('11e60398');
    expect(adler32Update(1,new Uint8Array(0))).toBe(1);
    expect(adler32Update(0,new Uint8Array(0))).toBe(0);
    expect(adler32Update(1,new Uint8Array(100000).fill(255))).toBe(adler32Update(adler32Update(1,new Uint8Array(54321).fill(255)),new Uint8Array(45679).fill(255)));
    // Large maximal input: the deferred modulo never overflows the exact sums.
    let a=1,b=0;const ones=new Uint8Array(70000).fill(255);for(const v of ones){a=(a+v)%65521;b=(b+a)%65521;}expect(adler32Update(1,ones)).toBe((b*65536+a)>>>0);
  });
  it('gives chunk-independent digests under a 128-byte write budget and refuses unknown names',()=>{
    const data=pseudo(4097*6);
    for(const name of ['md5','sha160','sha224','sha256','crc32','adler32']){
      const whole=hexOf(name,data),chunks:Uint8Array[]=[];for(let offset=0;offset<data.length;offset+=offset%7+1+(offset%3)*61)chunks.push(data.subarray(offset,Math.min(data.length,offset+offset%7+1+(offset%3)*61)));
      expect(hexOf(name,...chunks),name).toBe(whole);
      const fixed:Uint8Array[]=[];for(let offset=0;offset<data.length;offset+=128)fixed.push(data.subarray(offset,offset+128));expect(hexOf(name,...fixed),name).toBe(whole);
    }
    for(const name of ['murmur3','ripemd160','sha384','sha512','sha512/256','constructor'])expect(createDigest(name),name).toBeNull();
    const digest=createDigest('md5')!;digest.final();expect(()=>digest.final()).toThrow('finalized');expect(()=>digest.update(text('a'))).toThrow('finalized');
    const controller=new AbortController();controller.abort(new Error('stop'));
    for(const name of ['md5','sha256','crc32','adler32'])expect(()=>createDigest(name)!.update(data,controller.signal),name).toThrow('stop');
  });
});
describe('hash muxers',()=>{
  it('registers four output-only descriptors with their native defaults and options',()=>{
    for(const [descriptor,name,options] of [[md5,'md5',['-hash']],[hash,'hash',['-hash']],[crc,'crc',undefined],[streamhash,'streamhash',['-hash']]] as const){
      expect(containerFormat(name)).toBe(descriptor);expect(descriptor.name).toBe(name);expect('demux' in descriptor).toBe(false);
      const mux=descriptor.mux;expect(mux).toMatchObject({label:name,defaultCodec:'pcm_s16le',scratchBytes:256,dropsMetadata:true});expect(mux.options).toEqual(options);expect('extensions' in mux).toBe(false);expect('order' in mux).toBe(false);
      for(const codec of ['pcm_u8','pcm_s16le','pcm_f64be','pcm_alaw','pcm_u32le'] as const)expect(mux.supports(codec)).toBe(true);
      expect(Object.isFrozen(descriptor)&&Object.isFrozen(mux)).toBe(true);
    }
    // Other registered muxers also appear in the listing; assert this module's entries and their relative order.
    const listed=containerOutputListing.split(', ');expect(listed.filter(name=>['framecrc','crc','hash','md5','streamhash'].includes(name))).toEqual(['framecrc','crc','hash','md5','streamhash']);
  });
  it('writes the native trailer lines of the concatenated payloads independent of packet boundaries',async()=>{
    const data=pseudo(4000),split=[data.subarray(0,2),data.subarray(2,1026),data.subarray(1026)];
    const expected={md5:`MD5=${hexOf('md5',data)}\n`,hash:`SHA256=${hexOf('sha256',data)}\n`,crc:`CRC=0x${adler32Update(1,data).toString(16).padStart(8,'0')}\n`,streamhash:`0,a,SHA256=${hexOf('sha256',data)}\n`};
    for(const name of ['md5','hash','crc','streamhash'] as const)for(const parts of [[data],split]){
      const out=sink();await muxHash(out.handle,name,packetsOf(parts),{maxWriteBytes:128});expect(out.text(),name).toBe(expected[name]);expect(out.state).toMatchObject({commits:1,aborts:0});expect(out.state.max).toBeLessThanOrEqual(128);
      const small=sink();await muxHash(small.handle,name,packetsOf(parts),{maxWriteBytes:7});expect(small.text()).toBe(expected[name]);expect(small.state.max).toBeLessThanOrEqual(7);
    }
    const empty=sink();await muxHash(empty.handle,'crc',packetsOf([]),{maxWriteBytes:128});expect(empty.text()).toBe('CRC=0x00000001\n');
    const none=sink();await muxHash(none.handle,'md5',packetsOf([]),{maxWriteBytes:128});expect(none.text()).toBe('MD5=d41d8cd98f00b204e9800998ecf8427e\n');
  });
  it('aborts the output exactly once on write failures invalid packets budgets and cancellation',async()=>{
    const failing=sink({failWrite:2});await expect(muxHash(failing.handle,'md5',packetsOf([pseudo(10)]),{maxWriteBytes:8})).rejects.toThrow('write failed');expect(failing.state).toMatchObject({commits:0,aborts:1});
    const stream=sink();await expect(muxHash(stream.handle,'hash',packetsOf([pseudo(10)],1),{maxWriteBytes:128})).rejects.toThrow('Invalid hash muxer packet');expect(stream.state).toMatchObject({commits:0,aborts:1,writes:0});
    const budget=sink();await expect(muxHash(budget.handle,'crc',packetsOf([pseudo(10)]),{maxWriteBytes:0})).rejects.toThrow('Invalid hash muxer write budget');expect(budget.state.aborts).toBe(1);
    const controller=new AbortController(),cancelled=sink();
    async function* abortAfterFirst():AsyncIterable<MediaPacket>{yield* packetsOf([pseudo(10)]);controller.abort(new Error('cancelled'));yield* packetsOf([pseudo(10)]);}
    await expect(muxHash(cancelled.handle,'streamhash',abortAfterFirst(),{maxWriteBytes:128,signal:controller.signal})).rejects.toThrow('cancelled');expect(cancelled.state).toMatchObject({commits:0,aborts:1,writes:0});
    const broken={async write(){throw new Error('w');},async commit(){},async abort(){throw new Error('a');}};
    await expect(muxHash(broken,'md5',packetsOf([]),{maxWriteBytes:128})).rejects.toThrow('Hash muxer output and abort failed');
  });
  it('refuses any -hash value before output since only the default algorithm is implemented',()=>{
    for(const name of ['md5','hash','streamhash'] as const)for(const value of ['md5','sha256','murmur3'])expect(()=>validateHashOutput(name,[{name:'-hash',value}]),`${name}/${value}`).toThrow(`The ${name} muxer -hash option is not implemented`);
    expect(()=>md5.mux.validate!({codec:'pcm_s16le',channels:1,sampleRate:8000,channelMask:null,layoutMask:null,channelLayout:'',samples:0n,bitexact:false,options:[]})).not.toThrow();
  });
});
