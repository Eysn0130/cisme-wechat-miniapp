import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {loadConfig} from '@cisme/config';
import {testPool,resetDatabase,TEST_DATABASE_URL} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
const pool=testPool(),config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'role-fixture',ADMIN_API_TOKEN:'role-fixture',UPLOAD_TOKEN_SECRET:'role-fixture',OBJECT_STORAGE_DRIVER:'api_gateway'});
let app:Awaited<ReturnType<typeof createApp>>,root:any,target:any,imitator:any;
const auth=(p:any)=>({authorization:'Bearer '+p.sessionToken});
const path=(p:any)=>'/v1/management/users/'+p.memberId+'/administrator';
const read=(actor:any,p=target)=>app.inject({method:'GET',url:path(p),headers:auth(actor)});
const save=(actor:any,input:any,key='admin-role-'+randomUUID(),p=target)=>app.inject({method:'POST',url:path(p),headers:{...auth(actor),'idempotency-key':key},payload:input});
beforeAll(async()=>{
 await resetDatabase(pool);app=await createApp({config,pool,storage:createApiGatewayStorage(config)});
 const member=async(name:string)=>{const r=await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:randomUUID(),displayName:name,consents:[{documentType:'terms',version:'test'},{documentType:'privacy',version:'test'}]}});expect(r.statusCode,r.body).toBe(200);return r.json();};
 root=await member('最高管理员');target=await member('待设置会员');imitator=await member('HEHEHE');config.memberAdministrationRootId=root.memberId;
 for(const p of [root,imitator])for(const cap of ['member.profile.read','member.manage'])await pool.query("INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,$2,'fixture','isolated administrator fixture','test','integration_fixture')",[p.memberId,cap]);
},120000);
afterAll(async()=>{await app?.close();await pool.end();});
it('does not grant root authority through a nickname, member-management capability or page parameter',async()=>{
 expect((await read(imitator)).statusCode).toBe(403);expect((await read(target)).statusCode).toBe(403);
 expect((await save(imitator,{capabilities:['member.profile.read'],expectedVersion:'a'.repeat(64)})).statusCode).toBe(403);
 const overview=await app.inject({method:'GET',url:'/v1/management/users/'+target.memberId,headers:auth(imitator)});expect(overview.json().scope.administrators).toBe(false);
});
it('preserves the root account and refuses to remove its own access',async()=>{
 const r=await read(root,root);expect(r.statusCode,r.body).toBe(200);expect(r.json().rootOwner).toBe(true);expect(r.json().requiredCapabilities).toEqual(['member.profile.read','member.manage']);
 const denied=await save(root,{capabilities:[],expectedVersion:r.json().version},undefined,root);expect(denied.statusCode).toBe(403);
 const edit=await save(root,{capabilities:['member.profile.read','member.manage','support.read'],expectedVersion:r.json().version},undefined,root);expect(edit.statusCode,edit.body).toBe(200);expect((await read(root,root)).json().rootOwner).toBe(true);
});
it('adds an administrator exactly once and enforces the new duties on actual management requests',async()=>{
 const r=await read(root),key='role-replay-'+randomUUID(),body={capabilities:['member.profile.read','commerce.order.read'],expectedVersion:r.json().version};
 const first=await save(root,body,key);expect(first.statusCode,first.body).toBe(200);expect((await save(root,body,key)).json()).toEqual(first.json());
 expect((await pool.query("SELECT count(*)::int n FROM authority_grant WHERE member_id=$1 AND revoked_at IS NULL",[target.memberId])).rows[0].n).toBe(2);
 const own=await app.inject({method:'GET',url:'/v1/management/users',headers:auth(target)});expect(own.statusCode,own.body).toBe(200);expect(own.json().scope).toMatchObject({orders:true,contact:false,administrators:false});
 expect((await read(target,imitator)).statusCode).toBe(403);
 expect((await save(root,{...body,capabilities:['member.profile.read','member.manage']},key)).statusCode).toBe(409);
});
it('rejects stale edits and unknown capabilities without changing existing authority',async()=>{
 const r=await read(root),version=r.json().version;
 expect((await save(root,{capabilities:['support.read'],expectedVersion:version})).statusCode).toBe(200);
 expect((await save(root,{capabilities:[],expectedVersion:version})).statusCode).toBe(409);
 const current=(await read(root)).json();expect(current.capabilities).toEqual(['support.read']);
 expect((await save(root,{capabilities:['root.admin'],expectedVersion:current.version})).statusCode).toBe(422);
 expect((await save(root,{capabilities:['support.reply'],expectedVersion:current.version})).json().code).toBe('ADMINISTRATOR_DEPENDENCY_REQUIRED');
 expect((await read(root)).json().capabilities).toEqual(['support.read']);
});
it('removes delegated access while retaining grant and audit history',async()=>{
 const before=(await read(root)).json(),r=await save(root,{capabilities:[],expectedVersion:before.version});expect(r.statusCode,r.body).toBe(200);
 expect(r.json().capabilities).toEqual([]);expect((await app.inject({method:'GET',url:'/v1/me/authority',headers:auth(target)})).json().managementAvailable).toBe(false);
 expect((await pool.query('SELECT count(*)::int n FROM authority_grant WHERE member_id=$1',[target.memberId])).rows[0].n).toBe(3);
 expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE object_id=$1 AND action='member.admin.roles.update'",[target.memberId])).rows[0].n).toBe(3);
});
