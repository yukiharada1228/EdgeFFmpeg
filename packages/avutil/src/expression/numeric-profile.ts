export type NumericProfile='darwin-arm64'|'linux-x64';
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n,SIGN=1n<<63n;
export function signed64(value:number,profile:NumericProfile):bigint{if(profile==='linux-x64')return !Number.isFinite(value)||value>=9223372036854775808||value< -9223372036854775808?MIN:BigInt(Math.trunc(value));return Number.isNaN(value)?0n:value>=9223372036854775808?MAX:value<=-9223372036854775808?MIN:BigInt(Math.trunc(value));}
export function variableIndex(value:number,profile:NumericProfile):number{if(profile==='linux-x64'&&(!Number.isFinite(value)||value>=2147483648||value< -2147483648))return 0;return Number.isNaN(value)?0:Math.max(0,Math.min(9,Math.trunc(value)));}
export function unsigned64(value:number,profile:NumericProfile):bigint{if(Number.isNaN(value))return 0n;if(profile==='linux-x64')return value>=9223372036854775808?BigInt.asUintN(64,signed64(value-9223372036854775808,profile)^SIGN):BigInt.asUintN(64,signed64(value,profile));return value<=0?0n:value>=18446744073709551616?18446744073709551615n:BigInt(Math.trunc(value));}
export function floor(value:number,profile:NumericProfile):number{const result=Math.floor(value);return profile==='linux-x64'&&result===0?0:result;}
export function ceil(value:number,profile:NumericProfile):number{const result=Math.ceil(value);return profile==='linux-x64'&&result===0?0:result;}
export function trunc(value:number,profile:NumericProfile):number{const result=Math.trunc(value);return profile==='linux-x64'&&result===0?0:result;}
