import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {evaluateExpression,hexFloatLiteral} from '@edge-ffmpeg/avutil';
import {nativeFrameLimitOption,nativeFrameLimitRejection} from '@edge-ffmpeg/cli';
import {FFmpeg} from '@edge-ffmpeg/core';
import type {VirtualFileSystem} from '@edge-ffmpeg/core';
import {createMediaBackend,createTimedVideoBackend} from '@edge-ffmpeg/avformat';
import {evaluateClockExpression} from '../../packages/avformat/src/video-output/clock-expression.js';
import {parseEncoderTimeBase} from '../../packages/avformat/src/video-output/encoder-ratio.js';
import {clockHexSamples} from '../../tools/differential-runner/clock-expression-hex/samples.mjs';
import {selectReferenceNumericProfile} from '../helpers/reference-numeric-profile.js';
import {trackedPlatformCorpusDir,verifyTrackedPlatformCorpus} from '../helpers/reference-identity.js';

const bits=(value:number)=>{const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,value,false);return view.getBigUint64(0,false).toString(16).padStart(16,'0');};

describe('linux-x64 glibc 2.36 hexadecimal strtod rounding',()=>{
 it('drops a lone 54th significant bit only when rounding into the subnormal range',()=>{
  // [literal, darwin-arm64 (correct), linux-x64 (glibc 2.36)]; the last eight are host outputs of the pinned image's glibc.
  const rows:[string,string,string][]=[
   ['0x1.00000000000008p-1075','0000000000000001','0000000000000000'],['-0x1.00000000000008p-1075','8000000000000001','8000000000000000'],
   ['0x1.000000000000081p-1075','0000000000000001','0000000000000001'],['0x1.0000000000001p-1075','0000000000000001','0000000000000001'],
   ['0x1p-1075','0000000000000000','0000000000000000'],['0x1.8p-1075','0000000000000001','0000000000000001'],['0x1.00000000000008p-1074','0000000000000001','0000000000000001'],
   ['0x1.00000000000008p0','3ff0000000000000','3ff0000000000000'],['0x1.00000000000018p0','3ff0000000000002','3ff0000000000002'],['0x1.00000000000008p-1022','0010000000000000','0010000000000000'],
   ['+0xc51cb3d1a04324.p-1080','00031472cf46810d','00031472cf46810c'],['-0xb53.c263900d98c0p-1034','800b53c263900d99','800b53c263900d98'],
   ['0xbe4989cf9c9a5.4p-1075','0005f24c4e7ce4d3','0005f24c4e7ce4d2'],['-0x293ce8bf74a063p-1076','800a4f3a2fdd2819','800a4f3a2fdd2818'],
   ['0xada.50cddd1e354p-1035','00056d2866ee8f1b','00056d2866ee8f1a'],['-0xb7e.6fd20d3a894p-1035','8005bf37e9069d45','8005bf37e9069d44'],
   ['+0xba.3de04a08bf0cp-1030','000ba3de04a08bf1','000ba3de04a08bf0'],['-0x95b64c6fa0836.cp-1074','80095b64c6fa0837','80095b64c6fa0836']];
  for(const [literal,darwin,linux]of rows){expect(bits(hexFloatLiteral(literal,'darwin-arm64')),literal).toBe(darwin);expect(bits(hexFloatLiteral(literal,'linux-x64')),literal).toBe(linux);}
  expect(()=>hexFloatLiteral('0x1p0','win32-x64' as 'linux-x64')).toThrow('Unknown numeric profile');expect(()=>hexFloatLiteral('0x.p0','linux-x64')).toThrow('Not a hexadecimal');
 });
 it('reaches -enc_time_base: the glibc +0 makes a timebase expression default instead of 1/1',()=>{
  expect(parseEncoderTimeBase('--0x1.00000000000008p-1075*2^537*2^537')).toEqual({num:1n,den:1n});
  expect(parseEncoderTimeBase('--0x1.00000000000008p-1075*2^537*2^537','linux-x64')).toBeUndefined();
  expect(()=>evaluateClockExpression('1','win32-x64' as 'linux-x64')).toThrow('Unknown clock expression numeric profile');
 });
 it('reproduces the tracked linux-x64 oracle observation through both expression evaluators',()=>{
  const base='compat/behavior-specs/clock-expression-hex',provenance=verifyTrackedPlatformCorpus(base,'linux-x64');
  expect(provenance.generator.path).toBe('tools/differential-runner/clock-expression-hex/generate.mjs');
  const observed=JSON.parse(readFileSync(join(trackedPlatformCorpusDir(base,'linux-x64'),'cases.json'),'utf8')) as {libc:{glibcVersionRuntime:string|null};rows:{value:string;accepted:boolean;bits:string}[]};
  expect(observed.libc.glibcVersionRuntime).toBe('2.36');expect(observed.rows.map(row=>row.value)).toEqual(clockHexSamples());expect(observed.rows.every(row=>row.accepted)).toBe(true);
  const glibcOnly:string[]=[];
  for(const row of observed.rows){
   expect(bits(evaluateClockExpression(row.value,'linux-x64')),row.value).toBe(row.bits);expect(bits(evaluateExpression(row.value,{numericProfile:'linux-x64'})),row.value).toBe(row.bits);
   if(bits(evaluateClockExpression(row.value,'darwin-arm64'))!==row.bits)glibcOnly.push(row.value);
  }
  expect(glibcOnly).toEqual(['--0x1.00000000000008p-1075','+-0x1.00000000000008p-1075','-+0x1.00000000000008p-1075','++0x1.00000000000008p-1075']);
 });
});

describe('x86-64 float-to-int64 frame-count rejection',()=>{
 it('rejects exactly the decimal counts whose double is 2^63 under linux-x64',()=>{
  for(const [value,rejected]of [['9223372036854775295',false],['9223372036854775296',true],['9223372036854775807',true],['+09223372036854775807',true],['9223372036854775808',true],['9223372036854776832',true],['9223372036854776833',false],['-9223372036854775808',false],['-9223372036854775807',false],['1',false],['-1',false],['9.2e18',false],['0x7fffffffffffffff',false]] as const){
   expect(nativeFrameLimitRejection('-frames:a',value,'linux-x64'),value).toBe(rejected?`Expected int64 for frames:a but found ${value}`:null);
   expect(nativeFrameLimitRejection('-frames:a',value,'darwin-arm64'),value).toBeNull();
   if(/^[+-]?\d+$/.test(value))expect(Number(value)===2**63,value).toBe(rejected);
  }
  for(const [name,option]of [['-frames','frames'],['-frames:a','frames:a'],['-frames:v:0','frames:v:0'],['-frames:0','frames:0'],['-aframes','frames:a'],['-vframes','frames:v'],['-dframes','frames:d'],['-framerate',null],['-f',null],['-frames:',null]] as const)expect(nativeFrameLimitOption(name),name).toBe(option);
  expect(nativeFrameLimitRejection('-t','9223372036854775807','linux-x64')).toBeNull();expect(()=>nativeFrameLimitRejection('-frames','1','x86_64' as 'linux-x64')).toThrow('Unknown native numeric profile');
 });
 it('fails both backends before any input or output is opened, with the native message and exit status',async()=>{
  let opened=0;const filesystem:VirtualFileSystem={async openRead(){opened++;throw new Error('no input');},async openWrite(){opened++;throw new Error('no output');}},budget={maxResidentBytes:65536,maxBufferBytes:4096,maxPendingPackets:2,maxCpuTimeMs:1000};
  const argv=['-f','s16le','-ar','8000','-ac','1','-i','/in.raw','-c:a','copy','-vframes','2','-frames:a','9223372036854775807','-f','framecrc','/out.crc'];
  for(const backend of [createMediaBackend({numericProfile:'linux-x64'}),createMediaBackend({pixelArithmetic:'x86_64'}),createTimedVideoBackend({storage:()=>{throw new Error('no store');},limits:{numericProfile:'linux-x64',maxEvents:4}})]){
   const result=await new FFmpeg({filesystem,backend,budget}).exec(argv);
   expect(result.exitCode).toBe(234);expect(result.diagnostics.at(-1)).toEqual({code:'invalid-arguments',message:'Expected int64 for frames:a but found 9223372036854775807'});
  }
  expect(opened).toBe(0);
  const darwin=await new FFmpeg({filesystem,backend:createMediaBackend(),budget}).exec(argv);expect(darwin.exitCode).not.toBe(234);expect(darwin.diagnostics.at(-1)?.message).not.toContain('Expected int64');
  expect(()=>createMediaBackend({numericProfile:'x86_64' as 'linux-x64'})).toThrow('Invalid native numeric profile');
 });
});

describe('reference numeric profile selection',()=>{
 it('selects the pinned reference profile and refuses an unverified C library or platform',()=>{
  expect(selectReferenceNumericProfile({id:'darwin-arm64'},{})).toBe('darwin-arm64');
  expect(selectReferenceNumericProfile({id:'linux-x64'},{glibcVersionRuntime:'2.36'})).toBe('linux-x64');
  expect(()=>selectReferenceNumericProfile({id:'linux-x64'},{glibcVersionRuntime:'2.39'})).toThrow('confirmed against glibc 2.36 of the pinned image, not glibc 2.39');
  expect(()=>selectReferenceNumericProfile({id:'linux-x64'},{})).toThrow('not a non-glibc C library');
  expect(()=>selectReferenceNumericProfile({id:'darwin-arm64'},{glibcVersionRuntime:'2.36'})).toThrow('darwin-arm64 reference with glibc 2.36');
  expect(()=>selectReferenceNumericProfile({id:'linux-arm64'},{glibcVersionRuntime:'2.36'})).toThrow('for reference linux-arm64');
 });
});
