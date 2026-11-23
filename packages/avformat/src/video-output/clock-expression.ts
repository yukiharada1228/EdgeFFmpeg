import {cPower} from './power.js';
// SPDX-License-Identifier: LGPL-2.1-or-later
// Arithmetic grammar adapts pinned libavutil/eval.c.
// Copyright (c) 2002-2006 Michael Niedermayer; Copyright (c) 2006 Oded Shimon.
export function evaluateClockExpression(input:string):number{
 if(!input||input.length>256||input.includes('\0'))throw new Error('Clock expression length or NUL');const text=input.replace(/[ \t\n\r\v\f]/g,''),constants:Record<string,number>={E:Math.E,PI:Math.PI,PHI:1.6180339887498948482,QP2LAMBDA:118};let position=0,depth=0,operations=0;
 const spend=()=>{if(++operations>128)throw new Error('Clock expression operation limit');};
 const prefixes:Record<string,readonly [number,number]>={y:[8.271806125530276749e-25,1e-24],z:[8.4703294725430034e-22,1e-21],a:[8.6736173798840355e-19,1e-18],f:[8.8817841970012523e-16,1e-15],p:[9.0949470177292824e-13,1e-12],n:[9.3132257461547852e-10,1e-9],u:[9.5367431640625e-7,1e-6],m:[9.765625e-4,1e-3],c:[9.8431332023036951e-3,1e-2],d:[9.921256574801246e-2,1e-1],h:[1.0159366732596479e2,1e2],k:[1.024e3,1e3],K:[1.024e3,1e3],M:[1.048576e6,1e6],G:[1.073741824e9,1e9],T:[1.099511627776e12,1e12],P:[1.125899906842624e15,1e15],E:[1.152921504606847e18,1e18],Z:[1.1805916207174113e21,1e21],Y:[1.2089258196146292e24,1e24]};
 const suffix=(initial:number)=>{let value=initial;if(text.slice(position,position+2)==='dB'){value=Math.pow(2,3.32192809488736234787*(value/20));position+=2;}else{const prefix=prefixes[text[position]??''];if(prefix){const binary=text[position+1]==='i';value*=prefix[binary?0:1];position+=binary?2:1;}}if(text[position]==='B'){value*=8;position++;}return value;};
 const hexFloat=(literal:string):number=>{const parts=/^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?$/.exec(literal)!;const fraction=parts[3]??'',mantissa=BigInt('0x'+((parts[2]??'')+fraction||'0')),sign=parts[1]==='-'?-1:1;if(!mantissa)return sign*0;const exponent=Number(parts[4]??0)-4*fraction.length,bits=mantissa.toString(2).length,top=bits-1+exponent;if(top>1023)return sign*Infinity;if(top< -1075)return sign*0;const unit=Math.max(top-52,-1074),shift=unit-exponent;let rounded:bigint;if(shift<=0)rounded=mantissa<<BigInt(-shift);else{const divisor=1n<<BigInt(shift),quotient=mantissa/divisor,remainder=mantissa%divisor;rounded=quotient+(remainder*2n>divisor||(remainder*2n===divisor&&(quotient&1n)===1n)?1n:0n);}return sign*Number(rounded)*Math.pow(2,unit);};
 const primary=():number=>{spend();if(text[position]==='('){if(++depth>32)throw new Error('Clock expression nesting limit');position++;const result=expression();if(text[position++]!==')')throw new Error('Unclosed clock expression');depth--;return result;}
  const remaining=text.slice(position),signedHex=/^[+-]0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?/.exec(remaining);if(signedHex){position+=signedHex[0].length;return suffix(hexFloat(signedHex[0]));}
  const hex=/^0[xX]([0-9a-fA-F]+)/.exec(remaining);if(hex){position+=hex[0].length;const value=BigInt('0x'+hex[1]!),max=(1n<<64n)-1n;return suffix(Number(value>max?max:value));}
  const literal=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(remaining);if(literal){position+=literal[0].length;return suffix(Number(literal[0]));}
  const special=/^[+-]?(?:infinity|inf|nan)/i.exec(remaining);if(special){position+=special[0].length;return suffix(special[0].toLowerCase().replace(/^[+-]/,'')==='nan'?NaN:(special[0][0]==='-'?-Infinity:Infinity));}
  const identifier=/^[A-Za-z_][A-Za-z_0-9]*/.exec(remaining);if(identifier&&Object.hasOwn(constants,identifier[0])){position+=identifier[0].length;return constants[identifier[0]]!;}throw new Error('Unsupported clock expression token or function');
 };
 // C strtod consumes the longest numeric token before parse_dB checks its tail.
 const signedPrimary=()=>{const rest=text.slice(position),numeric=/^-(?:0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|infinity|inf|nan)/i.exec(rest);if(numeric&&rest.slice(numeric[0].length,numeric[0].length+2)==='dB')return {sign:1,value:primary()};let sign=1;if(text[position]==='-'||text[position]==='+')sign=text[position++]==='-'?-1:1;return {sign,value:primary()};};

 const factor=():number=>{const first=signedPrimary();let value=first.value;while(text[position]==='^'){spend();position++;const next=signedPrimary();value=cPower(value,next.sign*next.value);}return first.sign*value;};
 const term=():number=>{let value=factor();while(text[position]==='*'||text[position]==='/'){spend();const operator=text[position++],next=factor();value=operator==='*'?value*next:next!==0?value/next:value*Infinity;}return value;};
 const expression=():number=>{let value=term();while(text[position]==='+'||text[position]==='-'){spend();value+=term();}return value;};
 const result=expression();if(position!==text.length)throw new Error('Trailing clock expression token');return result;
}
