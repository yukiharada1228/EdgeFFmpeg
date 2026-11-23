import {evaluateSetptsSink} from '../helpers/video-setpts-sink.js';
import {evaluateErrorStreamCases} from '../helpers/video-setpts-error.js';
import {evaluateFrameStreamCases,evaluateEofStreamCases} from '../helpers/video-setpts-native.js';
export default {async fetch(request:Request){if(new URL(request.url).pathname==='/sink')return Response.json(await evaluateSetptsSink());const profile=new URL(request.url).searchParams.get('profile');if(profile!=='linux-x64'&&profile!=='darwin-arm64')return new Response('Invalid profile',{status:400});return Response.json({frame:await evaluateFrameStreamCases(profile),eof:await evaluateEofStreamCases(profile),error:await evaluateErrorStreamCases(profile)});}};
