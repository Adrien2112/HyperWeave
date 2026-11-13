import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../protocol/src/index.js';
export function syncDirectory(directory: string) {
  const fd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
  try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
// An existing destination is never replaced, even if it appears after preparation.
// A crash before link leaves only an identifiable private staging directory.
export async function publishFile(targetInput: string, write: (staged: string)=>Promise<void>) {
  const target=path.resolve(targetInput); const parent=path.dirname(target);
  const staging=fs.mkdtempSync(path.join(parent,'.hyperweave-file-'));
  fs.chmodSync(staging,0o700);const file=path.join(staging,'content');
  try {
    await write(file);
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try {assert(fs.fstatSync(fd).isFile(),'Expected regular output');fs.fchmodSync(fd,0o600);fs.fsyncSync(fd);} finally{fs.closeSync(fd);}
    fs.linkSync(file,target);syncDirectory(parent);
  } finally {fs.rmSync(staging,{recursive:true,force:true});}
  return {path:target};
}
export function writeExclusive(targetInput: string, bytes: string) {
  const target=path.resolve(targetInput);const parent=path.dirname(target);
  const staging=fs.mkdtempSync(path.join(parent,'.hyperweave-file-'));const file=path.join(staging,'content');
  try {
    const fd=fs.openSync(file,'wx',0o600);
    try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.linkSync(file,target);syncDirectory(parent);
  }finally{fs.rmSync(staging,{recursive:true,force:true});}
}
export function readBounded(filename: string, maximum: number) {
  const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const stat=fs.fstatSync(fd);assert(stat.isFile(),'Input must be a regular file');assert(stat.size<=maximum,'Input exceeds size limit','LIMIT_EXCEEDED');
    const bytes=Buffer.alloc(stat.size);let offset=0;
    while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);assert(count>0,'Input changed during read','INTEGRITY_ERROR');offset+=count;}
    const extra=Buffer.alloc(1);assert(fs.readSync(fd,extra,0,1,offset)===0,'Input grew during read','LIMIT_EXCEEDED');
    const after=fs.fstatSync(fd);assert(stat.size===after.size && stat.mtimeMs===after.mtimeMs && stat.ctimeMs===after.ctimeMs,'Input changed during read','INTEGRITY_ERROR');return bytes;
  }finally{fs.closeSync(fd);}
}
