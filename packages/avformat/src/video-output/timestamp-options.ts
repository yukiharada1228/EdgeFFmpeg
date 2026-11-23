import type {Option,FileContext} from '@edge-ffmpeg/cli';
export function videoTimestampFlag(name:string):boolean{return ['-copyts','-nocopyts','-start_at_zero','-nostart_at_zero'].includes(name.split(':')[0]!);}
export function videoTimestampOptions(options:readonly Option[]){let copyTs=false,startAtZero=false;for(const option of options){const name=option.name.split(':')[0]!;if(name==='-copyts')copyTs=true;else if(name==='-nocopyts')copyTs=false;else if(name==='-start_at_zero')startAtZero=true;else if(name==='-nostart_at_zero')startAtZero=false;}return Object.freeze({copyTs,startAtZero});}

const directVideoKey:unique symbol=Symbol('direct video output source');
type DirectVideoOutput=FileContext&{[directVideoKey]?:boolean};
export function markDirectVideoOutput(output:FileContext):FileContext{return {...output,[directVideoKey]:true} as DirectVideoOutput;}
export function hasDirectVideoSource(output:FileContext):boolean{return (output as DirectVideoOutput)[directVideoKey]===true;}
