import {evaluateThreadFrame} from '../helpers/thread-frame-queue.js';
import type {ThreadFrameCase} from '../helpers/thread-frame-queue.js';
export default {async fetch(request:Request){const cases=await request.json() as ThreadFrameCase[];if(!Array.isArray(cases)||cases.length>8)return new Response('Invalid queue fixture batch',{status:400});return Response.json(cases.map(evaluateThreadFrame));}};
