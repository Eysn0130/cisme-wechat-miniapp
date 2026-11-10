import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@cisme/config';
import {TEST_DATABASE_URL,testPool,resetDatabase} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
const pool=testPool();let app:FastifyInstance,admin:any,buyer:any;
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'synthetic-xlsx-session',UPLOAD_TOKEN_SECRET:'synthetic-xlsx-upload',ADMIN_API_TOKEN:'synthetic-admin',OBJECT_STORAGE_DRIVER:'api_gateway',CONTACT_ENCRYPTION_KEY:'11'.repeat(32),CONTACT_HASH_KEY:'22'.repeat(32),CONTACT_KEY_VERSION:'synthetic-xlsx-v1',COMMERCE_FULFILLMENT_ENABLED:'true',COMMERCE_FULFILLMENT_MERCHANT_ID:'1900000001',WECHAT_APP_ID:'wx4eac2d4fb11d299b'});
const fixture=readFileSync(new URL('../fixtures/commerce-fulfillment/roundtrip-openpyxl.xlsx',import.meta.url));
const identity=async(name:string)=>(await app.inject({method:'POST',url:'/v1/identity/dev',payload:{externalUserId:name,displayName:name,consents:[{documentType:'privacy',version:'v1'},{documentType:'terms',version:'v1'}]}})).json();
beforeAll(async()=>{await resetDatabase(pool);app=await createApp({config,pool,storage:createApiGatewayStorage(config)});admin=await identity('synthetic-xlsx-admin');buyer=await identity('synthetic-xlsx-buyer');await pool.query("INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source) VALUES($1,'commerce.fulfillment.manage','fixture','Synthetic XLSX HTTP test','test','integration_fixture')",[admin.memberId]);});
afterAll(async()=>{await app.close();await pool.end();});
const preview=(token:string,payload:unknown)=>app.inject({method:'POST',url:'/v1/management/shipments/import-xlsx/preview',headers:{authorization:`Bearer ${token}`},payload:payload as any});
it('requires the real server capability before parsing a document',async()=>{
  expect((await preview(buyer.sessionToken,{filename:'bad.xlsx',contentBase64:'malformed'})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/v1/management/shipments/import-xlsx/preview',payload:{}})).statusCode).toBe(401);
});
it('previews only logistics columns and creates no shipment, import plan or uploaded object',async()=>{
  const before=(await pool.query('SELECT count(*)::int AS n FROM commerce_shipment')).rows[0].n;
  const response=await preview(admin.sessionToken,{filename:'发货回填.xlsx',contentBase64:fixture.toString('base64')});
  expect(response.statusCode,response.body).toBe(200);expect(response.json()).toMatchObject({rowCount:1,skippedRows:1});
  expect(response.body).not.toContain('13800000000');expect(response.body).not.toContain('合成地址');
  expect((await pool.query('SELECT count(*)::int AS n FROM commerce_shipment')).rows[0].n).toBe(before);
  expect((await pool.query("SELECT count(*)::int AS n FROM idempotency_operation WHERE operation='commerce.shipment.import_plan'")).rows[0].n).toBe(0);
});
it('rejects non-XLSX, formula workbooks and access revoked before a retry',async()=>{
  expect((await preview(admin.sessionToken,{filename:'bad.xlsm',contentBase64:fixture.toString('base64')})).statusCode).toBe(422);
  const formula=readFileSync(new URL('../fixtures/commerce-fulfillment/formula-rejected.xlsx',import.meta.url));
  expect((await preview(admin.sessionToken,{filename:'bad.xlsx',contentBase64:formula.toString('base64')})).statusCode).toBe(422);
  await pool.query("UPDATE authority_grant SET revoked_at=now(),revoked_by='fixture' WHERE member_id=$1 AND capability='commerce.fulfillment.manage'",[admin.memberId]);
  expect((await preview(admin.sessionToken,{filename:'valid.xlsx',contentBase64:fixture.toString('base64')})).statusCode).toBe(403);
});
