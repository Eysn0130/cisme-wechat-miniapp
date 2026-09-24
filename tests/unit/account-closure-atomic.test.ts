import {chmod, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach, expect, it} from 'vitest';
import {AccountClosure} from '../../services/api/src/accountClosure';

const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(){const directory=await mkdtemp(join(tmpdir(),'cisme-closure-atomic-'));
 await chmod(directory,0o700);directories.push(directory);return {directory,closure:new AccountClosure(directory)};}

it('publishes one complete immutable marker under concurrent account closures',async()=>{
 const {directory,closure}=await fixture(),memberId=randomUUID(),identityDigest=AccountClosure.identityDigest('wechat_miniprogram','fixture-app','fixture-openid');
 const rows=await Promise.all(Array.from({length:20},()=>closure.record(memberId,identityDigest,randomUUID())));
 expect(new Set(rows.map(row=>row.requestId)).size).toBe(1);
 expect(JSON.parse(await readFile(join(directory,`${memberId}.json`),'utf8'))).toEqual(rows[0]);
 expect(await readdir(directory)).toEqual([`${memberId}.json`]);
 expect(await closure.hasIdentity('wechat_miniprogram','fixture-app','fixture-openid')).toBe(true);
});

it('ignores an interrupted temporary write but refuses a partial final marker',async()=>{
 const {directory,closure}=await fixture(),memberId=randomUUID(),temporary=`.${memberId}.${randomUUID()}.tmp`;
 await writeFile(join(directory,temporary),'half-written',{mode:0o600});
 expect(await closure.hasIdentity('wechat_miniprogram','fixture-app','fixture-openid')).toBe(false);
 const row=await closure.record(memberId,AccountClosure.identityDigest('wechat_miniprogram','fixture-app','fixture-openid'),randomUUID());
 expect(JSON.parse(await readFile(join(directory,`${memberId}.json`),'utf8'))).toEqual(row);
 await writeFile(join(directory,`${randomUUID()}.json`),'half-written',{mode:0o600});
 await expect(closure.hasIdentity('wechat_miniprogram','fixture-app','other-openid')).rejects.toThrow();
});
