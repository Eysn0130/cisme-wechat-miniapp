import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {resetDatabase,testPool} from '@cisme/testkit';
import {CISME_OFFICIAL_PUBLISHER} from '@cisme/contracts';
const pool=testPool();
beforeAll(()=>resetDatabase(pool));afterAll(()=>pool.end());
it('classifies only an explicitly authorized historical brand record and preserves member and article facts',async()=>{
 const [up,down]=(await readFile('db/migrations/202611040003_official_editorial_publisher.sql','utf8')).split('-- migrate:down');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query(down!);
  const owner=(await client.query("INSERT INTO member(display_name) VALUES('HEHEHE') RETURNING id")).rows[0].id;
  await client.query("INSERT INTO member_profile(member_id,handle_source,community_bio,community_bio_revision) VALUES($1,'self_reported','个人的简介',7)",[owner]);
  const ids=[randomUUID(),randomUUID()];
  for(const id of ids)await client.query(`INSERT INTO editorial_article(id,external_ref,author_member_id,author_display_name,title,excerpt,body,authorization_ref,rights_evidence,content_sha256,status,published_by,published_principal_id)
    VALUES($1,$2,$3,$4,'合成标题','','合成正文','synthetic:owner','{}',$5,'published',$3,'synthetic:actor')`,[id,'synthetic:'+id,owner,CISME_OFFICIAL_PUBLISHER.name,'a'.repeat(64)]);
  await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
    VALUES('synthetic:operator','editorial.author_relabel','editorial_article',$1,'OWNER_AUTHORIZED_AUTHOR_RELABEL',$2,gen_random_uuid()::text)`,
    [ids[0],{authorName:CISME_OFFICIAL_PUBLISHER.name,authorizationRef:'cisme-editorial-brand-author-owner-20261101'}]);
  const before=(await client.query('SELECT id,to_jsonb(a) AS fact FROM editorial_article a ORDER BY id')).rows;
  await client.query(up!);
  const after=(await client.query("SELECT id,to_jsonb(a)-'publisher_id' AS fact FROM editorial_article a ORDER BY id")).rows;
  expect(after).toEqual(before);
  expect((await client.query('SELECT publisher_id FROM editorial_article WHERE id=$1',[ids[0]])).rows[0].publisher_id).toBe(CISME_OFFICIAL_PUBLISHER.key);
  expect((await client.query('SELECT publisher_id FROM editorial_article WHERE id=$1',[ids[1]])).rows[0].publisher_id).toBeNull();
  expect((await client.query('SELECT display_name,community_bio,community_bio_revision FROM member JOIN member_profile ON member_id=id WHERE id=$1',[owner])).rows[0]).toEqual({display_name:'HEHEHE',community_bio:'个人的简介',community_bio_revision:7});
  expect((await client.query('SELECT id FROM member WHERE id=$1',[CISME_OFFICIAL_PUBLISHER.id])).rowCount).toBe(0);
  await client.query('SAVEPOINT preserve_publisher');
  await expect(client.query(down!)).rejects.toMatchObject({message:'OFFICIAL_PUBLISHER_FACTS_REQUIRE_PRESERVATION'});
  await client.query('ROLLBACK TO SAVEPOINT preserve_publisher');
 }finally{await client.query('ROLLBACK');client.release();}
});
