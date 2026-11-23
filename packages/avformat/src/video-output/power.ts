/** C pow special cases differ from ECMAScript Math.pow for these identities. */
export function cPower(base:number,exponent:number):number{return base===1||(base===-1&&Math.abs(exponent)===Infinity)?1:Math.pow(base,exponent);}
