import {afterAll,beforeAll,it,expect} from 'vitest';
import {loadConfig} from '@cisme/config';
import {TEST_DATABASE_URL,resetDatabase,testPool} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'synthetic-native-privacy',UPLOAD_TOKEN_SECRET:'synthetic-upload',OBJECT_STORAGE_DRIVER:'api_gateway'});
const app=await createApp({pool,config,storage:createApiGatewayStorage(config)});
let member:string,principal:string,token:string,otherToken:string,otherMember:string;
const headers=()=>({authorization:`Bearer ${token}`});
const queue='/v1/management/privacy-requests';
async function create(message:string){const r=await app.inject({method:'POST',url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${otherToken}`},payload:{kind:'access',message}});expect(r.statusCode).toBe(200);return r.json();}
async function grant(){await pool.query("INSERT INTO authority_grant(member_id,capability,environment,granted_by,grant_reason) VALUES($1,'privacy.request.manage','test','test','Synthetic native privacy test')",[member]);}
beforeAll(async()=>{await resetDatabase(pool);for(const name of ['operator','owner']){const r=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:`native-privacy-${name}`,displayName:`Synthetic ${name}`,consents:[{documentType:'privacy',version:'test'},{documentType:'terms',version:'test'}]}});expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('private, no-store');if(name==='operator'){member=r.json().memberId;principal=r.json().principalId;token=r.json().sessionToken;}else {otherMember=r.json().memberId;otherToken=r.json().sessionToken;}}});
afterAll(async()=>{await app.close();await pool.end();});
it('uses the signed member capability, not body/header identity or legacy roles',async()=>{
 expect((await app.inject({url:queue})).statusCode).toBe(401);
 await pool.query("INSERT INTO principal_role(principal_id,role) VALUES($1,'review_lead')",[principal]);
 {const denied=await app.inject({url:queue,headers:headers()});expect(denied.statusCode).toBe(403);expect(denied.headers['cache-control']).toBe('private, no-store');}
 await grant();
 const allowed=await app.inject({url:queue,headers:headers()});expect(allowed.statusCode).toBe(200);expect(allowed.headers['cache-control']).toBe('private, no-store');
 expect((await app.inject({url:queue,headers:{...headers(),'x-principal-id':'different'}})).statusCode).toBe(403);
 expect((await app.inject({url:queue,headers:{authorization:`Bearer ${otherToken}`}})).statusCode).toBe(403);
});
it('reaches requests beyond the first 100 with bounded owner and management pages',async()=>{
 const inserted=await pool.query<{id:string}>(`INSERT INTO privacy_request(member_id,kind,message,due_at,created_at)
   SELECT $1,'access','Historical request '||n,now()+interval '1 day',now()-interval '2 days'+n*interval '1 second'
   FROM generate_series(1,110) AS n RETURNING id`,[otherMember]);
 for(const [url,auth] of [['/v1/me/privacy-requests',`Bearer ${otherToken}`],[queue,`Bearer ${token}`]] as const){
   let cursor:string|undefined;const seen=new Set<string>();
   for(let page=0;page<10;page++){
     const response=await app.inject({url:`${url}?page=1${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,headers:{authorization:auth}});
     expect(response.statusCode).toBe(200);
     const result=response.json() as {items:Array<{id:string}>;nextCursor:string|null};
     expect(result.items.length).toBeLessThanOrEqual(30);
     for(const row of result.items){expect(seen.has(row.id),`${url} page ${page} repeats ${row.id}`).toBe(false);seen.add(row.id);}
     cursor=result.nextCursor??undefined;
     if(!cursor)break;
   }
   for(const row of inserted.rows)expect(seen.has(row.id)).toBe(true);
 }
 expect((await app.inject({url:`${queue}?page=1&cursor=broken`,headers:headers()})).statusCode).toBe(422);
 expect((await app.inject({url:`${queue}?page=1`,headers:{authorization:`Bearer ${otherToken}`}})).statusCode).toBe(403);
 expect((await app.inject({url:'/v1/me/privacy-requests?page=1',headers:headers()})).json().items).toEqual([]);
});
it('saves an audited versioned reply without claiming an export or erasure',async()=>{
 const created=await create('Synthetic portable-copy request'),path=`${queue}/${created.id}/response`;
 const payload={status:'responded',response:'已收到请求，正在核验导出范围。',expectedVersion:1};
 const result=await app.inject({method:'POST',url:path,headers:headers(),payload});expect(result.statusCode).toBe(200);expect(result.json().version).toBe(2);
 expect((await app.inject({method:'POST',url:path,headers:headers(),payload})).statusCode).toBe(409);
 const mine=(await app.inject({url:'/v1/me/privacy-requests',headers:{authorization:`Bearer ${otherToken}`}})).json();expect(mine.find((row:any)=>row.id===created.id)).toMatchObject({status:'responded',execution:null,response:payload.response});
 expect((await pool.query('SELECT id FROM data_export_job UNION ALL SELECT id FROM data_erasure_job')).rowCount).toBe(0);
 const audit=(await pool.query("SELECT principal_id,before_state,after_state FROM audit_log WHERE action='privacy.respond' AND object_id=$1",[created.id])).rows;expect(audit).toHaveLength(1);expect(audit[0].principal_id).toBe(principal);expect(JSON.stringify(audit)).not.toContain(payload.response);
});
it('rejects invalid commands without changing request facts',async()=>{
 const created=await create('Synthetic invalid-command probe');
 for(const payload of [{status:'completed',response:'done',expectedVersion:1},{status:'responded',response:' ',expectedVersion:1},{status:'responded',response:'x'.repeat(4001),expectedVersion:1},{status:'responded',response:'x',expectedVersion:0}])expect((await app.inject({method:'POST',url:`${queue}/${created.id}/response`,headers:headers(),payload})).statusCode).toBe(422);
 expect((await pool.query('SELECT status,version FROM privacy_request WHERE id=$1',[created.id])).rows[0]).toEqual({status:'received',version:1});
});
it('rejects replies that would overwrite approved or executing facts',async()=>{
 const created=await create('Synthetic protected lifecycle');
 await pool.query("UPDATE privacy_request SET status='reviewing' WHERE id=$1",[created.id]);
 await pool.query("UPDATE privacy_request SET status='approved' WHERE id=$1",[created.id]);
 const result=await app.inject({method:'POST',url:`${queue}/${created.id}/response`,headers:headers(),payload:{status:'responded',response:'Must not overwrite approval',expectedVersion:1}});
 expect(result.statusCode).toBe(409);expect(result.json().code).toBe('PRIVACY_RESPONSE_STATE_INVALID');
 expect((await pool.query('SELECT status FROM privacy_request WHERE id=$1',[created.id])).rows[0].status).toBe('approved');
});
it('rechecks revocation after a request-lock wait even when a legacy role remains',async()=>{
 const created=await create('Synthetic concurrent revocation probe'),lock=await pool.connect();let pending:Promise<{statusCode:number}>|undefined;
 try{await lock.query('BEGIN');await lock.query('SELECT id FROM privacy_request WHERE id=$1 FOR UPDATE',[created.id]);
 pending=app.inject({method:'POST',url:`${queue}/${created.id}/response`,headers:headers(),payload:{status:'responded',response:'Must not be saved after revocation',expectedVersion:1}});
 // Keep a reference to the started HTTP injection before waiting for the lock.
 const response=Promise.resolve(pending);
 let waiting=false;for(let n=0;n<100;n++){const rows=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'SELECT status,version FROM privacy_request%'");if(rows.rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}expect(waiting).toBe(true);
 await pool.query("UPDATE authority_grant SET revoked_at=now(),revoked_by='test',revoke_reason='Synthetic revoke' WHERE member_id=$1 AND capability='privacy.request.manage' AND revoked_at IS NULL",[member]);
 await lock.query('COMMIT');expect((await response).statusCode).toBe(403);
 expect((await pool.query('SELECT status,version FROM privacy_request WHERE id=$1',[created.id])).rows[0]).toEqual({status:'received',version:1});
 expect((await pool.query("SELECT 1 FROM audit_log WHERE action='privacy.respond' AND object_id=$1",[created.id])).rowCount).toBe(0);
 {const denied=await app.inject({url:queue,headers:headers()});expect(denied.statusCode).toBe(403);expect(denied.headers['cache-control']).toBe('private, no-store');}
 }finally{await lock.query('ROLLBACK');lock.release();if(pending)await pending;}
});
it('rejects blocked members even with a fresh valid capability',async()=>{
 await grant();await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[member]);
 expect((await app.inject({url:queue,headers:headers()})).statusCode).toBe(401);
});
