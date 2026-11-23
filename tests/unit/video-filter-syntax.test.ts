import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {filterToken,filterOptions} from '../../packages/avfilter/src/video-syntax.js';
interface Fixture {sourceCommit:string;reference:{commit:string;flags:string[]};libavutilSha256:string;oracles:Record<string,string>;tokenCases:{text:string;start:number;terminators:string;expected:{value:string;next:number}}[];optionCases:{options:string;shorthand:string[];expected:{key:string;value:string}[]|null}[]}
const fixture=JSON.parse(readFileSync('compat/behavior-specs/filter-syntax-native.json','utf8')) as Fixture;
function provenance(){
 const lock=JSON.parse(readFileSync('compat/upstream.lock.json','utf8')) as {commit:string;configureFile:string};expect(fixture.sourceCommit).toBe(lock.commit);expect(fixture.reference.commit).toBe(lock.commit);expect(fixture.reference.flags).toEqual(readFileSync(lock.configureFile,'utf8').trim().split(/\s+/));expect(fixture.libavutilSha256).toMatch(/^[0-9a-f]{64}$/);
 for(const name of ['token-oracle.c','option-oracle.c'])expect(fixture.oracles[name]).toBe(createHash('sha256').update(readFileSync('tools/differential-runner/filter-syntax/'+name)).digest('hex'));
}
it('matches fixed-reference token values and cursor positions for ASCII quoting and escapes',()=>{
 provenance();expect(fixture.tokenCases).toHaveLength(1024);for(const item of fixture.tokenCases)expect(filterToken(item.text,item.start,item.terminators),JSON.stringify(item)).toEqual(item.expected);
});
it('matches fixed-reference option pairs and shorthand rejection for ASCII quoting and escapes',()=>{
 provenance();expect(fixture.optionCases).toHaveLength(1024);for(const item of fixture.optionCases){if(item.expected===null)expect(()=>filterOptions(item.options,item.shorthand),JSON.stringify(item)).toThrow();else expect(filterOptions(item.options,item.shorthand),JSON.stringify(item)).toEqual(item.expected);}
});
