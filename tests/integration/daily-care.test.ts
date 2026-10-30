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
async function change(a:Actor,id:string,method:'PUT'|'DELETE'|'POST',payload:unknown,key=randomUUID(),restore=false){
  return app.inject({method,url:`/v1/me/daily-care-records/${id}${restore?'/restore':''}`,headers:headers(a,key),payload:payload as any});
}
beforeAll(async()=>{await resetDatabase(pool);directory=await mkdtemp(join(tmpdir(),'cisme-daily-closure-'));await chmod(directory,0o700);config.privacy.suppressionDirectory=directory;app=await createApp({pool,config,storage:createApiGatewayStorage(config)});});
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
    const read=await get(a);expect(read.headers['cache-control']).toBe('private, no-store');expect(read.json()).toEqual({items:[saved.record],loadedCount:1,hasMore:false,nextCursor:null,serverDay:saved.record.careDay,today:saved.record,totalCount:1});
    const persisted=(await pool.query('SELECT step_codes,self_assessment FROM daily_care_record WHERE id=$1',[saved.record.id])).rows[0];expect(persisted).toEqual({step_codes:body.stepCodes,self_assessment:body.selfAssessment});
    for(const table of ['care_cycle','qualification_fact','task_claim','points_grant'])expect((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(0);
  });
  it('concurrent identical keys and later retries retain exactly one immutable record',async()=>{
    const a=await actor(),key=randomUUID(),responses=await Promise.all([post(a,key),post(a,key)]);responses.forEach(r=>expect(r.statusCode,r.body).toBe(200));
    expect(responses[0].json().record).toEqual(responses[1].json().record);expect(responses.map(r=>r.json().replayed).sort()).toEqual([false,true]);
    const retry=await post(a,key,{selfAssessment:body.selfAssessment,stepCodes:body.stepCodes});expect(retry.json()).toEqual({record:responses[0].json().record,replayed:true,current:true});
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
  it('keeps one current record per Shanghai day even for distinct concurrent keys and legacy bodies',async()=>{
    const a=await actor(),responses=await Promise.all([post(a),post(a)]);
    expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409]);
    expect(responses.find(r=>r.statusCode===409)!.json().code).toBe('DAILY_CARE_DAY_EXISTS');
    expect((await get(a)).json()).toMatchObject({loadedCount:1,totalCount:1});
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
  it('pages separate care days without dropping rows and rejects cross-member/bad cursors',async()=>{
    const a=await actor(),b=await actor(),date=new Date('2026-10-29T01:00:00Z');
    const ids=[];for(let i=0;i<5;i++)ids.push((await service.create(a.id,randomUUID(),body,new Date(date.getTime()-i*86400000))).record.id);
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
    await pool.query(`INSERT INTO daily_care_record(id,member_id,operation_id,request_sha256,protocol_version,step_codes,self_assessment,care_day,updated_at,latest_operation_id)
      VALUES($1,$2,$3,$4,'daily-care-v1',$5,$6,$7,now(),$3)`,[saved.id,a.id,saved.operationId,'a'.repeat(64),body.stepCodes,body.selfAssessment,saved.careDay]);
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
    expect((await pool.query('SELECT count(*)::int n FROM daily_care_record_revision WHERE record_id=$1',[saved.id])).rows[0].n).toBe(1);
    expect((await pool.query(portableQuerySpecs.find(x=>x.collection==='dailyRecords')!.sql,[a.id])).rows).toEqual([]);
    await pool.query("UPDATE legal_hold SET status='released',released_by='fixture',released_at=now() WHERE id=$1",[hold]);
    await closure.replayPendingErasure(pool);expect((await pool.query('SELECT 1 FROM daily_care_record WHERE id=$1',[saved.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM daily_care_record_revision WHERE record_id=$1',[saved.id])).rows[0].n).toBe(0);
  });
  it('refuses database-level partial facts and migration rollback with saved data',async()=>{
    const a=await actor();await expect(pool.query(`INSERT INTO daily_care_record(member_id,operation_id,request_sha256,protocol_version,step_codes,self_assessment,care_day,updated_at,latest_operation_id)
      VALUES($1,$2,$3,'daily-care-v1',ARRAY['00','01'],'comfortable',current_date,now(),$2)`,[a.id,randomUUID(),'a'.repeat(64)])).rejects.toMatchObject({code:'23514'});
    const saved=(await post(a)).json().record,client=await pool.connect();
    try{
      const down=(await readFile('db/migrations/202610290001_daily_care_records.sql','utf8')).split('-- migrate:down')[1]!;
      await expect(client.query(down)).rejects.toThrow('DAILY_CARE_RECORDS_EXIST');
    }finally{await client.query('ROLLBACK');client.release();}
    expect((await pool.query('SELECT 1 FROM daily_care_record WHERE id=$1',[saved.id])).rowCount).toBe(1);
  });
  it('updates explicitly with CAS, retaining the original facts and historical same-key acknowledgements',async()=>{
    const a=await actor(),firstKey=randomUUID(),first=(await post(a,firstKey)).json().record,key=randomUUID();
    const payload={...body,selfAssessment:'attention',careDay:first.careDay,expectedVersion:1};
    const updated=await change(a,first.id,'PUT',payload,key);expect(updated.statusCode,updated.body).toBe(200);
    expect(updated.json()).toMatchObject({replayed:false,current:true,record:{id:first.id,version:2,operationId:key,deleted:false,selfAssessment:'attention'}});
    expect((await change(a,first.id,'PUT',payload,key)).json()).toEqual({...updated.json(),replayed:true});
    const old=(await post(a,firstKey)).json();expect(old).toEqual({record:first,replayed:true,current:false});
    const read=(await get(a)).json();expect(read.items).toEqual([updated.json().record]);expect(read).toMatchObject({totalCount:1,today:updated.json().record});
    const history=(await pool.query('SELECT version,source_fact FROM daily_care_record_revision WHERE record_id=$1 ORDER BY version',[first.id])).rows;
    expect(history).toHaveLength(2);expect(history[0].source_fact.self_assessment).toBe(body.selfAssessment);expect(history[1].source_fact.self_assessment).toBe('attention');
    expect((await change(a,first.id,'PUT',{...payload,selfAssessment:'neutral'},key)).json().code).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('serializes competing edits and delete against the same version without overwriting the winner',async()=>{
    const a=await actor(),saved=(await post(a)).json().record;
    const responses=await Promise.all([change(a,saved.id,'PUT',{...body,careDay:saved.careDay,expectedVersion:1}),change(a,saved.id,'DELETE',{expectedVersion:1})]);
    expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409]);
    expect(responses.find(r=>r.statusCode===409)!.json().code).toBe('VERSION_CONFLICT');
    expect((await pool.query('SELECT count(*)::int n FROM daily_care_record_revision WHERE record_id=$1',[saved.id])).rows[0].n).toBe(2);
  });
  it('soft deletes and restores exactly one record; old write replays cannot undo the newer visibility',async()=>{
    const a=await actor(),saved=(await post(a)).json().record,key=randomUUID();
    const deleted=await change(a,saved.id,'DELETE',{expectedVersion:1},key);expect(deleted.statusCode,deleted.body).toBe(200);
    expect(deleted.json()).toMatchObject({record:{id:saved.id,version:2,operationId:key,deleted:true},current:true,replayed:false});
    expect((await get(a)).json()).toMatchObject({items:[],today:null,totalCount:0});
    expect((await pool.query('SELECT 1 FROM daily_care_record WHERE id=$1',[saved.id])).rowCount).toBe(1);
    const restoreKey=randomUUID(),restored=await change(a,saved.id,'POST',{expectedVersion:2},restoreKey,true);
    expect(restored.statusCode,restored.body).toBe(200);expect(restored.json()).toMatchObject({record:{id:saved.id,version:3,operationId:restoreKey,deleted:false},current:true});
    expect((await change(a,saved.id,'DELETE',{expectedVersion:1},key)).json()).toEqual({...deleted.json(),replayed:true,current:false});
    expect((await get(a)).json().items).toEqual([restored.json().record]);
  });
  it('never restores over a new record for the same day or revives QA/legacy-suppressed rows',async()=>{
    const a=await actor(),old=(await post(a)).json().record,deleteKey=randomUUID();await change(a,old.id,'DELETE',{expectedVersion:1},deleteKey);
    const next=(await post(a,randomUUID(),{...body,selfAssessment:'neutral',careDay:old.careDay})).json().record;
    expect((await change(a,old.id,'DELETE',{expectedVersion:1},deleteKey)).json()).toMatchObject({replayed:true,current:true,record:{id:old.id,deleted:true}});
    const restore=await change(a,old.id,'POST',{expectedVersion:2},randomUUID(),true);expect(restore.statusCode).toBe(409);expect(restore.json().code).toBe('DAILY_CARE_DAY_EXISTS');
    await pool.query('UPDATE daily_care_record SET superseded_by=$2 WHERE id=$1',[old.id,next.id]);
    expect((await change(a,old.id,'POST',{expectedVersion:2},randomUUID(),true)).json().code).toBe('DAILY_CARE_RECORD_UNAVAILABLE');
    expect((await post(a,old.operationId)).json().code).toBe('DAILY_CARE_RECORD_UNAVAILABLE');
    await pool.query('UPDATE daily_care_record SET superseded_by=NULL,suppressed_at=now() WHERE id=$1',[old.id]);
    for(const result of [await change(a,old.id,'POST',{expectedVersion:2},randomUUID(),true),await change(a,old.id,'PUT',{...body,careDay:old.careDay,expectedVersion:2})])expect(result.json().code).toBe('DAILY_CARE_RECORD_UNAVAILABLE');
    expect((await get(a)).json().items).toEqual([next]);
  });
  it('requires current day for new writes, but replays a committed key across Shanghai midnight',async()=>{
    const a=await actor(),key=randomUUID(),before=new Date('2026-10-29T15:59:59.999Z'),after=new Date('2026-10-29T16:00:00.000Z');
    const first=await service.create(a.id,key,{...body,careDay:'2026-10-29'},before);
    expect(await service.create(a.id,key,{...body,careDay:'2026-10-29'},after)).toEqual({...first,replayed:true});
    await expect(service.create(a.id,randomUUID(),{...body,careDay:'2026-10-29'},after)).rejects.toMatchObject({code:'DAILY_CARE_DAY_CHANGED'});
    await expect(service.update(a.id,first.record.id,randomUUID(),{...body,careDay:'2026-10-29',expectedVersion:1},after)).rejects.toMatchObject({code:'DAILY_CARE_DAY_CHANGED'});
    expect((await service.create(a.id,randomUUID(),{...body,careDay:'2026-10-30'},after)).record.careDay).toBe('2026-10-30');
  });
  it('rejects other-owner and rights-scope mutations and does not create assets on edit/delete/restore',async()=>{
    const a=await actor(),other=await actor(),saved=(await post(a)).json().record;
    for(const [method,payload,restore] of [['PUT',{...body,careDay:saved.careDay,expectedVersion:1},false],['DELETE',{expectedVersion:1},false],['POST',{expectedVersion:1},true]] as const){
      expect((await change(other,saved.id,method,payload,randomUUID(),restore)).statusCode).toBe(404);
      const response=await app.inject({method,url:`/v1/me/daily-care-records/${saved.id}${restore?'/restore':''}`,headers:headers(a,randomUUID(),'privacy_rights'),payload});expect(response.statusCode).toBe(403);
    }
    expect((await get(a)).json().items[0].version).toBe(1);
    for(const table of ['care_cycle','qualification_fact','task_claim','points_grant'])expect((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(0);
  });
  it('replays durable deletion and restoration after an older database row is restored',async()=>{
    const a=await actor(),saved=(await post(a)).json().record;
    const original=(await pool.query('SELECT to_jsonb(d) AS row FROM daily_care_record d WHERE id=$1',[saved.id])).rows[0].row;
    const baseline=(await pool.query('SELECT to_jsonb(r) AS row FROM daily_care_record_revision r WHERE record_id=$1',[saved.id])).rows[0].row;
    const key=randomUUID();await change(a,saved.id,'DELETE',{expectedVersion:1},key);
    await pool.query('DELETE FROM daily_care_record WHERE id=$1',[saved.id]);
    await pool.query('INSERT INTO daily_care_record SELECT * FROM jsonb_populate_record(NULL::daily_care_record,$1::jsonb)',[JSON.stringify(original)]);
    await pool.query('INSERT INTO daily_care_record_revision SELECT * FROM jsonb_populate_record(NULL::daily_care_record_revision,$1::jsonb)',[JSON.stringify(baseline)]);
    expect((await get(a)).json()).toMatchObject({items:[],totalCount:0});
    expect((await change(a,saved.id,'DELETE',{expectedVersion:1},key)).json()).toMatchObject({replayed:true,current:true,record:{deleted:true,version:2}});
    const restore=await change(a,saved.id,'POST',{expectedVersion:2},randomUUID(),true);expect(restore.statusCode,restore.body).toBe(200);
    await pool.query('DELETE FROM daily_care_record WHERE id=$1',[saved.id]);
    await pool.query('INSERT INTO daily_care_record SELECT * FROM jsonb_populate_record(NULL::daily_care_record,$1::jsonb)',[JSON.stringify(original)]);
    await pool.query('INSERT INTO daily_care_record_revision SELECT * FROM jsonb_populate_record(NULL::daily_care_record_revision,$1::jsonb)',[JSON.stringify(baseline)]);
    await new AccountClosure(directory).replay(pool);
    expect((await get(a)).json().items).toEqual([restore.json().record]);
  });
  it('does not promote a local visibility marker until the independent remote copy succeeds',async()=>{
    const a=await actor(),local=await mkdtemp(join(tmpdir(),'cisme-daily-remote-'));await chmod(local,0o700);
    let available=false;const remote={put:async()=>{if(!available)throw new Error('synthetic remote unavailable');},list:async()=>[]};
    const suppression=new AccountClosure(local,remote),target=new DailyCareService(pool,suppression);
    try{
      const saved=(await target.create(a.id,randomUUID(),body)).record,key=randomUUID();
      await expect(target.visibility(a.id,saved.id,key,{expectedVersion:1},'delete')).rejects.toMatchObject({code:'DAILY_CARE_RECOVERY_PENDING'});
      await expect(target.list(a.id)).rejects.toMatchObject({code:'DAILY_CARE_RECOVERY_PENDING'});
      await expect(suppression.replayPendingErasure(pool)).rejects.toMatchObject({code:'DAILY_CARE_RECOVERY_PENDING'});
      expect((await pool.query('SELECT version,deleted_at FROM daily_care_record WHERE id=$1',[saved.id])).rows[0]).toEqual({version:1,deleted_at:null});
      const {readdir}=await import('node:fs/promises'),files=await readdir(local);expect(files).toHaveLength(1);
      const first=await readFile(join(local,files[0]!), 'utf8');available=true;
      const ack=await target.visibility(a.id,saved.id,key,{expectedVersion:1},'delete');
      expect(ack).toMatchObject({replayed:true,current:true,record:{version:2,deleted:true,operationId:key}});
      expect(await readdir(local)).toEqual(files);expect(await readFile(join(local,files[0]!), 'utf8')).toBe(first);
      expect((await target.list(a.id)).totalCount).toBe(0);
    }finally{await rm(local,{recursive:true,force:true});}
  });
  it('exports an approved care-history projection and never expands arbitrary snapshot fields',async()=>{
    const a=await actor(),other=await actor(),saved=(await post(a)).json().record;
    await change(a,saved.id,'PUT',{...body,selfAssessment:'attention',careDay:saved.careDay,expectedVersion:1});
    await pool.query(`UPDATE daily_care_record_revision SET snapshot=snapshot||jsonb_build_object('internal','synthetic-private',
      'otherMember',$2::text,'hash','synthetic-private-hash') WHERE record_id=$1`,[saved.id,other.id]);
    const exported=await transaction(pool,client=>collectMemberPortableData(client,config,new DeliveryAddressService(pool,config),a.id));
    const history=(exported.sections.care as {dailyRecordHistory:any[]}).dailyRecordHistory;
    const query=portableQuerySpecs.find(s=>s.collection==='dailyRecordHistory')!;
    expect((await pool.query(query.sql,[a.id])).rows).toEqual(history);expect(history).toHaveLength(2);
    for(const item of history)expect(Object.keys(item.record).sort()).toEqual(['id','source','completedAt','timezone','protocolVersion','stepCodes','selfAssessment','careDay','version','updatedAt','deleted'].sort());
    expect(JSON.stringify(history)).not.toContain('synthetic-private');expect(JSON.stringify(history)).not.toContain(other.id);
    const replay=await post(a,saved.operationId);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().current).toBe(false);
    expect(JSON.stringify(replay.json())).not.toContain('synthetic-private');expect(JSON.stringify(replay.json())).not.toContain(other.id);
    await change(a,saved.id,'DELETE',{expectedVersion:2});
    expect((await pool.query(query.sql,[a.id])).rows).toEqual([]);
  });
  it('isolates restored older facts when they cannot substantiate a newer durable visibility intent',async()=>{
    const a=await actor(),saved=(await post(a)).json().record;
    const original=(await pool.query('SELECT to_jsonb(d) AS row FROM daily_care_record d WHERE id=$1',[saved.id])).rows[0].row;
    await change(a,saved.id,'PUT',{...body,selfAssessment:'attention',careDay:saved.careDay,expectedVersion:1});
    await change(a,saved.id,'DELETE',{expectedVersion:2});
    await pool.query('DELETE FROM daily_care_record WHERE id=$1',[saved.id]);
    await pool.query('INSERT INTO daily_care_record SELECT * FROM jsonb_populate_record(NULL::daily_care_record,$1::jsonb)',[JSON.stringify(original)]);
    expect((await get(a)).json().items).toEqual([]);
    expect((await pool.query('SELECT suppressed_at FROM daily_care_record WHERE id=$1',[saved.id])).rows[0].suppressed_at).not.toBeNull();
    expect((await change(a,saved.id,'POST',{expectedVersion:1},randomUUID(),true)).json().code).toBe('DAILY_CARE_RECORD_UNAVAILABLE');
  });
  it('converges cross-record delete/restore dependencies in one sync and preserves a later edit',async()=>{
    const a=await actor(),A=(await post(a)).json().record;
    await change(a,A.id,'DELETE',{expectedVersion:1});
    const B=(await post(a)).json().record;await change(a,B.id,'DELETE',{expectedVersion:1});
    await change(a,A.id,'POST',{expectedVersion:2},randomUUID(),true);
    const backup=(await pool.query('SELECT to_jsonb(d) AS row FROM daily_care_record d WHERE id=ANY($1::uuid[]) ORDER BY id',[[A.id,B.id]])).rows.map(r=>r.row);
    const revisions=(await pool.query('SELECT to_jsonb(r) AS row FROM daily_care_record_revision r WHERE record_id=ANY($1::uuid[])',[[A.id,B.id]])).rows.map(r=>r.row);
    await change(a,A.id,'DELETE',{expectedVersion:3});
    const restored=await change(a,B.id,'POST',{expectedVersion:2},randomUUID(),true);expect(restored.statusCode,restored.body).toBe(200);
    await transaction(pool,async client=>{
      await client.query('DELETE FROM daily_care_record WHERE id=ANY($1::uuid[])',[[A.id,B.id]]);
      await client.query('INSERT INTO daily_care_record SELECT * FROM jsonb_populate_recordset(NULL::daily_care_record,$1::jsonb)',[JSON.stringify(backup)]);
      await client.query('INSERT INTO daily_care_record_revision SELECT * FROM jsonb_populate_recordset(NULL::daily_care_record_revision,$1::jsonb)',[JSON.stringify(revisions)]);
    });
    const once=await get(a);expect(once.json().items).toEqual([restored.json().record]);expect(once.json().totalCount).toBe(1);
    const edit=await change(a,B.id,'PUT',{...body,selfAssessment:'attention',careDay:B.careDay,expectedVersion:3});expect(edit.statusCode,edit.body).toBe(200);
    await new AccountClosure(directory).replayPendingErasure(pool);
    expect((await get(a)).json().items).toEqual([edit.json().record]);
    expect((await pool.query('SELECT version,deleted_at FROM daily_care_record WHERE id=$1',[A.id])).rows[0].version).toBe(4);
  });
});
