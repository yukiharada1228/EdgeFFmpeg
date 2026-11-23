import {expect,it} from 'vitest';
import {InputReadError} from '@edge-ffmpeg/core';
import {createNodeFileSystem,NodeInputChangedError} from '@edge-ffmpeg/runtime-node';
import {mkdtemp,mkdir,writeFile,rename,rm,symlink,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
it('opens contained input directories and reports EISDIR at read time without treating their stat size as readable bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'edge-input-directory-')),outside=await mkdtemp(join(tmpdir(),'edge-input-directory-outside-'));
 try{
  await mkdir(join(root,'directory'));await writeFile(join(root,'directory/member'),new Uint8Array([17]));
  await symlink(outside,join(root,'escape'));
  const filesystem=await createNodeFileSystem({root,maxReadBytes:16,maxWriteBytes:16});
  for(const path of ['/directory','/directory/']){
   const handle=await filesystem.openRead(path);expect(handle.size).toBe((await stat(join(root,'directory'),{bigint:true})).size);
   expect(await handle.readAt(0n,0)).toEqual(new Uint8Array());
   for(const offset of [0n,handle.size,handle.size+100n]){
    let failure:unknown;try{await handle.readAt(offset,1);}catch(error){failure=error;}
    expect(failure).toBeInstanceOf(InputReadError);expect(failure).toMatchObject({code:'input-read-error',exitCode:235,path,message:'Is a directory'});
   }
   await expect(handle.readAt(-1n,1)).rejects.toBeInstanceOf(RangeError);
   await expect(handle.readAt(0n,17)).rejects.toBeInstanceOf(RangeError);
   const controller=new AbortController();controller.abort(new Error('cancelled'));
   await expect(handle.readAt(0n,1,controller.signal)).rejects.toThrow('cancelled');
  }
  await expect(filesystem.openRead('/escape')).rejects.toThrow('escapes filesystem root');
  await expect(filesystem.openRead('/escape/')).rejects.toThrow('escapes filesystem root');
  const accepted=await filesystem.openRead('/directory');await rename(join(root,'directory'),join(root,'original'));await mkdir(join(root,'directory'));
  await expect(accepted.readAt(0n,1)).rejects.toBeInstanceOf(NodeInputChangedError);
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
