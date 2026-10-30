import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountClosure, type DailyCareVisibilityMarker } from '../../services/api/src/accountClosure';
import { latestDailyCareVisibility } from '../../services/api/src/dailyCare';

const memberId='00000000-0000-4000-8000-000000000001',recordId='00000000-0000-4000-8000-000000000002',requestId='00000000-0000-4000-8000-000000000003';
const input=()=>({memberId,recordId,requestId,identityDigest:'a'.repeat(64),recordVersion:2,action:'delete' as const,
  operationId:'synthetic-marker-operation',requestSha256:'b'.repeat(64),factsSha256:'c'.repeat(64),createdAt:'2026-10-30T00:00:00Z'});
const directories:string[]=[];
async function directory(){const value=await mkdtemp(join(tmpdir(),'cisme-daily-marker-'));directories.push(value);await chmod(value,0o700);return value;}
afterEach(async()=>{for(const path of directories.splice(0))await rm(path,{recursive:true,force:true});});

it('durably retains only the exact visibility intent and revalidates the independent copy before consumption',async()=>{
  const path=await directory();let ready=false;
  const put=vi.fn(async()=>{if(!ready)throw Error('synthetic unavailable');});
  const closure=new AccountClosure(path,{put,list:async()=>[]});
  await expect(closure.recordDailyCareVisibility(input())).rejects.toMatchObject({code:'DAILY_CARE_RECOVERY_PENDING'});
  const files=await readdir(path);expect(files).toEqual([`${memberId}.daily.${recordId}.${requestId}.json`]);
  expect(JSON.parse(await readFile(join(path,files[0]!), 'utf8'))).toMatchObject(input());
  await expect(closure.dailyCareMarkers(memberId)).rejects.toMatchObject({code:'DAILY_CARE_RECOVERY_PENDING'});
  const connect=vi.fn();await expect(closure.replayPendingErasure({connect} as never)).rejects.toMatchObject({code:'DAILY_CARE_RECOVERY_PENDING'});expect(connect).not.toHaveBeenCalled();
  ready=true;expect(await closure.dailyCareMarkers(memberId)).toEqual([{version:6,scope:'daily_care_record_visibility_v1',...input()}]);
  expect(await readdir(path)).toEqual(files);expect(put).toHaveBeenCalledTimes(4);
});
it('does not disclose or consume another owner visibility intents',async()=>{
  const path=await directory(),closure=new AccountClosure(path);await closure.recordDailyCareVisibility(input());
  expect(await closure.dailyCareMarkers(recordId)).toEqual([]);
});
it.each([{recordVersion:1},{action:'invalid'},{factsSha256:'not-a-hash'},{operationId:'short'}])('rejects malformed visibility markers %j',async change=>{
  const path=await directory(),closure=new AccountClosure(path);
  await expect(closure.recordDailyCareVisibility({...input(),...change} as Omit<DailyCareVisibilityMarker,'version'|'scope'>)).rejects.toThrow('DAILY_CARE_VISIBILITY_MARKER_INVALID');
  expect(await readdir(path)).toEqual([]);
});
it('compares versions within each record and applies final deletes before final restores',()=>{
  const row=(recordId:string,recordVersion:number,action:'delete'|'restore')=>({version:6 as const,scope:'daily_care_record_visibility_v1' as const,...input(),recordId,recordVersion,action});
  const A=recordId,B=requestId,history=[row(A,2,'delete'),row(B,2,'delete'),row(A,3,'restore'),row(A,4,'delete'),row(B,3,'restore')];
  expect(latestDailyCareVisibility(history).map(r=>[r.recordId,r.recordVersion,r.action])).toEqual([[A,4,'delete'],[B,3,'restore']]);
  expect(history).toHaveLength(5);
});
it('does not guess between conflicting durable intents for the same record version',()=>{
  const row={version:6 as const,scope:'daily_care_record_visibility_v1' as const,...input()};
  expect(()=>latestDailyCareVisibility([row,{...row,action:'restore'}])).toThrow('DAILY_CARE_MARKER_VERSION_CONFLICT');
});
