import {afterEach,describe,expect,it} from 'vitest';
import {constants,mkdtempSync,openSync,closeSync,readdirSync,rmSync,symlinkSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OutputIsDirectoryError,OutputParentNotFoundError,PathNotDirectoryError} from '@edge-ffmpeg/core';
import {createNodeFileSystem} from '@edge-ffmpeg/runtime-node';

// Native FFmpeg opens an output with open(path, O_WRONLY|O_CREAT|O_TRUNC). For a trailing-slash path that names no
// directory the kernel refuses before creating anything, with a host-defined errno (compat/behavior-specs/
// node-output-directory and its linux-x64 corpus): XNU reports ENOENT for a missing name and ENOTDIR for a regular file,
// Linux reports EISDIR for both (fs/namei.c open_last_lookups). runtime-node must classify like the host.
const classes={EISDIR:OutputIsDirectoryError,ENOENT:OutputParentNotFoundError,ENOTDIR:PathNotDirectoryError} as const;
const expected:Readonly<Record<string,{absent:keyof typeof classes;file:keyof typeof classes}>>={darwin:{absent:'ENOENT',file:'ENOTDIR'},linux:{absent:'EISDIR',file:'EISDIR'}};
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'edge-trailing-slash-'));roots.push(root);
 mkdirSync(join(root,'directory'));writeFileSync(join(root,'file'),new Uint8Array([31]));
 return root;
}
/** errno of the native create-open on this host, run directly against the kernel. */
function hostCreateErrno(path:string):string{
 try{closeSync(openSync(path,constants.O_WRONLY|constants.O_CREAT,0o666));}catch(error){return (error as NodeJS.ErrnoException).code!;}
 throw Error(`open(${path}, O_WRONLY|O_CREAT) unexpectedly succeeded`);
}

describe('runtime-node trailing-slash outputs',()=>{
 it('classifies non-directory slash outputs with the host create-open errno and creates nothing',async()=>{
  const platform=expected[process.platform];if(!platform)throw Error(`No trailing-slash expectation recorded for ${process.platform}`);
  const root=fixture(),fs=await createNodeFileSystem({root,maxReadBytes:16,maxWriteBytes:16});
  for(const [name,errno]of [['absent',platform.absent],['file',platform.file]] as const){
   expect(hostCreateErrno(join(root,name)+'/'),name).toBe(errno);
   const type=classes[errno],code={EISDIR:235,ENOENT:254,ENOTDIR:236}[errno];
   for(const overwrite of [false,true]){
    const exists=fs.outputExists!('/'+name+'/',undefined,{overwrite});await expect(exists).rejects.toBeInstanceOf(type);await expect(exists).rejects.toMatchObject({exitCode:code});
    await expect(fs.openWrite('/'+name+'/',{overwrite})).rejects.toBeInstanceOf(type);
   }
  }
  expect(readdirSync(root).sort()).toEqual(['directory','file']);
 });
 it('applies the host errno to slash paths below a missing or non-directory parent',async()=>{
  const root=fixture(),fs=await createNodeFileSystem({root,maxReadBytes:16,maxWriteBytes:16});
  for(const [path,errno]of [['/missing/absent/','ENOENT'],['/file/absent/','ENOTDIR']] as const){
   expect(hostCreateErrno(join(root,path)),path).toBe(errno);
   await expect(fs.outputExists!(path,undefined,{overwrite:true})).rejects.toBeInstanceOf(classes[errno]);
   await expect(fs.openWrite(path,{overwrite:true})).rejects.toBeInstanceOf(classes[errno]);
  }
  expect(readdirSync(root).sort()).toEqual(['directory','file']);
 });
 it('keeps existing directories, paths without a trailing slash and dangling symbolic links out of the probe',async()=>{
  const root=fixture(),outside=mkdtempSync(join(tmpdir(),'edge-trailing-slash-outside-'));roots.push(outside);
  symlinkSync(join(outside,'target'),join(root,'dangling'));
  const fs=await createNodeFileSystem({root,maxReadBytes:16,maxWriteBytes:16});
  expect(await fs.outputExists!('/directory/',undefined,{overwrite:false})).toBe(true);
  await expect(fs.outputExists!('/directory/',undefined,{overwrite:true})).rejects.toBeInstanceOf(OutputIsDirectoryError);
  expect(await fs.outputExists!('/absent',undefined,{overwrite:true})).toBe(false);
  // No Native evidence covers a dangling link; the requirement is only that nothing is created through it.
  await expect(fs.outputExists!('/dangling/',undefined,{overwrite:true})).rejects.toBeInstanceOf(Error);
  await expect(fs.openWrite('/dangling/',{overwrite:true})).rejects.toBeInstanceOf(Error);
  expect(existsSync(join(outside,'target'))).toBe(false);expect(readdirSync(outside)).toEqual([]);
  expect(readdirSync(root).sort()).toEqual(['dangling','directory','file']);
 });
});
