import {readFileSync} from 'node:fs';
import {loadH264Corpus,h264Hash} from './h264-corpus.js';
export interface H264Mp4Input {id:string;data:string;sha256:string}
export interface H264Mp4Case {id:string;inputId:string;map:string[];limit:number|null;expectedBytes:number;expectedSha256:string}
export interface H264Mp4Fault {name:string;mode:string;inputId:string;limit:number|null;preexisting:boolean;overwrite?:boolean;avcOffset?:number;nalOffset?:number;lengthOffset?:number;expectedBytes?:number;expectedSha256?:string}
export function loadH264Mp4Corpus(){
 loadH264Corpus();
 const root='compat/behavior-specs/h264',bytes=readFileSync(root+'/mp4.json'),faultBytes=readFileSync(root+'/faults.json'),manifest=JSON.parse(readFileSync(root+'/mp4-manifest.json','utf8')) as {cases:number;inputs:number;sha256:string;faultCases:number;faultsSha256:string};
 if(h264Hash(bytes)!==manifest.sha256||h264Hash(faultBytes)!==manifest.faultsSha256)throw Error('H264 MP4 corpus changed');
 const corpus=JSON.parse(bytes.toString()) as {inputs:H264Mp4Input[];cases:H264Mp4Case[]},faults=JSON.parse(faultBytes.toString()) as H264Mp4Fault[];
 if(corpus.inputs.length!==manifest.inputs||corpus.cases.length!==manifest.cases||faults.length!==manifest.faultCases)throw Error('Incomplete H264 MP4 corpus');
 for(const row of corpus.inputs)if(h264Hash(Buffer.from(row.data,'base64'))!==row.sha256)throw Error('H264 MP4 input changed: '+row.id);
 for(const row of [...corpus.cases,...faults])if(!corpus.inputs.some(input=>input.id===row.inputId))throw Error('Missing H264 MP4 input');
 return {...corpus,faults};
}
export function verifyH264Reference(){
 const metadata=JSON.parse(readFileSync('.build/reference/build-metadata.json','utf8')) as {commit:string;artifacts:Record<string,string>};
 if(metadata.commit!==JSON.parse(readFileSync('compat/upstream.lock.json','utf8')).commit)throw Error('H264 reference commit changed');
 for(const name of ['ffmpeg','ffprobe'])if(h264Hash(readFileSync('.build/reference/'+name))!==metadata.artifacts[name])throw Error('H264 reference binary changed');
}
