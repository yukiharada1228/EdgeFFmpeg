// Records the clock-expression-value oracle (tools/differential-runner/video-output/value-oracle.c:
// av_expr_parse_and_eval -> av_strtod -> the host C library's strtod) on the 324 signed hexadecimal samples, for the
// pinned reference of this host, through platform-corpus.mjs. Committed linux-x64 output comes only from the corpora
// job of .github/workflows/linux-probe.yml (node tools/linux/generate-corpora.mjs --only clock-expression-hex);
// anywhere else pass --draft. darwin-arm64 has no stored observation: its test compares with the live oracle only.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {corpusTarget,writePlatformCorpus} from '../platform-corpus.mjs';
import {sha256} from '../reference-identity.mjs';
import {clockHexSamples} from './samples.mjs';

const root=resolve(import.meta.dirname,'../../..'),generator='tools/differential-runner/clock-expression-hex/generate.mjs',oracleDir=resolve(root,'.build/oracles/clock-expression-value');
const target=corpusTarget('compat/behavior-specs/clock-expression-hex',generator,{root});
if(target.legacyLayout&&!target.draft)throw new Error('darwin-arm64 keeps no stored clock-expression-hex observation; its test compares with the live oracle');
const oracle=JSON.parse(readFileSync(resolve(oracleDir,'provenance.json'),'utf8')),binary=resolve(oracleDir,'native');
if(sha256(readFileSync(binary))!==oracle.binarySha256)throw new Error('The clock-expression-value oracle differs from its build provenance; rebuild it with build-oracle.mjs');
if(JSON.stringify(oracle.reference)!==JSON.stringify(target.identity.metadata))throw new Error('The clock-expression-value oracle was built against another reference');
const source=relative(root,oracle.source);if(source!=='tools/differential-runner/video-output/value-oracle.c'||sha256(readFileSync(resolve(root,source)))!==oracle.sourceSha256)throw new Error('The clock-expression-value oracle source changed since it was built');
const libc=process.report.getReport().header.glibcVersionRuntime??null;
const rows=clockHexSamples().map(value=>{const result=JSON.parse(execFileSync(binary,[value],{encoding:'utf8',timeout:5000}));if(typeof result.accepted!=='boolean'||!/^[0-9a-f]{16}$/.test(result.bits))throw new Error(`Unexpected oracle output for ${value}`);return {value,accepted:result.accepted,bits:result.bits};});
const cases={schema:'edge-ffmpeg/clock-expression-hex@1',scope:'av_expr_parse_and_eval of signed hexadecimal literals through av_strtod and the host C library strtod; the 324 samples of tests/differential/video-clock-hex-value.test.ts in test order',
 libc:{glibcVersionRuntime:libc},oracle:{source,sourceSha256:oracle.sourceSha256,binarySha256:oracle.binarySha256,compilerVersion:oracle.compilerVersion,librarySha256:Object.fromEntries(Object.entries(oracle.librarySha256).map(([path,digest])=>[relative(root,path),digest]))},rows};
const written=writePlatformCorpus(target,{'cases.json':cases},{root});
console.log(JSON.stringify({dir:written.dir,rows:rows.length,glibc:libc}));
