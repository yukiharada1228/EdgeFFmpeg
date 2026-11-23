import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {numericResult} from '../helpers/expression-numeric.js';
it('matches sampled pinned Linux numeric values through the public expression API and private exp2 kernel',()=>{
 const bytes=readFileSync('compat/behavior-specs/expression-linux/cases.json'),provenance=JSON.parse(readFileSync('compat/behavior-specs/expression-linux/provenance.json','utf8'));
 expect(createHash('sha256').update(bytes).digest('hex')).toBe(provenance.casesSha256);
 const rows=JSON.parse(bytes.toString()) as {expression:string;valueAccepted:boolean;bits:string}[];
 expect(rows).toHaveLength(16523);
 for(const row of rows){const actual=numericResult(row.expression);expect(actual.valueAccepted,row.expression).toBe(row.valueAccepted);if(row.valueAccepted)expect(actual.bits,row.expression).toBe(row.bits);}
});
