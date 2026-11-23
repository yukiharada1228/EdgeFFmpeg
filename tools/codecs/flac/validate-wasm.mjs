import fs from 'node:fs';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
export function inspectPrototypeWasm(bytes){
 if(!Buffer.from(bytes.subarray(0,8)).equals(Buffer.from([0,97,115,109,1,0,0,0])))throw Error('Invalid Wasm header');
 let position=8,memory;
 function u32(end=bytes.length){let value=0,shift=0;for(let n=0;n<5;n++){if(position>=end)throw Error('Truncated Wasm integer');const byte=bytes[position++];if(n===4&&byte>15)throw Error('Wasm integer overflow');value+=(byte&127)*2**shift;if(!(byte&128))return value;shift+=7;}throw Error('Invalid Wasm integer');}
 while(position<bytes.length){const id=bytes[position++],length=u32(),end=position+length;if(end>bytes.length)throw Error('Truncated Wasm section');if(id===5){if(memory||u32(end)!==1)throw Error('Expected one defined memory');const flags=u32(end);if(flags!==1)throw Error('Expected bounded unshared wasm32 memory');const initialPages=u32(end),maximumPages=u32(end);if(position!==end||initialPages!==256||maximumPages!==256)throw Error('Memory must be fixed16MiB');memory={initialPages,maximumPages,bytes:initialPages*65536};}position=end;}
 if(!memory)throw Error('Missing fixed memory');const module=new WebAssembly.Module(bytes),imports=WebAssembly.Module.imports(module),exports=WebAssembly.Module.exports(module),allowed=new Set(['env.edge_host_read','wasi_snapshot_preview1.proc_exit','wasi_snapshot_preview1.fd_write','wasi_snapshot_preview1.fd_read','wasi_snapshot_preview1.fd_close','wasi_snapshot_preview1.fd_seek']);
 for(const item of imports)if(item.kind!=='function'||!allowed.has(item.module+'.'+item.name))throw Error('Unexpected import:'+item.module+'.'+item.name);
 if(imports.filter(i=>i.module==='env'&&i.name==='edge_host_read').length!==1)throw Error('Missing asynchronous read import');
 const required=['_initialize','edge_flac_abi','edge_flac_info_words','edge_flac_async_data','edge_flac_create','edge_flac_info','edge_flac_step','edge_flac_destroy','asyncify_start_unwind','asyncify_stop_unwind','asyncify_start_rewind','asyncify_stop_rewind'];for(const name of required)if(!exports.some(e=>e.kind==='function'&&e.name===name))throw Error('Missing ABI export:'+name);
 if(!exports.some(e=>e.kind==='memory'&&e.name==='memory'))throw Error('Missing memory export');
 const expected = JSON.parse(fs.readFileSync(new URL('./abi.json', import.meta.url), 'utf8'));
 if(JSON.stringify(imports)!==JSON.stringify(expected.imports)||JSON.stringify(exports)!==JSON.stringify(expected.exports))throw Error('Pinned import/export ABI mismatch');
 const wasi=Object.fromEntries(imports.filter(i=>i.module==='wasi_snapshot_preview1').map(i=>[i.name,()=>{throw Error('Unexpected WASI call during ABI inspection');}]));
 const instance=new WebAssembly.Instance(module,{env:{edge_host_read:()=>0},wasi_snapshot_preview1:wasi});
 instance.exports._initialize();
 if(instance.exports.edge_flac_abi()!==1||instance.exports.edge_flac_info_words()!==29)throw Error('ABI constants mismatch');
 return {module,evidence:{sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,imports,exports,memory,abi:1,infoWords:29,inspectionOnly:true,decoderVerified:false}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const file=process.argv[2];if(!file)throw Error('Provide compiled Wasm file');const result=inspectPrototypeWasm(fs.readFileSync(file));fs.writeFileSync(file+'.inspection.json',JSON.stringify(result.evidence,null,2)+'\n');console.log(JSON.stringify(result.evidence));}
