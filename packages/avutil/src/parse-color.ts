// SPDX-License-Identifier: LGPL-2.1-or-later
// av_parse_color and its color_table adapted from FFmpeg libavutil/parseutils.c at
// 946fcce07b6dcd0331c8cc609192aeff5e1924f8. See ../NOTICE.
import {hexFloatLiteral} from './expression/hex-float.js';
/** invalid: native returns AVERROR(EINVAL), with native's message. unsupported: native succeeds with a random or platform-undefined value. */
export class ColorParseError extends Error {constructor(readonly code:'invalid'|'unsupported',message:string){super(message);}}
// The 140 entries in upstream order, which av_strcasecmp sorts, so bsearch finds exactly the ASCII case-insensitive matches.
const table:readonly (readonly [string,number])[]=[['AliceBlue',0xf0f8ff],['AntiqueWhite',0xfaebd7],['Aqua',0x00ffff],['Aquamarine',0x7fffd4],['Azure',0xf0ffff],['Beige',0xf5f5dc],['Bisque',0xffe4c4],['Black',0x000000],['BlanchedAlmond',0xffebcd],['Blue',0x0000ff],['BlueViolet',0x8a2be2],['Brown',0xa52a2a],['BurlyWood',0xdeb887],['CadetBlue',0x5f9ea0],['Chartreuse',0x7fff00],['Chocolate',0xd2691e],['Coral',0xff7f50],['CornflowerBlue',0x6495ed],['Cornsilk',0xfff8dc],['Crimson',0xdc143c],['Cyan',0x00ffff],['DarkBlue',0x00008b],['DarkCyan',0x008b8b],['DarkGoldenRod',0xb8860b],['DarkGray',0xa9a9a9],['DarkGreen',0x006400],['DarkKhaki',0xbdb76b],['DarkMagenta',0x8b008b],['DarkOliveGreen',0x556b2f],['Darkorange',0xff8c00],['DarkOrchid',0x9932cc],['DarkRed',0x8b0000],['DarkSalmon',0xe9967a],['DarkSeaGreen',0x8fbc8f],['DarkSlateBlue',0x483d8b],['DarkSlateGray',0x2f4f4f],['DarkTurquoise',0x00ced1],['DarkViolet',0x9400d3],['DeepPink',0xff1493],['DeepSkyBlue',0x00bfff],['DimGray',0x696969],['DodgerBlue',0x1e90ff],['FireBrick',0xb22222],['FloralWhite',0xfffaf0],['ForestGreen',0x228b22],['Fuchsia',0xff00ff],['Gainsboro',0xdcdcdc],['GhostWhite',0xf8f8ff],['Gold',0xffd700],['GoldenRod',0xdaa520],['Gray',0x808080],['Green',0x008000],['GreenYellow',0xadff2f],['HoneyDew',0xf0fff0],['HotPink',0xff69b4],['IndianRed',0xcd5c5c],['Indigo',0x4b0082],['Ivory',0xfffff0],['Khaki',0xf0e68c],['Lavender',0xe6e6fa],['LavenderBlush',0xfff0f5],['LawnGreen',0x7cfc00],['LemonChiffon',0xfffacd],['LightBlue',0xadd8e6],['LightCoral',0xf08080],['LightCyan',0xe0ffff],['LightGoldenRodYellow',0xfafad2],['LightGreen',0x90ee90],['LightGrey',0xd3d3d3],['LightPink',0xffb6c1],['LightSalmon',0xffa07a],['LightSeaGreen',0x20b2aa],['LightSkyBlue',0x87cefa],['LightSlateGray',0x778899],['LightSteelBlue',0xb0c4de],['LightYellow',0xffffe0],['Lime',0x00ff00],['LimeGreen',0x32cd32],['Linen',0xfaf0e6],['Magenta',0xff00ff],['Maroon',0x800000],['MediumAquaMarine',0x66cdaa],['MediumBlue',0x0000cd],['MediumOrchid',0xba55d3],['MediumPurple',0x9370d8],['MediumSeaGreen',0x3cb371],['MediumSlateBlue',0x7b68ee],['MediumSpringGreen',0x00fa9a],['MediumTurquoise',0x48d1cc],['MediumVioletRed',0xc71585],['MidnightBlue',0x191970],['MintCream',0xf5fffa],['MistyRose',0xffe4e1],['Moccasin',0xffe4b5],['NavajoWhite',0xffdead],['Navy',0x000080],['OldLace',0xfdf5e6],['Olive',0x808000],['OliveDrab',0x6b8e23],['Orange',0xffa500],['OrangeRed',0xff4500],['Orchid',0xda70d6],['PaleGoldenRod',0xeee8aa],['PaleGreen',0x98fb98],['PaleTurquoise',0xafeeee],['PaleVioletRed',0xd87093],['PapayaWhip',0xffefd5],['PeachPuff',0xffdab9],['Peru',0xcd853f],['Pink',0xffc0cb],['Plum',0xdda0dd],['PowderBlue',0xb0e0e6],['Purple',0x800080],['Red',0xff0000],['RosyBrown',0xbc8f8f],['RoyalBlue',0x4169e1],['SaddleBrown',0x8b4513],['Salmon',0xfa8072],['SandyBrown',0xf4a460],['SeaGreen',0x2e8b57],['SeaShell',0xfff5ee],['Sienna',0xa0522d],['Silver',0xc0c0c0],['SkyBlue',0x87ceeb],['SlateBlue',0x6a5acd],['SlateGray',0x708090],['Snow',0xfffafa],['SpringGreen',0x00ff7f],['SteelBlue',0x4682b4],['Tan',0xd2b48c],['Teal',0x008080],['Thistle',0xd8bfd8],['Tomato',0xff6347],['Turquoise',0x40e0d0],['Violet',0xee82ee],['Wheat',0xf5deb3],['White',0xffffff],['WhiteSmoke',0xf5f5f5],['Yellow',0xffff00],['YellowGreen',0x9acd32]];
const names=new Map(table.map(([name,rgb])=>[name.toLowerCase(),rgb]));
const space=/^[ \t\n\v\f\r]*/,hex=/^[0-9A-Fa-f]*$/,decimal=/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/,notANumber=/^[+-]?nan(?:\([0-9A-Za-z_]*\))?$/i;
const latin1=(bytes:Uint8Array)=>String.fromCharCode(...bytes),lower=(text:string)=>text.replace(/[A-Z]/g,char=>char.toLowerCase()),utf8=(text:string)=>new TextDecoder().decode(Uint8Array.from(text,char=>char.charCodeAt(0)));
/** strtoul(text, &tail, 16) on LP64, narrowed to unsigned int: null when the whole text is not consumed. */
function hexInteger(text:string):number|null{
 let index=space.exec(text)![0].length,negative=false;
 if(text[index]==='+'||text[index]==='-'){negative=text[index]==='-';index++;}
 if(text[index]==='0'&&(text[index+1]==='x'||text[index+1]==='X')&&/^[0-9A-Fa-f]$/.test(text[index+2]??''))index+=2;
 const digits=/^[0-9A-Fa-f]*/.exec(text.slice(index))![0];
 if(!digits||index+digits.length!==text.length)return null;
 // At most 8 digits reach here (len is 6 or 8), so strtoul cannot saturate; a sign negates modulo 2^64.
 const value=BigInt('0x'+digits);return Number((negative?-value:value)&0xffffffffn);
}
/** The double strtod(text, &tail) returns when it consumes the whole text; NaN refused (its uint8_t conversion is undefined). */
function alphaFloat(text:string,whole:string):number{
 const invalid=()=>new ColorParseError('invalid',`Invalid alpha value specifier '${utf8(text)}' in '${whole}'`);
 const body=text.slice(space.exec(text)![0].length);
 if(decimal.test(body))return Number(body);
 if(notANumber.test(body))throw new ColorParseError('unsupported',`NaN color alpha '${utf8(text)}' is not supported`);
 let darwin:number,linux:number;
 try{darwin=hexFloatLiteral(body,'darwin-arm64');linux=hexFloatLiteral(body,'linux-x64');}catch{throw invalid();}
 // The libcs differ only for subnormal results, which truncate to alpha 0, except where the sign decides acceptance.
 if(!Object.is(darwin,linux)&&(darwin<0)!==(linux<0))throw new ColorParseError('unsupported',`Platform-dependent color alpha '${utf8(text)}' is not supported`);
 return darwin;
}
/**
 * av_parse_color(rgba, text, -1, ctx) as AV_OPT_TYPE_COLOR calls it: a case-insensitive color_table name or `#`/`0x`
 * RRGGBB[AA] (through LP64 strtoul, so whitespace, a sign and a second 0x prefix count toward the 6 or 8 characters),
 * then an optional `@` alpha, `0x..` (strtoul, at most 255) or a 0..1 strtod float scaled by 255 and truncated. The text
 * is copied as C bytes into a 128-byte buffer first, so it ends at a NUL and after 127 bytes. `random` and `bikeshed`
 * (av_get_random_seed) and NaN alphas are refused as unsupported.
 */
export function parseColor(text:string):readonly [number,number,number,number]{
 let bytes=new TextEncoder().encode(text);const nul=bytes.indexOf(0);if(nul>=0)bytes=bytes.subarray(0,nul);
 const whole=utf8(latin1(bytes)),offset=bytes[0]===0x23?1:bytes[0]===0x30&&bytes[1]===0x78?2:0;
 const copy=latin1(bytes.subarray(offset,offset+127)),at=copy.indexOf('@'),color=at<0?copy:copy.slice(0,at),tail=at<0?null:copy.slice(at+1);
 let rgb=0,alpha=255;const random=['random','bikeshed'].includes(lower(color));
 if(random){/* refused after the alpha check, which native runs on the random value */}
 else if(offset||hex.test(color)){
  const value=hexInteger(color);
  if(value===null||(color.length!==6&&color.length!==8))throw new ColorParseError('invalid',`Invalid 0xRRGGBB[AA] color string: '${utf8(color)}'`);
  if(color.length===8){alpha=value&255;rgb=value>>>8;}else rgb=value;
 }else{
  const entry=names.get(lower(color));
  if(entry===undefined)throw new ColorParseError('invalid',`Cannot find color '${utf8(color)}'`);
  rgb=entry;
 }
 if(tail!==null){
  let value:number;
  if(tail.startsWith('0x')){const digits=tail.slice(2);value=/^[0-9A-Fa-f]+$/.test(digits)&&BigInt('0x'+digits)<=255n?Number('0x'+digits):256;}
  else{const norm=alphaFloat(tail,whole);value=norm<0||norm>1?256:255*norm;}
  if(value>255||value<0)throw new ColorParseError('invalid',`Invalid alpha value specifier '${utf8(tail)}' in '${whole}'`);
  alpha=Math.trunc(value)+0;
 }
 if(random)throw new ColorParseError('unsupported',`Random color '${utf8(color)}' is not supported`);
 return Object.freeze([(rgb>>>16)&255,(rgb>>>8)&255,rgb&255,alpha] as const);
}
