// SPDX-License-Identifier: LGPL-2.1-or-later
// Token semantics follow pinned libavutil/avstring.c av_get_token.
export interface Mp4LanguageSelector{readonly type:string|undefined;readonly value:string|undefined;readonly optional:boolean}
export function languageSelector(selector:string):Mp4LanguageSelector|null{
 const prefix=/^(?:([va]):)?m:/.exec(selector);if(!prefix)return null;let at=prefix[0].length;
 const whitespace=(value:string)=>value===' '||value==='\n'||value==='\r'||value==='\t';
 function token():string{while(at<selector.length&&whitespace(selector[at]!))at++;let result='',keep=0;while(at<selector.length&&selector[at]!==':'){const value=selector[at++]!;if(value==='\\'&&at<selector.length){result+=selector[at++]!;keep=result.length;}else if(value==="'"){while(at<selector.length&&selector[at]!=="'")result+=selector[at++]!;if(at<selector.length){at++;keep=result.length;}}else result+=value;}while(result.length>keep&&whitespace(result[result.length-1]!))result=result.slice(0,-1);return result;}
 const key=token();if(key.toLowerCase()!=='language')return null;let value:string|undefined;if(at<selector.length){at++;value=token();}let optional=false;if(selector.slice(at)===':?'){optional=true;at=selector.length;}if(at!==selector.length||selector.includes('\0'))return null;return{type:prefix[1],value,optional};
}
