/** The biquad kernels of libavfilter/af_biquads.c (BIQUAD_DII/TDI/TDII/LATT/SVF/ZDF_FILTER) and the coefficient preparation of config_filter().
 * Shared by the biquad-family filters: each prepares its double coefficients, then runs one kernel per channel with a 4-value cache.
 * s16p computes in float, s32p in double, fltp in float and dblp in double. Float kernels round to float after every operation (FLT_EVAL_METHOD 0, no FMA contraction). */
export type BiquadKind='s16'|'s32'|'flt'|'dbl';
export type BiquadTransform='dii'|'tdi'|'tdii'|'latt'|'svf'|'zdf';
export type BiquadPlane=Int16Array|Int32Array|Float32Array|Float64Array;
export type BiquadTriple=readonly [number,number,number];
/** Double coefficients as config_filter() leaves them in a_double/b_double, after normalisation and the transform conversion. */
export interface BiquadCoefficients {readonly a:BiquadTriple;readonly b:BiquadTriple}
/** Runs one channel: reads len samples of input, writes them to output (which may be the same array), updates the 4-value cache and returns the clip count. */
export type BiquadKernel=(input:BiquadPlane,output:BiquadPlane,len:number,cache:Float64Array)=>number;
export class BiquadNonFiniteError extends Error {}
export const biquadTransforms:readonly BiquadTransform[]=['dii','tdi','tdii','latt','svf','zdf'];
export const biquadKinds:readonly BiquadKind[]=['s16','s32','flt','dbl'];
/** Bytes of native cache per channel: ff_get_audio_buffer(outlink, 4 * sizeof(double)) holds 4 doubles. */
export const biquadCacheBytes=32;
const identity=(value:number)=>value;
/** The float type of a kernel: float for s16 and flt, double for s32 and dbl. */
export const biquadFloat=(kind:BiquadKind):(value:number)=>number=>kind==='s16'||kind==='flt'?Math.fround:identity;
/** a0 division and normalize in native order: a1, a2, b0, b1, b2 by the original a0, then a0 by itself; the normalize factor only when |sum b| > 1e-6. */
export function normalizeBiquad(oa:BiquadTriple,ob:BiquadTriple,normalize:boolean):BiquadCoefficients {
  const a=[oa[0],oa[1],oa[2]],b=[ob[0],ob[1],ob[2]];
  a[1]=a[1]!/a[0]!;a[2]=a[2]!/a[0]!;b[0]=b[0]!/a[0]!;b[1]=b[1]!/a[0]!;b[2]=b[2]!/a[0]!;a[0]=a[0]!/a[0]!;
  if(normalize&&Math.abs(b[0]!+b[1]!+b[2]!)>1e-6){const factor=(a[0]!+a[1]!+a[2]!)/(b[0]!+b[1]!+b[2]!);b[0]=b[0]!*factor;b[1]=b[1]!*factor;b[2]=b[2]!*factor;}
  return {a:[a[0]!,a[1]!,a[2]!],b:[b[0]!,b[1]!,b[2]!]};
}
/** convert_dir2latt. */
export function biquadLattice({a,b}:BiquadCoefficients):BiquadCoefficients {
  const k1=a[2],k0=a[1]/(1+k1),v2=b[2],v1=b[1]-v2*a[1],v0=b[0]-v1*k0-v2*k1;
  return {a:[a[0],k0,k1],b:[v0,v1,v2]};
}
/** convert_dir2svf. */
export function biquadStateVariable({a,b}:BiquadCoefficients):BiquadCoefficients {
  return {a:[a[0],-a[1],-a[2]],b:[b[1]-a[1]*b[0],b[2]-a[2]*b[0],b[0]]};
}
/** config_filter() for direct coefficients: normalise, then convert for latt and svf. zdf (convert_dir2zdf, filter type biquad) reads the raw option values instead. */
export function prepareBiquad(oa:BiquadTriple,ob:BiquadTriple,normalize:boolean,transform:BiquadTransform):BiquadCoefficients {
  const direct=normalizeBiquad(oa,ob,normalize);
  return transform==='latt'?biquadLattice(direct):transform==='svf'?biquadStateVariable(direct):transform==='zdf'?{a:[oa[0],oa[1],oa[2]],b:[ob[0],ob[1],ob[2]]}:direct;
}
const limits:Readonly<Record<BiquadKind,readonly [number,number]|null>>={s16:[-32768,32767],s32:[-2147483648,2147483647],flt:null,dbl:null};
/** Builds the kernel for one transform and working type. Coefficients and wet are copied to the kernel float type (a_float/b_float), dry is `1. - wet` in double, then stored in it. */
export function biquadKernel(transform:BiquadTransform,kind:BiquadKind,coefficients:BiquadCoefficients,mix:number):BiquadKernel {
  const r=biquadFloat(kind),[ca0,ca1,ca2]=coefficients.a.map(r) as [number,number,number],[cb0,cb1,cb2]=coefficients.b.map(r) as [number,number,number];
  const wet=r(mix),dry=r(1-wet),range=limits[kind],low=range?.[0]??0,high=range?.[1]??0;
  // Integer kernels clip to the type range and convert by truncation; float kernels store the value unclipped.
  const store=range?(output:BiquadPlane,index:number,out:number):number=>{
    if(Number.isNaN(out))throw new BiquadNonFiniteError('Non-finite biquad output is not implemented');
    if(out<low){output[index]=low;return 1;}if(out>high){output[index]=high;return 1;}output[index]=Math.trunc(out);return 0;
  }:(output:BiquadPlane,index:number,out:number):number=>{
    if(!Number.isFinite(out))throw new BiquadNonFiniteError('Non-finite biquad output is not implemented');output[index]=out;return 0;
  };
  const blend=(out:number,input:number)=>r(r(out*wet)+r(input*dry));
  switch(transform){
    case 'dii':{const a1=-ca1,a2=-ca2;return (input,output,len,cache)=>{
      let w1=cache[0]!,w2=cache[1]!,clips=0;
      for(let i=0;i<len;i++){const x=input[i]!,w0=r(r(x+r(a1*w1))+r(a2*w2));let out=r(r(r(cb0*w0)+r(cb1*w1))+r(cb2*w2));w2=w1;w1=w0;out=blend(out,x);clips+=store(output,i,out);}
      cache[0]=w1;cache[1]=w2;return clips;};}
    case 'tdi':{const a1=-ca1,a2=-ca2;return (input,output,len,cache)=>{
      let s1=cache[0]!,s2=cache[1]!,s3=cache[2]!,s4=cache[3]!,clips=0;
      for(let i=0;i<len;i++){
        const x=r(input[i]!+s1),t1=r(r(x*a1)+s2),t2=r(x*a2),t3=r(r(x*cb1)+s4),t4=r(x*cb2);let out=r(r(cb0*x)+s3);out=blend(out,x);
        s1=t1;s2=t2;s3=t3;s4=t4;clips+=store(output,i,out);
      }
      cache[0]=s1;cache[1]=s2;cache[2]=s3;cache[3]=s4;return clips;};}
    case 'tdii':{const a1=-ca1,a2=-ca2;return (input,output,len,cache)=>{
      let w1=cache[0]!,w2=cache[1]!,clips=0;
      for(let i=0;i<len;i++){const x=input[i]!;let out=r(r(cb0*x)+w1);w1=r(r(r(cb1*x)+w2)+r(a1*out));w2=r(r(cb2*x)+r(a2*out));out=blend(out,x);clips+=store(output,i,out);}
      cache[0]=w1;cache[1]=w2;return clips;};}
    case 'latt':{const k0=ca1,k1=ca2,v0=cb0,v1=cb1,v2=cb2;return (input,output,len,cache)=>{
      let s0=cache[0]!,s1=cache[1]!,clips=0;
      for(let i=0;i<len;i++){
        const x=input[i]!;let out=0,t0=r(x-r(k1*s0)),t1=r(r(t0*k1)+s0);out=r(out+r(t1*v2));
        t0=r(t0-r(k0*s1));t1=r(r(t0*k0)+s1);out=r(out+r(t1*v1));out=r(out+r(t0*v0));s0=t1;s1=t0;
        out=blend(out,x);clips+=store(output,i,out);
      }
      cache[0]=s0;cache[1]=s1;return clips;};}
    case 'svf':{const a1=ca1,a2=ca2;return (input,output,len,cache)=>{
      let s0=cache[0]!,s1=cache[1]!,clips=0;
      for(let i=0;i<len;i++){const x=input[i]!;let out=r(r(cb2*x)+s0);const t0=r(r(r(cb0*x)+r(a1*s0))+s1),t1=r(r(cb1*x)+r(a2*s0));s0=t0;s1=t1;out=blend(out,x);clips+=store(output,i,out);}
      cache[0]=s0;cache[1]=s1;return clips;};}
    case 'zdf':{const m0=cb0,m1=cb1,m2=cb2,a0=ca0,a1=ca1,a2=ca2;return (input,output,len,cache)=>{
      let b0=cache[0]!,b1=cache[1]!,clips=0;
      for(let i=0;i<len;i++){
        const v0=input[i]!,v3=r(v0-b1),v1=r(r(a0*b0)+r(a1*v3)),v2=r(r(b1+r(a1*b0))+r(a2*v3));
        b0=r(r(2*v1)-b0);b1=r(r(2*v2)-b1);let out=r(r(r(m0*v0)+r(m1*v1))+r(m2*v2));out=blend(out,v0);clips+=store(output,i,out);
      }
      cache[0]=b0;cache[1]=b1;return clips;};}
  }
}
