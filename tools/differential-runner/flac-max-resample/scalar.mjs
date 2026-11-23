import {readFileSync,writeFileSync,existsSync,mkdtempSync,rmSync,renameSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const sha=data=>createHash('sha256').update(data).digest('hex');
const sourcePath='compat/behavior-specs/flac-max-resample/cases.json',sourceBytes=readFileSync(sourcePath),source=JSON.parse(sourceBytes);
const destination='compat/behavior-specs/flac-max-resample/scalar.json',binary=resolve('.build/reference/ffmpeg');
if(sha(readFileSync(binary))!==source.binarySha256)throw Error('Wrong Native binary');
const fingerprint=sha(JSON.stringify([1,sha(sourceBytes),source.binarySha256,['-cpuflags','0']]));
if(existsSync(destination)){
 const saved=JSON.parse(readFileSync(destination));if(saved.fingerprint!==fingerprint||saved.rows.length!==60||saved.rows.some(row=>sha(Buffer.from(row.input,'base64'))!==row.inputSha256||sha(Buffer.from(row.output,'base64'))!==row.outputSha256))throw Error('Invalid saved scalar corpus');
 console.log(JSON.stringify({actualNativeCalls:0,reused:60}));
}else{
 const root=mkdtempSync(join(tmpdir(),'flac-resample-scalar-')),rows=[];
 try{
  for(const row of source.rows){
   const input=Buffer.from(row.input,'base64');if(input.length>524288||sha(input)!==row.inputSha256)throw Error('Input bound/hash');
   writeFileSync(join(root,'in.flac'),input);rmSync(join(root,'out'),{force:true});
   const args=['-cpuflags','0',...row.args];
   const run=spawnSync(binary,args.map(arg=>arg==='/in.flac'?join(root,'in.flac'):arg==='/out'?join(root,'out'):arg),{encoding:'utf8',timeout:10000,maxBuffer:1048576});if(run.error||run.status!==0)throw run.error??Error(run.stderr);
   const output=readFileSync(join(root,'out'));if(output.length>524288)throw Error('Output bound');
   const next={...row,args,exitCode:run.status,output:output.toString('base64'),outputSha256:sha(output),stderr:run.stderr.replaceAll(root,'<fixture>')};
   if(row.variant==='framecrc'){
    next.framecrc=output.toString();next.packets=next.framecrc.split('\n').filter(line=>/^\d+,/.test(line)).map(line=>{const [streamId,dts,pts,duration,bytes,checksum]=line.split(',').map(value=>value.trim());return {streamId:Number(streamId),dts:Number(dts),pts:Number(pts),duration:Number(duration),bytes:Number(bytes),checksum};});
   }else{
    let pcm=output;
    if(row.variant==='wav')for(let at=12;at+8<=output.length;){const size=output.readUInt32LE(at+4);if(output.toString('ascii',at,at+4)==='data'){pcm=output.subarray(at+8,at+8+size);break;}at+=8+size+(size&1);}
    if(pcm.length!==row.sampleCount*row.descriptors[0].channels*2)throw Error('Scalar/default sample count differs');
    next.pcmSha256=sha(pcm);
   }
   rows.push(next);
  }
  if(rows.length!==60)throw Error('Incomplete scalar matrix');
  const data={...source,fingerprint,generator:'tools/differential-runner/flac-max-resample/scalar.mjs',sourceCorpusSha256:sha(sourceBytes),referenceOptions:['-cpuflags','0'],limits:{...source.limits,actualNativeCalls:60,sequential:true},rows};
  const temporary=join(root,'scalar.json');writeFileSync(temporary,JSON.stringify(data,null,2)+'\n');renameSync(temporary,destination);
  console.log(JSON.stringify({actualNativeCalls:60,rows:60,defaultOutputHashDifferences:rows.filter((row,index)=>row.outputSha256!==source.rows[index].outputSha256).length}));
 }finally{rmSync(root,{recursive:true,force:true});}
}
