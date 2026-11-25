import {glibcLog} from './glibc-log.js';
import {glibcExp2} from './glibc-exp2.js';
import {glibcHypot} from './glibc-hypot.js';
import * as numeric from './numeric-profile.js';
import {hexFloatLiteral} from './hex-float.js';
import {formatPrint} from './format-print.js';
import {nextSfc64,seedSfc64} from './sfc64.js';
// SPDX-License-Identifier: LGPL-2.1-or-later
// Arithmetic grammar adapts pinned libavutil/eval.c.
// Copyright (c) 2002-2006 Michael Niedermayer; Copyright (c) 2006 Oded Shimon.
export interface ExpressionEffects {numericProfile?:numeric.NumericProfile;nowMicroseconds?:()=>bigint;onPrint?:(entry:{value:number;level:number;text:string})=>void;logLevel?:number}
export function compileExpressionBody(input:string,effects:ExpressionEffects={},constantNames:readonly string[]=[]):(values?:ArrayLike<number>)=>number{
 if(!input||input.length>256||input.includes('\0'))throw new Error('Expression length or NUL');const text=input.replace(/[ \t\n\r\v\f]/g,''),constants:Record<string,number>={E:Math.E,PI:Math.PI,PHI:1.6180339887498948482,QP2LAMBDA:118};let position=0,depth=0,operations=0;
 const profile=effects.numericProfile??'darwin-arm64';if(profile!=='darwin-arm64'&&profile!=='linux-x64')throw new Error('Unknown numeric profile');
 const names=[...constantNames];if(names.length>64||names.some(name=>typeof name!=='string'||name.length>256||name.includes('\0')))throw new Error('Expression constant names exceed bound');let boundValues:ArrayLike<number>|undefined,running=false;
 const spend=()=>{if(++operations>128)throw new Error('Expression operation limit');};
 const prefixes:Record<string,readonly [number,number]>={y:[8.271806125530276749e-25,1e-24],z:[8.4703294725430034e-22,1e-21],a:[8.6736173798840355e-19,1e-18],f:[8.8817841970012523e-16,1e-15],p:[9.0949470177292824e-13,1e-12],n:[9.3132257461547852e-10,1e-9],u:[9.5367431640625e-7,1e-6],m:[9.765625e-4,1e-3],c:[9.8431332023036951e-3,1e-2],d:[9.921256574801246e-2,1e-1],h:[1.0159366732596479e2,1e2],k:[1.024e3,1e3],K:[1.024e3,1e3],M:[1.048576e6,1e6],G:[1.073741824e9,1e9],T:[1.099511627776e12,1e12],P:[1.125899906842624e15,1e15],E:[1.152921504606847e18,1e18],Z:[1.1805916207174113e21,1e21],Y:[1.2089258196146292e24,1e24]};
 const suffix=(initial:number)=>{let value=initial;if(text.slice(position,position+2)==='dB'){value=profile==='linux-x64'?glibcExp2(3.32192809488736234787*(value/20)):Math.pow(2,3.32192809488736234787*(value/20));position+=2;}else{const prefix=prefixes[text[position]??''];if(prefix){const binary=text[position+1]==='i';value*=prefix[binary?0:1];position+=binary?2:1;}}if(text[position]==='B'){value*=8;position++;}return value;};
 const hexFloat=(literal:string):number=>hexFloatLiteral(literal,profile);
 const cPow=(base:number,exponent:number)=>base===1||(base===-1&&Math.abs(exponent)===Infinity)?1:Math.pow(base,exponent);
 let evaluations=0;const tick=()=>{if(++evaluations>10000)throw new Error('Expression execution budget exceeded');};const variables=new Float64Array(10),variableIndex=(value:number)=>numeric.variableIndex(value,profile);
 type Node=(()=>number)&{ignoreSign?:boolean};
 const functions:Record<string,{min:number;max:number;run:(args:readonly Node[])=>number}>={};
 const unary:Record<string,(x:number)=>number>={sinh:Math.sinh,cosh:Math.cosh,tanh:Math.tanh,sin:Math.sin,cos:Math.cos,tan:Math.tan,atan:Math.atan,asin:Math.asin,acos:Math.acos,exp:Math.exp,log:value=>profile==='linux-x64'?glibcLog(value):Math.log(value),abs:Math.abs,floor:value=>numeric.floor(value,profile),ceil:value=>numeric.ceil(value,profile),trunc:value=>numeric.trunc(value,profile),round:x=>x===0?x:x<0?-Math.floor(-x+0.5):Math.floor(x+0.5),sqrt:Math.sqrt,isnan:x=>Number.isNaN(x)?1:0,isinf:x=>Math.abs(x)===Infinity?1:0,not:x=>x===0?1:0,sgn:x=>Number(x>0)-Number(x<0),squish:x=>1/(1+Math.exp(4*x)),gauss:x=>Math.exp(-x*x/2)/Math.sqrt(2*Math.PI)};
 for(const [name,run]of Object.entries(unary))functions[name]={min:1,max:1,run:args=>run(args[0]!())};
 const binary:Record<string,(a:number,b:number)=>number>={mod:(a,b)=>a-numeric.floor(b!==0?a/b:a*Infinity,profile)*b,max:(a,b)=>a>b?a:b,min:(a,b)=>a<b?a:b,eq:(a,b)=>Number(a===b),gt:(a,b)=>Number(a>b),gte:(a,b)=>Number(a>=b),lt:(a,b)=>Number(a<b),lte:(a,b)=>Number(a<=b),pow:cPow,hypot:(a,b)=>profile==='linux-x64'?glibcHypot(a,b):Math.hypot(a,b),atan2:Math.atan2};
 for(const [name,run]of Object.entries(binary))functions[name]={min:2,max:2,run:args=>run(args[0]!(),args[1]!())};
 functions.if={min:2,max:3,run:args=>args[0]!()!==0?args[1]!():args[2]?.()??0};
 functions.ifnot={min:2,max:3,run:args=>args[0]!()===0?args[1]!():args[2]?.()??0};
 functions.between={min:3,max:3,run:args=>{const value=args[0]!();return Number(value>=args[1]!()&&value<=args[2]!());}};
 functions.clip={min:3,max:3,run:args=>{const value=args[0]!(),low=args[1]!(),high=args[2]!();return Number.isNaN(value)||Number.isNaN(low)||Number.isNaN(high)||low>high?NaN:(()=>{const again=args[0]!();return again<low?low:again>high?high:again;})();}};
 functions.lerp={min:3,max:3,run:args=>{const a=args[0]!(),b=args[1]!(),f=args[2]!();return a+(b-a)*f;}};
 const signed64=(value:number)=>numeric.signed64(value,profile);
 functions.gcd={min:2,max:2,run:args=>{let a=signed64(args[0]!()),b=signed64(args[1]!());if(a===0n)return Number(b);if(b===0n)return Number(a);if(a<0n)a=-a;if(b<0n)b=-b;while(b){const remainder=a%b;a=b;b=remainder;}return Number(BigInt.asIntN(64,a));}};
 for(const name of ['bitand','bitor'])functions[name]={min:2,max:2,run:args=>{const a=args[0]!(),b=args[1]!();if(Number.isNaN(a)||Number.isNaN(b))return NaN;return Number(name==='bitand'?signed64(a)&signed64(b):signed64(a)|signed64(b));}};
 const randomStates=Array.from({length:10},()=>({a:0n,b:0n,c:0n,counter:0n})),unsigned64=(value:number)=>numeric.unsigned64(value,profile);
 const random=(index:number)=>{const state=randomStates[index]!;if(state.counter===0n)seedSfc64(state,unsigned64(variables[index]!));const result=nextSfc64(state);variables[index]=Number(result);return Number(result);};
 functions.random={min:1,max:1,run:args=>random(variableIndex(args[0]!()))*(1/18446744073709551616)};
 functions.randomi={min:3,max:3,run:args=>{const min=args[1]!(),max=args[2]!(),result=random(variableIndex(args[0]!()));return min+(max-min)*result/18446744073709551616;}};
 functions.ld={min:1,max:1,run:args=>variables[variableIndex(args[0]!())]!};
 functions.st={min:2,max:2,run:args=>{const index=variableIndex(args[0]!()),value=args[1]!();randomStates[index]!.counter=0n;variables[index]=value;return value;}};
 functions.while={min:2,max:2,run:args=>{let result=NaN;while(args[0]!()!==0){tick();result=args[1]!();}return result;}};
 functions.taylor={min:2,max:3,run:args=>{const x=args[1]!(),id=args[2]?variableIndex(args[2]()):0,saved=variables[id]!;let term=1,result=0;try{for(let i=0;i<1000;i++){tick();const previous=result;variables[id]=i;const value=args[0]!();result+=term*value;if(previous===result&&value!==0)break;term*=x/(i+1);}return result;}finally{variables[id]=saved;}}};
 const reverse8=(value:number)=>{let result=0;for(let bit=0;bit<8;bit++){result=(result<<1)|(value&1);value>>=1;}return result;};
 functions.root={min:2,max:2,run:args=>{const saved=variables[0]!,maximum=args[1]!();let low=-1,high=-1,lowValue=-Number.MAX_VALUE,highValue=Number.MAX_VALUE;try{for(let i=-1;i<1024;i++){tick();if(i<255)variables[0]=reverse8(i&255)*maximum/255;else{let candidate=maximum*cPow(0.9,i-255);if(i&1)candidate*=-1;candidate+=(i&2)?low:high;variables[0]=candidate;}const value=args[0]!();if(value<=0&&value>lowValue){low=variables[0]!;lowValue=value;}if(value>=0&&value<highValue){high=variables[0]!;highValue=value;}if(low>=0&&high>=0){for(let j=0;j<1000;j++){tick();variables[0]=(low+high)*0.5;if(low===variables[0]||high===variables[0])break;const midpointValue=args[0]!();if(midpointValue<=0)low=variables[0]!;if(midpointValue>=0)high=variables[0]!;if(Number.isNaN(midpointValue)){low=high=midpointValue;break;}}break;}}return -lowValue<highValue?low:high;}finally{variables[0]=saved;}}};
 functions.print={min:1,max:3,run:args=>{const value=args[0]!(),requested=args[1]?args[1]() :32,level=Number.isNaN(requested)?0:Math.max(-2147483648,Math.min(2147483647,Math.trunc(requested))),normalized=level>=0?level&255:level;if(normalized<=(effects.logLevel??32))effects.onPrint?.({value,level,text:formatPrint(value)});return value;}};
 functions.time={min:1,max:1,run:args=>{args[0]!();return Number(effects.nowMicroseconds?.()??BigInt(Date.now())*1000n)*0.000001;}};
 const constant=(value:number):Node=>()=>value;
 const primary=():Node=>{spend();
  const remaining=text.slice(position),signedHex=/^[+-]0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?/.exec(remaining);if(signedHex){position+=signedHex[0].length;return constant(suffix(hexFloat(signedHex[0])));}
  const hex=/^0[xX]([0-9a-fA-F]+)/.exec(remaining);if(hex){position+=hex[0].length;const value=BigInt('0x'+hex[1]!),max=(1n<<64n)-1n;return constant(suffix(Number(value>max?max:value)));}
  const literal=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(remaining);if(literal){position+=literal[0].length;return constant(suffix(Number(literal[0])));}
  const special=/^[+-]?(?:infinity|inf|nan)/i.exec(remaining);if(special){position+=special[0].length;return constant(suffix(special[0].toLowerCase().replace(/^[+-]/,'')==='nan'?NaN:(special[0][0]==='-'?-Infinity:Infinity)));}
  for(let index=0;index<names.length;index++){const name=names[index]!,next=text[position+name.length];if(text.startsWith(name,position)&&!(next&&/[A-Za-z_0-9]/.test(next))){position+=name.length;return ()=>{if(!boundValues||index>=boundValues.length)throw new Error('Missing expression constant values');const value=boundValues[index];if(typeof value!=='number')throw new Error('Expression constants must be numbers');return value;};}}
  if(text[position]==='('){if(++depth>32)throw new Error('Expression nesting limit');position++;const result=expression();if(text[position++]!==')')throw new Error('Unclosed expression');depth--;return result;}
  const identifier=/^[A-Za-z_][A-Za-z_0-9]*/.exec(remaining);if(identifier){const name=identifier[0];position+=name.length;if(Object.hasOwn(constants,name))return constant(constants[name]!);const fn=Object.hasOwn(functions,name)?functions[name]:undefined;const opening=text.indexOf('(',position);if(fn&&opening>=0){position=opening+1;if(++depth>32)throw new Error('Expression nesting limit');const args:Node[]=[];if(text[position]!==')'){args.push(expression());while(text[position]===','){position++;if(args.length===3)throw new Error('Too many expression function arguments');if(text[position]===','||text[position]===')')args.length++;else args.push(expression());}}const valid=args[0]!==undefined&&(fn.max===1?args[1]===undefined:name==='print'?true:fn.max===2?args[1]!==undefined&&args[2]===undefined:fn.min===2?args[1]!==undefined:args[1]!==undefined&&args[2]!==undefined);if(text[position++]!==')'||!valid)throw new Error('Invalid expression function arguments');depth--;const result:Node=()=>{tick();return fn.run(args);};if(['random','randomi','while','taylor','root'].includes(name))result.ignoreSign=true;return result;}}
  throw new Error('Unsupported expression token or function');
 };
 const signedPrimary=()=>{const rest=text.slice(position),numeric=/^-(?:0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|infinity|inf|nan)/i.exec(rest);if(numeric&&rest.slice(numeric[0].length,numeric[0].length+2)==='dB')return {sign:1,value:primary()};let sign=1;if(text[position]==='-'||text[position]==='+')sign=text[position++]==='-'?-1:1;return {sign,value:primary()};};

 const factor=():Node=>{const first=signedPrimary();let value=first.value;while(text[position]==='^'){spend();position++;const next=signedPrimary(),previous=value;value=()=>cPow(previous(),(next.value.ignoreSign?1:next.sign)*next.value());}const result:Node=()=>value.ignoreSign?value():first.sign*value();if(value.ignoreSign)result.ignoreSign=true;return result;};
 const term=():Node=>{let value=factor();while(text[position]==='*'||text[position]==='/'){spend();const operator=text[position++],next=factor(),previous=value;value=()=>{const a=previous(),b=next();return operator==='*'?a*b:b!==0?a/b:a*Infinity;};}return value;};
 const sum=():Node=>{let value=term();while(text[position]==='+'||text[position]==='-'){spend();const previous=value,next=term();value=()=>previous()+next();}return value;};
 const expression=():Node=>{let value=sum();while(text[position]===';'){spend();position++;const previous=value,next=sum();value=()=>{previous();return next();};}return value;};

 const result=expression();if(position!==text.length)throw new Error('Trailing expression token');return values=>{if(running)throw new Error('Expression evaluator is already running');running=true;evaluations=0;boundValues=values;try{return result();}finally{boundValues=undefined;running=false;}};
}

export function evaluateExpressionBody(input:string,effects:ExpressionEffects={}):number{return compileExpressionBody(input,effects)();}
