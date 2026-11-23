import {compileExpressionBody} from './parser.js';
import type {NumericProfile} from './numeric-profile.js';
export type ExpressionNumericProfile=NumericProfile;
export interface ExpressionPrint {readonly value:number;readonly level:number;readonly text:string}
export interface ExpressionOptions {
 readonly numericProfile:ExpressionNumericProfile;
 readonly constants?:readonly string[];
 readonly nowMicroseconds?:()=>bigint;
 readonly onPrint?:(entry:ExpressionPrint)=>void;
 readonly logLevel?:number;
}
export type CompiledExpression=(values?:ArrayLike<number>)=>number;
/** Compiles once; state variables and generators persist across evaluations. */
export function compileExpression(input:string,options:ExpressionOptions):CompiledExpression{
 if(!options||!['linux-x64','darwin-arm64'].includes(options.numericProfile))throw new Error('An explicit expression numericProfile is required');
 const {constants,numericProfile,...effects}=options;
 return compileExpressionBody(input,{...effects,numericProfile},constants??[]);
}
/** Parses and evaluates with a fresh state context. */
export function evaluateExpression(input:string,options:ExpressionOptions,values?:ArrayLike<number>):number{return compileExpression(input,options)(values);}
