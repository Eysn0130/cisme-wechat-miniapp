import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@cisme/config';
import {resetDatabase,testPool,TEST_DATABASE_URL} from '@cisme/testkit';
import {createApp} from '../../services/api/src/server';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {communityAuthors} from '../../services/api/src/memberProfile';
import {memberCardNumberProjection,memberCardPortableQuery} from '../../services/api/src/memberCard';
import {portableQuerySpecs} from '../../services/api/src/privacyPortableQueries';

const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'synthetic-card-session',ADMIN_API_TOKEN:'synthetic-card-admin',UPLOAD_TOKEN_SECRET:'synthetic-card-upload',OBJECT_STORAGE_DRIVER:'api_gateway'});
let app:FastifyInstance,owner:any,other:any;
const input=(id:string)=>({externalUserId:id,displayName:'合成会员',consents:[{documentType:'privacy',version:'v1'},{documentType:'terms',version:'v1'}]});
const headers=(token:string)=>({authorization:`Bearer ${token}`});
beforeAll(async()=>{
  await resetDatabase(pool);app=await createApp({config,pool,storage:createApiGatewayStorage(config)});
  owner=(await app.inject({method:'POST',url:'/v1/identity/dev',payload:input('card-owner')})).json();
  other=(await app.inject({method:'POST',url:'/v1/identity/dev',payload:input('card-other')})).json();
});
afterAll(async()=>{await app.close();await pool.end();});

it('returns the same private, padded number from profile, bootstrap and account reads',async()=>{
  const number=(await pool.query(`SELECT ${memberCardNumberProjection} AS number FROM member_card_number mc WHERE member_id=$1`,[owner.memberId])).rows[0].number;
  expect(number).toMatch(/^\d{5,}$/);
  for(const url of ['/v1/me','/v1/me/profile','/v1/bootstrap/profile','/v1/bootstrap/settings']){
    expect((await app.inject({method:'GET',url})).statusCode).toBe(401);
    const result=await app.inject({method:'GET',url,headers:headers(owner.sessionToken)});expect(result.statusCode).toBe(200);
    const body=result.json();expect((body.member??body).card_number).toBe(number);
  }
  const again=(await app.inject({method:'POST',url:'/v1/identity/dev',payload:input('card-owner')})).json();
  expect(again.memberId).toBe(owner.memberId);
  expect((await pool.query('SELECT count(*)::int n FROM member_card_number WHERE member_id=$1',[owner.memberId])).rows[0].n).toBe(1);
});

it('allocates distinct numbers for concurrent registrations and never reuses a deleted number',async()=>{
  const ids=await Promise.all(Array.from({length:12},async()=>
    (await pool.query("INSERT INTO member(display_name) VALUES('合成并发建号') RETURNING id")).rows[0].id));
  const rows=(await pool.query('SELECT number::text FROM member_card_number WHERE member_id=ANY($1::uuid[])',[ids])).rows;
  expect(rows).toHaveLength(12);expect(new Set(rows.map(r=>r.number)).size).toBe(12);
  const oldNumber=BigInt(rows[0].number);
  const member=(await pool.query('SELECT member_id FROM member_card_number WHERE number=$1',[rows[0].number])).rows[0].member_id;
  await pool.query('DELETE FROM member WHERE id=$1',[member]);
  const next=(await pool.query("INSERT INTO member(display_name) VALUES('合成后续建号') RETURNING id")).rows[0].id;
  expect(BigInt((await pool.query('SELECT number::text FROM member_card_number WHERE member_id=$1',[next])).rows[0].number)).toBeGreaterThan(oldNumber);
});

it('cannot change a number through profile edits, identity fields or direct row mutation',async()=>{
  const before=(await pool.query('SELECT * FROM member_card_number WHERE member_id=$1',[owner.memberId])).rows[0];
  const result=await app.inject({method:'PUT',url:'/v1/me/profile',headers:headers(owner.sessionToken),payload:{displayName:'更新后的合成会员',expectedVersion:0,card_number:'00001',memberId:other.memberId,number:1}});
  expect(result.statusCode).toBe(200);
  expect((await pool.query('SELECT * FROM member_card_number WHERE member_id=$1',[owner.memberId])).rows[0]).toEqual(before);
  await expect(pool.query('UPDATE member_card_number SET number=DEFAULT WHERE member_id=$1',[owner.memberId])).rejects.toThrow('MEMBER_CARD_NUMBER_IMMUTABLE');
  expect((await pool.query('SELECT count(*)::int n FROM authority_grant WHERE member_id=$1',[owner.memberId])).rows[0].n).toBe(0);
});

it('keeps numbers out of public authors and includes only the owner in portable data',async()=>{
  const authors=await communityAuthors(pool,[owner.memberId,other.memberId]);
  expect(JSON.stringify(authors)).not.toMatch(/card_number|issued_at|member_card_number/);
  const spec=portableQuerySpecs.find(s=>s.section==='account'&&s.collection==='membershipCard')!;
  expect(spec.single).toBe(true);
  const own=(await pool.query(memberCardPortableQuery,[owner.memberId])).rows;
  expect((await pool.query(spec.sql,[owner.memberId])).rows).toEqual(own);
  expect(own).toHaveLength(1);expect(own[0].number).not.toBe((await pool.query(spec.sql,[other.memberId])).rows[0].number);
});

it('preserves all digits above five places and bigint precision',async()=>{
  for(const value of ['1','99999','100000','9223372036854775807']){
    const row=(await pool.query(`SELECT ${memberCardNumberProjection} AS number FROM (VALUES($1::bigint)) mc(number)`,[value])).rows[0];
    expect(row.number).toBe(value.padStart(5,'0'));
  }
});

it('backfills existing accounts in a deterministic order without changing member facts',async()=>{
  const sql=(await readFile('db/migrations/202611100006_member_card_number.sql','utf8')).split('-- migrate:down')[0]!.trim().replace(/^BEGIN;/,'').replace(/COMMIT;$/,'');
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    await c.query('DROP TRIGGER member_card_number_on_registration ON member;DROP TABLE member_card_number;DROP FUNCTION assign_member_card_number();DROP FUNCTION preserve_member_card_number()');
    const id=randomUUID();await c.query("INSERT INTO member(id,display_name,created_at) VALUES($1,'合成旧会员','2020-01-01T00:00:00Z')",[id]);
    const before=(await c.query('SELECT * FROM member ORDER BY created_at,id')).rows;
    await c.query(sql);
    expect((await c.query('SELECT * FROM member ORDER BY created_at,id')).rows).toEqual(before);
    expect((await c.query('SELECT member_id,number::text FROM member_card_number ORDER BY member_card_number.number')).rows).toEqual(before.map((r,i)=>({member_id:r.id,number:String(i+1)})));
  }finally{await c.query('ROLLBACK');c.release();}
});
