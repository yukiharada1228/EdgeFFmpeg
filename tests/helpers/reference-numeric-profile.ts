import type {ExpressionNumericProfile} from '@edge-ffmpeg/avutil';
import {pinnedReference} from './reference-identity.js';
/** The executing host's C library as Node reports it; glibcVersionRuntime is absent outside glibc. */
export interface ReferenceHostLibc {readonly glibcVersionRuntime?:string|undefined}
/**
 * Test configuration for the verified pinned reference, never execution-host autodetection: darwin-arm64 for the
 * darwin-arm64 pin, linux-x64 for the linux-x64 pin. The linux-x64 profile models the GCC x86-64 build run against
 * glibc 2.36 of the pinned image (float-to-int64 casts, strtod), so another glibc is refused: native oracles compiled
 * on the host link the host libc.
 */
export function selectReferenceNumericProfile(reference:{readonly id:string},host:ReferenceHostLibc):ExpressionNumericProfile{
 if(reference.id==='darwin-arm64'){if(host.glibcVersionRuntime!==undefined)throw new Error(`Unverified native numeric profile: darwin-arm64 reference with glibc ${host.glibcVersionRuntime}`);return 'darwin-arm64';}
 if(reference.id==='linux-x64'){if(host.glibcVersionRuntime!=='2.36')throw new Error(`Unverified native numeric profile: the linux-x64 profile was confirmed against glibc 2.36 of the pinned image, not ${host.glibcVersionRuntime===undefined?'a non-glibc C library':'glibc '+host.glibcVersionRuntime}`);return 'linux-x64';}
 throw new Error(`Unverified native numeric profile for reference ${reference.id}`);
}
export function hostLibc():ReferenceHostLibc{return {glibcVersionRuntime:(process.report.getReport() as {header?:{glibcVersionRuntime?:string}}).header?.glibcVersionRuntime};}
/** The numeric profile of the verified local reference (tests/helpers/reference-identity.ts) on this host's C library. */
export function referenceNumericProfile():ExpressionNumericProfile{return selectReferenceNumericProfile(pinnedReference(),hostLibc());}
/**
 * The native outcome of an output frame count on the reference, as an explicit table rather than Edge's rule:
 * darwin-arm64 accepts every count the frame-limit tests use; linux-x64 rejects 9223372036854775807, whose double is
 * 2^63 (fftools parse_number, x86-64 CVTTSD2SI), with AVERROR(EINVAL).
 */
export function nativeFrameCountOutcome(profile:ExpressionNumericProfile,option:string,value:string):{readonly accepted:true}|{readonly accepted:false;readonly status:234;readonly message:string}{
 if(profile==='linux-x64'&&value==='9223372036854775807')return {accepted:false,status:234,message:`Expected int64 for ${option} but found ${value}`};
 return {accepted:true};
}
