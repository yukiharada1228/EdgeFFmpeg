import {numericResult} from '../helpers/expression-numeric.js';
export default {async fetch(request:Request){
 const expressions=await request.json() as string[];
 if(!Array.isArray(expressions)||expressions.length>512||expressions.some(value=>typeof value!=='string'||value.length>256))return new Response('Invalid batch',{status:400});
 return Response.json(expressions.map(numericResult));
}};
