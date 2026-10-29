import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {CANONICAL_WECHAT_MINIPROGRAM_APP_ID,loadConfig} from '@cisme/config';
import {resetDatabase,testPool,TEST_DATABASE_URL} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {issueSessionToken} from '../../services/api/src/auth';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {DailyCareService} from '../../services/api/src/dailyCare';
import {transaction} from '../../services/api/src/db';
import {AccountClosure} from '../../services/api/src/accountClosure';
import {collectMemberPortableData} from '../../services/api/src/privacyPortableData';
import {portableQuerySpecs} from '../../services/api/src/privacyPortableQueries';
import {DeliveryAddressService} from '../../services/api/src/deliveryAddress';

const pool=testPool(),config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,
  APP_SESSION_SECRET:'synthetic-daily-session',UPLOAD_TOKEN_SECRET:'synthetic-daily-upload',
  WECHAT_APP_ID:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,ALLOW_DEV_ADAPTERS:'false',OBJECT_STORAGE_DRIVER:'api_gateway',
  CONTACT_ENCRYPTION_KEY:'3'.repeat(64),CONTACT_HASH_KEY:'4'.repeat(64)});
const service=new DailyCareService(pool),body={stepCodes:['00','01','02','03'],selfAssessment:'comfortable'};
let app:Awaited<ReturnType<typeof createApp>>,directory:string;
type Actor={id:string;principal:string;openid:string};
async function actor():Promise<Actor>{
  const id=(await pool.query("INSERT INTO member(display_name) VALUES('合成日常会员') RETURNING id")).rows[0].id;
  const openid=`synthetic-daily-${randomUUID()}`,wid=(await pool.query(`INSERT INTO wechat_identity(member_id,openid,adapter,provider,app_id)
    VALUES($1,$2,'wechat','wechat_miniprogram',$3) RETURNING id`,[id,openid,CANONICAL_WECHAT_MINIPROGRAM_APP_ID])).rows[0].id;
  return {id,principal:`wechat_miniprogram:${wid}`,openid};
}
function headers(a:Actor,key=randomUUID(),scope:'member'|'privacy_rights'='member'){
  return {authorization:`Bearer ${issueSessionToken({principalId:a.principal,memberId:a.id,adapter:'wechat',provider:'wechat_miniprogram',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,scope},config.sessionSecret)}`,'idempotency-key':key};
}
async function post(a:Actor,key=randomUUID(),payload:unknown=body){return app.inject({method:'POST',url:'/v1/me/daily-care-records',headers:headers(a,key),payload:payload as any});}
async function get(a:Actor,query=''){return app.inject({url:`/v1/me/daily-care-records${query}`,headers:headers(a)});}
beforeAll(async()=>{await resetDatabase(pool);directory=await mkdtemp(join(tmpdir(),'cisme-daily-closure-'));await chmod(directory,0o700);app=await createApp({pool,config,storage:createApiGatewayStorage(config)});});
afterAll(async()=>{await app?.close();await pool.end();if(directory)await rm(directory,{recursive:true,force:true});});
describe('real daily care HTTP/database persistence, identity and recovery',()=>{
  it('requires a member session and rejects privacy-rights-only sessions',async()=>{
    const a=await actor();for(const method of ['GET','POST'] as const){
      expect((await app.inject({method,url:'/v1/me/daily-care-records',...(method==='POST'?{payload:body}:{})})).statusCode).toBe(401);
      expect((await app.inject({method,url:'/v1/me/daily-care-records',headers:headers(a,randomUUID(),'privacy_rights'),...(method==='POST'?{payload:body}:{})})).statusCode).toBe(403);
    }
  });
  it('saves all facts without a cycle and reloads them through a fresh HTTP read',async()=>{
    const a=await actor(),key=randomUUID(),before=Date.now(),response=await post(a,key);expect(response.statusCode,response.body).toBe(200);
    const saved=response.json();expect(saved).toMatchObject({replayed:false,record:{source:'daily',operationId:key,timezone:'Asia/Shanghai',protocolVersion:'daily-care-v1',...body}});
    expect(Date.parse(saved.record.completedAt)).toBeGreaterThanOrEqual(before);expect(Date.parse(saved.record.completedAt)).toBeLessThanOrEqual(Date.now());
    const read=await get(a);expect(read.headers['cache-control']).toBe('private, no-store');expect(read.json()).toEqual({items:[saved.record],loadedCount:1,hasMore:false,nextCursor:null});
    const persisted=(await pool.query('SELECT step_codes,self_assessment FROM daily_care_record WHERE id=$1',[saved.record.id])).rows[0];expect(persisted).toEqual({step_codes:body.stepCodes,self_assessment:body.selfAssessment});
    for(const table of ['care_cycle','qualification_fact','task_claim','points_grant'])expect((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(0);
  });
  it('concurrent identical keys and later retries retain exactly one immutable record',async()=>{
    const a=await actor(),key=randomUUID(),responses=await Promise.all([post(a,key),post(a,key)]);responses.forEach(r=>expect(r.statusCode,r.body).toBe(200));
    expect(responses[0].json().record).toEqual(responses[1].json().record);expect(responses.map(r=>r.json().replayed).sort()).toEqual([false,true]);
    const retry=await post(a,key,{selfAssessment:body.selfAssessment,stepCodes:body.stepCodes});expect(retry.json()).toEqual({record:responses[0].json().record,replayed:true});
    const conflict=await post(a,key,{...body,selfAssessment:'attention'});expect(conflict.statusCode).toBe(409);expect(conflict.json().code).toBe('IDEMPOTENCY_CONFLICT');expect((await get(a)).json().loadedCount).toBe(1);
  });
  it('rejects missing/incomplete/reordered facts, caller-supplied actor/time and absent keys without writes',async()=>{
    const a=await actor();for(const payload of [{stepCodes:['00','01','02'],selfAssessment:'comfortable'},{stepCodes:['01','00','02','03'],selfAssessment:'comfortable'},{stepCodes:body.stepCodes},{...body,memberId:a.id},{...body,completedAt:'2000-01-01T00:00:00Z'}])expect((await post(a,randomUUID(),payload)).statusCode).toBe(422);
    const noKey=headers(a);delete (noKey as Partial<typeof noKey>)['idempotency-key'];expect((await app.inject({method:'POST',url:'/v1/me/daily-care-records',headers:noKey,payload:body})).statusCode).toBe(400);
    expect((await get(a)).json().items).toEqual([]);
  });
  it('isolates members and allows the same operation key for separate owners',async()=>{
    const a=await actor(),b=await actor(),key=randomUUID();const [x,y]=await Promise.all([post(a,key),post(b,key)]);
    expect(x.json().record.id).not.toBe(y.json().record.id);expect((await get(a)).json().items).toEqual([x.json().record]);expect((await get(b)).json().items).toEqual([y.json().record]);
    expect(JSON.stringify((await get(a)).json())).not.toMatch(/member_id|request_sha256|principal|openid/);
  });
  it('treats a new explicit key as a separate daily fact without a one-per-day rule',async()=>{
    const a=await actor(),first=(await post(a)).json().record,second=(await post(a)).json().record;
    expect(first.id).not.toBe(second.id);expect((await get(a)).json().loadedCount).toBe(2);
  });
  it('cannot write through a concurrent member closure lock',async()=>{
    const a=await actor(),blocker=await pool.connect();
    try{
      await blocker.query('BEGIN');await blocker.query('SELECT id FROM member WHERE id=$1 FOR UPDATE',[a.id]);
      const pending=service.create(a.id,randomUUID(),body);const rejected=expect(pending).rejects.toMatchObject({code:'AUTH_REVOKED'});
      await blocker.query("UPDATE member SET status='deleted' WHERE id=$1",[a.id]);await blocker.query('COMMIT');await rejected;
      expect((await pool.query('SELECT 1 FROM daily_care_record WHERE member_id=$1',[a.id])).rowCount).toBe(0);
    }finally{await blocker.query('ROLLBACK');blocker.release();}
  });
  it('pages equal timestamps without dropping rows and rejects cross-member/bad cursors',async()=>{
    const a=await actor(),b=await actor(),date=new Date('2026-10-29T01:00:00Z');
    const ids=[];for(let i=0;i<5;i++)ids.push((await service.create(a.id,randomUUID(),body,date)).record.id);
    const first=(await get(a,'?limit=2')).json(),second=(await get(a,`?limit=2&cursor=${first.nextCursor}`)).json(),third=(await get(a,`?limit=2&cursor=${second.nextCursor}`)).json();
    expect(new Set([...first.items,...second.items,...third.items].map(r=>r.id))).toEqual(new Set(ids));expect(third).toMatchObject({loadedCount:1,hasMore:false,nextCursor:null});
    expect((await get(b,`?cursor=${first.nextCursor}`)).statusCode).toBe(422);for(const q of ['?limit=0','?limit=51','?cursor=bad'])expect((await get(a,q)).statusCode).toBe(422);
  });
  it('exports owner daily facts through both portable projections without operation keys or hashes',async()=>{
    const a=await actor(),other=await actor(),saved=(await post(a)).json().record;await post(other);
    const old=await transaction(pool,client=>collectMemberPortableData(client,config,new DeliveryAddressService(pool,config),a.id));
    const one=(old.sections.care as {dailyRecords:any[]}).dailyRecords;expect(one).toHaveLength(1);expect(one[0].id).toBe(saved.id);
    const spec=portableQuerySpecs.find(x=>x.section==='care'&&x.collection==='dailyRecords')!;const two=(await pool.query(spec.sql,[a.id])).rows;expect(two).toEqual(one);
    expect(JSON.stringify(one)).not.toMatch(/operation_id|request_sha256|member_id|suppressed_at/);
  });
  it('deletes ordinary daily records on account closure and replays suppression after a restored copy',async()=>{
    const a=await actor(),saved=(await post(a)).json().record,closure=new AccountClosure(directory);
    const digest=AccountClosure.identityDigest('wechat_miniprogram',CANONICAL_WECHAT_MINIPROGRAM_APP_ID,a.openid);await closure.record(a.id,digest,randomUUID());await closure.replayMember(pool,a.id);
    expect((await pool.query('SELECT 1 FROM daily_care_record WHERE member_id=$1',[a.id])).rowCount).toBe(0);
    await pool.query(`INSERT INTO daily_care_record(id,member_id,operation_id,request_sha256,protocol_version,step_codes,self_assessment)
      VALUES($1,$2,$3,$4,'daily-care-v1',$5,$6)`,[saved.id,a.id,saved.operationId,'a'.repeat(64),body.stepCodes,body.selfAssessment]);
    expect(await closure.replayPendingErasure(pool)).toBe(1);expect((await pool.query('SELECT 1 FROM daily_care_record WHERE member_id=$1',[a.id])).rowCount).toBe(0);
    expect((await get(a)).statusCode).toBe(401);await expect(service.create(a.id,randomUUID(),body)).rejects.toMatchObject({code:'AUTH_REVOKED'});
  });
  it('suppresses a typed legal-hold record, then erases it on hold-release replay',async()=>{
    const a=await actor(),saved=(await post(a)).json().record,closure=new AccountClosure(directory);
    const hold=(await pool.query(`INSERT INTO legal_hold(reason_code,legal_basis,approved_by,review_at,expires_at)
      VALUES('DISPUTE_EVIDENCE','synthetic daily-care dispute','fixture',now()+interval '1 day',now()+interval '2 days') RETURNING id`)).rows[0].id;
    await pool.query("INSERT INTO legal_hold_binding(hold_id,object_type,object_id) VALUES($1,'daily_care_record',$2)",[hold,saved.id]);
    await closure.record(a.id,AccountClosure.identityDigest('wechat_miniprogram',CANONICAL_WECHAT_MINIPROGRAM_APP_ID,a.openid),randomUUID());await closure.replayMember(pool,a.id);
    const held=(await pool.query('SELECT self_assessment,suppressed_at FROM daily_care_record WHERE id=$1',[saved.id])).rows[0];expect(held.self_assessment).toBe('comfortable');expect(held.suppressed_at).toBeTruthy();
    expect((await pool.query(portableQuerySpecs.find(x=>x.collection==='dailyRecords')!.sql,[a.id])).rows).toEqual([]);
    await pool.query("UPDATE legal_hold SET status='released',released_by='fixture',released_at=now() WHERE id=$1",[hold]);
    await closure.replayPendingErasure(pool);expect((await pool.query('SELECT 1 FROM daily_care_record WHERE id=$1',[saved.id])).rowCount).toBe(0);
  });
  it('refuses database-level partial facts and migration rollback with saved data',async()=>{
    const a=await actor();await expect(pool.query(`INSERT INTO daily_care_record(member_id,operation_id,request_sha256,protocol_version,step_codes,self_assessment)
      VALUES($1,$2,$3,'daily-care-v1',ARRAY['00','01'],'comfortable')`,[a.id,randomUUID(),'a'.repeat(64)])).rejects.toMatchObject({code:'23514'});
    const saved=(await post(a)).json().record,client=await pool.connect();
    try{
      const down=(await readFile('db/migrations/202610290001_daily_care_records.sql','utf8')).split('-- migrate:down')[1]!;
      await expect(client.query(down)).rejects.toThrow('DAILY_CARE_RECORDS_EXIST');
    }finally{await client.query('ROLLBACK');client.release();}
    expect((await pool.query('SELECT 1 FROM daily_care_record WHERE id=$1',[saved.id])).rowCount).toBe(1);
  });
});
