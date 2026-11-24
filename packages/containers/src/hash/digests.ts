// SPDX-License-Identifier: LGPL-2.1-or-later
// Scoped port of libavutil/md5.c, sha.c, crc.c (AV_CRC_32_IEEE_LE), adler32.c and hash.c (pinned FFmpeg 946fcce0). See ../../NOTICE-HASH.
/** Incremental integer digests; output and state are independent of update boundaries. */
export interface Digest {readonly name:string;readonly size:number;update(data:Uint8Array,signal?:AbortSignal):void;final():Uint8Array}
export type DigestName='MD5'|'SHA160'|'SHA224'|'SHA256'|'CRC32'|'adler32';
const step=4096;
const hex=(bytes:Uint8Array)=>Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
/** av_hash_final_hex: lower-case hex of the final digest. */
export function digestHex(digest:Digest):string{return hex(digest.final());}
/** Block-buffered Merkle-Damgard core shared by MD5 and SHA-1/SHA-2; the length is bit-counted modulo 2^64. */
abstract class BlockDigest implements Digest{
  abstract readonly name:string;abstract readonly size:number;protected abstract readonly bigEndian:boolean;
  private readonly block=new Uint8Array(64);private used=0;private length=0n;private done=false;
  protected abstract compress(block:DataView):void;protected abstract output():Uint8Array;
  update(data:Uint8Array,signal?:AbortSignal):void{
    if(this.done)throw new Error('Digest already finalized');
    this.length+=BigInt(data.length);
    for(let offset=0;offset<data.length;){
      if((offset&(step-1))<64)signal?.throwIfAborted();
      const count=Math.min(64-this.used,data.length-offset);this.block.set(data.subarray(offset,offset+count),this.used);this.used+=count;offset+=count;
      if(this.used===64){this.compress(new DataView(this.block.buffer));this.used=0;}
    }
  }
  final():Uint8Array{
    if(this.done)throw new Error('Digest already finalized');
    const bits=(this.length*8n)&0xffffffffffffffffn,view=new DataView(this.block.buffer);
    this.block[this.used++]=0x80;
    if(this.used>56){this.block.fill(0,this.used);this.compress(view);this.used=0;}
    this.block.fill(0,this.used,56);view.setBigUint64(56,bits,!this.bigEndian);this.compress(view);this.done=true;
    return this.output();
  }
}
const md5Shift=[7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21],md5K=Array.from({length:64},(_,i)=>Math.floor(Math.abs(Math.sin(i+1))*2**32)>>>0);
class Md5 extends BlockDigest{
  readonly name='MD5';readonly size=16;protected readonly bigEndian=false;private readonly h=[0x67452301,0xefcdab89,0x98badcfe,0x10325476];
  protected compress(block:DataView):void{
    let [a,b,c,d]=this.h as [number,number,number,number];
    for(let i=0;i<64;i++){
      const round=i>>4,f=round===0?(b&c)|(~b&d):round===1?(d&b)|(~d&c):round===2?b^c^d:c^(b|~d),g=round===0?i:round===1?(5*i+1)&15:round===2?(3*i+5)&15:(7*i)&15;
      const sum=(a+f+md5K[i]!+block.getUint32(g*4,true))>>>0,shift=md5Shift[round*4+(i&3)]!;
      a=d;d=c;c=b;b=(b+((sum<<shift)|(sum>>>(32-shift))))>>>0;
    }
    this.h[0]=(this.h[0]!+a)>>>0;this.h[1]=(this.h[1]!+b)>>>0;this.h[2]=(this.h[2]!+c)>>>0;this.h[3]=(this.h[3]!+d)>>>0;
  }
  protected output():Uint8Array{const out=new Uint8Array(16),view=new DataView(out.buffer);this.h.forEach((word,i)=>view.setUint32(i*4,word,true));return out;}
}
const rotl=(x:number,n:number)=>(x<<n)|(x>>>(32-n)),rotr=(x:number,n:number)=>(x>>>n)|(x<<(32-n));
class Sha1 extends BlockDigest{
  readonly name='SHA160';readonly size=20;protected readonly bigEndian=true;private readonly h=[0x67452301,0xefcdab89,0x98badcfe,0x10325476,0xc3d2e1f0];private readonly w=new Uint32Array(80);
  protected compress(block:DataView):void{
    const w=this.w;for(let i=0;i<16;i++)w[i]=block.getUint32(i*4,false);for(let i=16;i<80;i++)w[i]=rotl(w[i-3]!^w[i-8]!^w[i-14]!^w[i-16]!,1);
    let [a,b,c,d,e]=this.h as [number,number,number,number,number];
    for(let i=0;i<80;i++){
      const f=i<20?(b&c)|(~b&d):i<40?b^c^d:i<60?(b&c)|(b&d)|(c&d):b^c^d,k=i<20?0x5a827999:i<40?0x6ed9eba1:i<60?0x8f1bbcdc:0xca62c1d6;
      const t=(rotl(a,5)+f+e+k+w[i]!)>>>0;e=d;d=c;c=rotl(b,30)>>>0;b=a;a=t;
    }
    [a,b,c,d,e].forEach((v,i)=>{this.h[i]=(this.h[i]!+v)>>>0;});
  }
  protected output():Uint8Array{const out=new Uint8Array(20),view=new DataView(out.buffer);this.h.forEach((word,i)=>view.setUint32(i*4,word,false));return out;}
}
const sha256K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
class Sha2 extends BlockDigest{
  readonly name:'SHA224'|'SHA256';readonly size:number;protected readonly bigEndian=true;private readonly h:Uint32Array;private readonly w=new Uint32Array(64);
  constructor(bits:224|256){super();this.name=bits===224?'SHA224':'SHA256';this.size=bits/8;this.h=new Uint32Array(bits===224?[0xc1059ed8,0x367cd507,0x3070dd17,0xf70e5939,0xffc00b31,0x68581511,0x64f98fa7,0xbefa4fa4]:[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);}
  protected compress(block:DataView):void{
    const w=this.w,h=this.h;for(let i=0;i<16;i++)w[i]=block.getUint32(i*4,false);
    for(let i=16;i<64;i++){const x=w[i-15]!,y=w[i-2]!;w[i]=(rotr(y,17)^rotr(y,19)^(y>>>10))+w[i-7]!+(rotr(x,7)^rotr(x,18)^(x>>>3))+w[i-16]!;}
    let a=h[0]!,b=h[1]!,c=h[2]!,d=h[3]!,e=h[4]!,f=h[5]!,g=h[6]!,k=h[7]!;
    for(let i=0;i<64;i++){
      const t1=(k+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+sha256K[i]!+w[i]!)>>>0,t2=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
      k=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    h[0]=h[0]!+a;h[1]=h[1]!+b;h[2]=h[2]!+c;h[3]=h[3]!+d;h[4]=h[4]!+e;h[5]=h[5]!+f;h[6]=h[6]!+g;h[7]=h[7]!+k;
  }
  protected output():Uint8Array{const out=new Uint8Array(this.size),view=new DataView(out.buffer);for(let i=0;i<this.size/4;i++)view.setUint32(i*4,this.h[i]!,false);return out;}
}
const crcTable=(()=>{const table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}return table;})();
/** av_crc with AV_CRC_32_IEEE_LE (reflected 0xEDB88320), no pre- or post-inversion. */
export function crc32IeeeLe(crc:number,data:Uint8Array,signal?:AbortSignal):number{
  let c=crc>>>0;for(let i=0;i<data.length;i++){if((i&(step-1))===0)signal?.throwIfAborted();c=crcTable[(c^data[i]!)&255]!^(c>>>8);}return c>>>0;
}
/** av_adler32_update: modular sums with the caller's seed (1 for crc and hash, 0 for framecrc). */
export function adler32Update(adler:number,data:Uint8Array,signal?:AbortSignal):number{
  let a=adler&65535,b=adler>>>16;
  for(let offset=0;offset<data.length;){signal?.throwIfAborted();const end=Math.min(data.length,offset+step);for(;offset<end;offset++){a+=data[offset]!;b+=a;if((offset&1023)===1023){a%=65521;b%=65521;}}a%=65521;b%=65521;}
  return (b*65536+a)>>>0;
}
class Checksum implements Digest{
  readonly size=4;private value:number;private done=false;
  constructor(readonly name:'CRC32'|'adler32'){this.value=name==='CRC32'?0xffffffff:1;}
  update(data:Uint8Array,signal?:AbortSignal):void{if(this.done)throw new Error('Digest already finalized');this.value=this.name==='CRC32'?crc32IeeeLe(this.value,data,signal):adler32Update(this.value,data,signal);}
  final():Uint8Array{if(this.done)throw new Error('Digest already finalized');this.done=true;const out=new Uint8Array(4);new DataView(out.buffer).setUint32(0,this.name==='CRC32'?(this.value^0xffffffff)>>>0:this.value,false);return out;}
}
const names:Readonly<Record<string,DigestName>>={md5:'MD5',sha160:'SHA160',sha224:'SHA224',sha256:'SHA256',crc32:'CRC32',adler32:'adler32'};
/** av_hash_alloc for the implemented subset; names are matched case-insensitively as av_strcasecmp does. Others return null. */
export function createDigest(name:string):Digest|null{
  const id=names[name.toLowerCase()];
  switch(id){case 'MD5':return new Md5();case 'SHA160':return new Sha1();case 'SHA224':return new Sha2(224);case 'SHA256':return new Sha2(256);case 'CRC32':case 'adler32':return new Checksum(id);default:return null;}
}
