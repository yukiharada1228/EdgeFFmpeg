// SPDX-License-Identifier: LGPL-2.1-or-later
// Token and option rules adapted from FFmpeg avstring.c, opt.c, avfilter.c
// and graphparser.c at 946fcce07b6dcd0331c8cc609192aeff5e1924f8.
export class VideoFilterSyntaxError extends Error {}
const whitespace=(character:string|undefined)=>character!==undefined&&' \n\t\r'.includes(character);
interface Token {readonly value:string;readonly next:number}
/** Native removes one quoting/escape layer and retains protected trailing space. */
export function filterToken(text:string,start:number,terminators:string):Token {
 let position=start,protectedEnd=0;const output:string[]=[];
 while(whitespace(text[position]))position++;
 while(position<text.length&&!terminators.includes(text[position]!)){
  const character=text[position++]!;
  if(character==='\\'&&position<text.length){output.push(text[position++]!);protectedEnd=output.length;}
  else if(character==="'"){
   while(position<text.length&&text[position]!=="'")output.push(text[position++]!);
   if(position<text.length){position++;protectedEnd=output.length;}
  }else output.push(character);
 }
 while(output.length>protectedEnd&&whitespace(output.at(-1)))output.pop();
 return {value:output.join(''),next:position};
}
export interface LinearFilterToken {readonly name:string;readonly options:string|null}
export interface FilterOption {readonly key:string;readonly value:string}
const keyCharacter=(character:string|undefined)=>character!==undefined&&/^[A-Za-z0-9._/-]$/.test(character);
export function filterOptions(options:string|null,shorthand:readonly string[]):readonly FilterOption[] {
 if(options===null)return [];
 const result:FilterOption[]=[];let position=0,ordinal=0,implicit=true;
 while(position<options.length){
  let scan=position;while(whitespace(options[scan]))scan++;const begin=scan;
  while(keyCharacter(options[scan]))scan++;const end=scan;while(whitespace(options[scan]))scan++;
  let key:string;
  if(options[scan]==='='){key=options.slice(begin,end);position=scan+1;implicit=false;}
  else{const candidate=implicit?shorthand[ordinal]:undefined;if(candidate===undefined)throw new VideoFilterSyntaxError('Missing filter option name');key=candidate;}
  const value=filterToken(options,position,':');position=value.next;result.push({key,value:value.value});ordinal++;
  if(position<options.length)position++;
 }
 return result;
}
