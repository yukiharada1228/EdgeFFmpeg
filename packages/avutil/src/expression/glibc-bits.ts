export const wrap64=(value:bigint)=>BigInt.asUintN(64,value);
export function bits(value:number):bigint{const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,value,false);return view.getBigUint64(0,false);}
export function fromBits(value:bigint):number{const view=new DataView(new ArrayBuffer(8));view.setBigUint64(0,wrap64(value),false);return view.getFloat64(0,false);}
