import {afterAll,afterEach,beforeAll,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {loadConfig} from '@cisme/config';
import {TEST_DATABASE_URL,testPool,resetDatabase} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,ALLOW_DEV_ADAPTERS:'true',
 APP_SESSION_SECRET:'synthetic-public-session',UPLOAD_TOKEN_SECRET:'synthetic-public-upload',
 WECHAT_APP_ID:'wx0000000000000001',WECHAT_APP_SECRET:'synthetic-no-network',
 WECHAT_MESSAGE_TOKEN:'synthetic-message-token',WECHAT_MESSAGE_PLAINTEXT_TEST_ONLY:'true'});
let app:Awaited<ReturnType<typeof createApp>>;
const consents=[{documentType:'privacy',version:'synthetic-v1'},{documentType:'terms',version:'synthetic-v1'}];
beforeAll(async()=>{await resetDatabase(pool);app=await createApp({config,pool,storage:createApiGatewayStorage(config)});
 for(const type of ['terms','privacy'])await pool.query(`INSERT INTO legal_document(document_type,version,title,body,operator_name,contact,active)
 VALUES($1,'synthetic-v1','Synthetic only','Never publish this fixture','Synthetic','test@example.invalid',true)`,[type]);});
afterEach(()=>vi.unstubAllGlobals());afterAll(async()=>{await app.close();await pool.end();});
it('exposes only capability projections and rejects unsigned scanner fetches',async()=>{
 const capabilities=await app.inject({url:'/v1/capabilities'});expect(capabilities.statusCode).toBe(200);
 expect(capabilities.json()).toMatchObject({ugcGoLiveGate:false});
 expect(JSON.stringify(capabilities.json())).not.toMatch(/synthetic-no-network|synthetic-public-session/);
 const status=await app.inject({url:'/v1/ugc/status'});expect(status.json()).toEqual({publicEnabled:false,draftsEnabled:true});
 const scan=await app.inject({url:'/v1/ugc/scan-source/00000000-0000-4000-8000-000000000001?token=forged'});
 expect(scan.statusCode).toBe(403);expect(scan.json().code).toBe('UGC_SCAN_SOURCE_INVALID');
});
it('verifies callback challenges at HTTP entry without a member session and rejects altered signatures',async()=>{
 const timestamp=String(Math.floor(Date.now()/1000)),nonce='synthetic-challenge';
 const signature=createHash('sha1').update(['synthetic-message-token',timestamp,nonce].sort().join('')).digest('hex');
 const query=new URLSearchParams({timestamp,nonce,signature,echostr:'synthetic-echo'});
 const ok=await app.inject({url:`/v1/ugc/safety-callback?${query}`});expect(ok.statusCode).toBe(200);expect(ok.body).toBe('synthetic-echo');
 query.set('signature','0'.repeat(40));expect((await app.inject({url:`/v1/ugc/safety-callback?${query}`})).statusCode).toBe(401);
});
it('rejects malformed login codes before external calls or identity writes',async()=>{
 const transport=vi.fn<typeof fetch>();vi.stubGlobal('fetch',transport);
 for(const code of [undefined,null,{},'', 'x'.repeat(257)]){
  const response=await app.inject({method:'POST',url:'/v1/identity/wechat',payload:{code,displayName:'Synthetic',consents}});
  expect(response.statusCode).toBe(422);
 }
 expect(transport).not.toHaveBeenCalled();expect((await pool.query('SELECT 1 FROM wechat_identity')).rowCount).toBe(0);
});
it('binds provider identity to the configured app and omits provider identifiers from bootstrap',async()=>{
 const transport=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({openid:'synthetic-openid',unionid:'synthetic-unionid',session_key:'synthetic-provider-secret'})));
 vi.stubGlobal('fetch',transport);
 const login=await app.inject({method:'POST',url:'/v1/identity/wechat',payload:{code:'synthetic-login-code',displayName:'Synthetic',consents}});
 expect(login.statusCode,login.body).toBe(200);
 expect(transport.mock.calls[0]?.[0]).toContain('appid=wx0000000000000001');
 expect(login.body).not.toMatch(/synthetic-openid|synthetic-unionid|synthetic-provider-secret/);
 const headers={authorization:`Bearer ${login.json().sessionToken}`};
 for(const scope of ['home','profile','settings']){
  const response=await app.inject({url:`/v1/bootstrap/${scope}`,headers});expect(response.statusCode,response.body).toBe(200);
  expect(response.body).not.toMatch(/synthetic-openid|synthetic-unionid|synthetic-provider-secret/);
 }
 const row=(await pool.query('SELECT provider,app_id,openid FROM wechat_identity WHERE member_id=$1',[login.json().memberId])).rows[0];
 expect(row).toEqual({provider:'wechat_miniprogram',app_id:config.wechat.appId,openid:'synthetic-openid'});
});
it('does not persist malformed or failed provider facts and returns no provider error details',async()=>{
 const before=(await pool.query('SELECT count(*)::int n FROM wechat_identity')).rows[0].n;
 for(const body of [{errcode:40029,errmsg:'private-provider-detail'}, {openid:{}},{openid:'',unionid:'x'}, {openid:'valid',unionid:7}]){
  vi.stubGlobal('fetch',vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body))));
  const response=await app.inject({method:'POST',url:'/v1/identity/wechat',payload:{code:'synthetic-code',displayName:'Synthetic',consents}});
  expect(response.statusCode).toBe(502);expect(response.body).not.toContain('private-provider-detail');
 }
 expect((await pool.query('SELECT count(*)::int n FROM wechat_identity')).rows[0].n).toBe(before);
});
