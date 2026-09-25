import {afterAll,beforeAll,expect,it} from 'vitest';
import {createDecipheriv} from 'node:crypto';
import {mkdir,open} from 'node:fs/promises';
import {join} from 'node:path';
import {loadConfig} from '@cisme/config';
import {TEST_DATABASE_URL,resetDatabase,testPool} from '@cisme/testkit';
import {transaction} from '../../services/api/src/db';
import {DeliveryAddressService} from '../../services/api/src/deliveryAddress';
import {buildPortableParts,needsPortableParts} from '../../services/api/src/privacyPortableParts';
import {createApiGatewayStorage} from '../../services/api/src/storage';
const pool=testPool();
const config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'portable-parts-test',
  UPLOAD_TOKEN_SECRET:'portable-parts-upload',OBJECT_STORAGE_DRIVER:'api_gateway',
  CONTACT_ENCRYPTION_KEY:'8'.repeat(64),CONTACT_HASH_KEY:'7'.repeat(64)});
const key=Buffer.alloc(32,7);
beforeAll(async()=>{await resetDatabase(pool);});
afterAll(async()=>{await pool.end();});
it('reads fixed owner projections through bounded cursors and stores decryptable parts',async()=>{
  const member=(await pool.query("INSERT INTO member(display_name,status) VALUES('测试副本','active') RETURNING id")).rows[0].id;
  const request=(await pool.query(`INSERT INTO privacy_request(member_id,kind,message,due_at)
    VALUES($1,'access','本人申请数据副本',now()+interval '30 days') RETURNING id`,[member])).rows[0].id;
  const job=(await pool.query(`INSERT INTO data_export_job(privacy_request_id,member_id,scope,requested_by)
    VALUES($1,$2,'{}','fixture') RETURNING id`,[request,member])).rows[0].id;
  const addresses=new DeliveryAddressService(pool,config),storage=createApiGatewayStorage(config);
  expect(await transaction(pool,client=>needsPortableParts(client,member),'REPEATABLE READ')).toBe(false);
  const result=await transaction(pool,client=>buildPortableParts(client,config,addresses,storage,job,member,key),
    'REPEATABLE READ',1,30_000);
  expect(result.partCount).toBeGreaterThan(0);
  const rows=(await pool.query('SELECT * FROM privacy_export_part WHERE job_id=$1 ORDER BY part_number',[job])).rows;
  expect(rows.length).toBe(result.partCount);
  const text=Buffer.concat(rows.map(row=>{
    const decipher=createDecipheriv('aes-256-gcm',key,row.iv);decipher.setAuthTag(row.auth_tag);
    return Buffer.concat([decipher.update(row.ciphertext),decipher.final()]);
  })).toString();
  const records=text.trim().split('\n').map(line=>JSON.parse(line));
  expect(records[0]).toMatchObject({type:'header',schema:'cisme.member.portable.v2',memberId:member});
  expect(records.find(row=>row.section==='account'&&row.collection==='member')).toMatchObject({row:{id:member}});
  expect(records.at(-1)).toMatchObject({type:'footer',unavailableMediaCount:0});
});
it('splits thousands of owned records into complete ordered parts',async()=>{
  const member=(await pool.query("INSERT INTO member(display_name,status) VALUES('大副本','active') RETURNING id")).rows[0].id;
  await pool.query(`INSERT INTO privacy_request(member_id,kind,message,due_at)
    SELECT $1,'other',repeat('x',1800)||n::text,now()+interval '30 days'
    FROM generate_series(1,3000) n`,[member]);
  const request=(await pool.query(`INSERT INTO privacy_request(member_id,kind,message,due_at)
    VALUES($1,'access','本人申请分卷副本',now()+interval '30 days') RETURNING id`,[member])).rows[0].id;
  const job=(await pool.query(`INSERT INTO data_export_job(privacy_request_id,member_id,scope,requested_by)
    VALUES($1,$2,'{}','fixture') RETURNING id`,[request,member])).rows[0].id;
  expect(await transaction(pool,client=>needsPortableParts(client,member),'REPEATABLE READ',1,45_000)).toBe(true);
  const result=await transaction(pool,client=>buildPortableParts(client,config,
    new DeliveryAddressService(pool,config),createApiGatewayStorage(config),job,member,key),
    'REPEATABLE READ',1,45_000);
  expect(result.partCount).toBeGreaterThanOrEqual(2);
  const parts=(await pool.query('SELECT part_number,plain_bytes FROM privacy_export_part WHERE job_id=$1 ORDER BY part_number',[job])).rows;
  expect(parts.map(part=>part.part_number)).toEqual(parts.map((_,index)=>index+1));
  expect(parts.every(part=>part.plain_bytes<=4*1024*1024)).toBe(true);
  expect(result.counts['rights.requests']).toBe(3001);
  expect(parts.length).toBe(result.partCount);
});
it('includes an owned object above the former 64 MiB read cap through fixed ranges',async()=>{
  const member=(await pool.query("INSERT INTO member(display_name,status) VALUES('大素材副本','active') RETURNING id")).rows[0].id;
  const request=(await pool.query(`INSERT INTO privacy_request(member_id,kind,message,due_at)
    VALUES($1,'access','大素材',now()+interval '30 days') RETURNING id`,[member])).rows[0].id;
  const job=(await pool.query(`INSERT INTO data_export_job(privacy_request_id,member_id,scope,requested_by)
    VALUES($1,$2,'{}','fixture') RETURNING id`,[request,member])).rows[0].id;
  const root=process.env.CISME_TEST_OBJECT_ROOT;
  if(!root)throw new Error('DISPOSABLE_OBJECT_ROOT_REQUIRED');
  const objectKey=`large-owned-${job}`;
  await mkdir(join(root,'objects'),{recursive:true});
  const size=65*1024*1024;
  const handle=await open(join(root,'objects',objectKey),'w');
  try{
    const chunk=Buffer.alloc(256*1024,0x5a);
    for(let written=0;written<size;written+=chunk.length)await handle.write(chunk);
  }finally{await handle.close();}
  await pool.query(`INSERT INTO ugc_media_asset(owner_member_id,kind,object_key,mime_type,size_bytes,
    state,authorization_expires_at,uploaded_at)
    VALUES($1,'video',$2,'video/mp4',$3,'uploaded',now()+interval '1 day',now())`,[member,objectKey,size]);
  expect(await transaction(pool,client=>needsPortableParts(client,member),'REPEATABLE READ')).toBe(true);
  const storage=createApiGatewayStorage(config);
  let maxRange=0,peakRss=process.memoryUsage().rss;
  const startRss=peakRss;
  const observedStorage={...storage,
    read:async()=>{throw new Error('PORTABLE_WHOLE_MEDIA_READ_FORBIDDEN');},
    readRange:async(object:string,offset:number,length:number)=>{
      maxRange=Math.max(maxRange,length);
      return storage.readRange!(object,offset,length);
    }};
  const sampler=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},10);
  let result:Awaited<ReturnType<typeof buildPortableParts>>;
  try{
    result=await transaction(pool,client=>buildPortableParts(client,config,
      new DeliveryAddressService(pool,config),observedStorage,job,member,key),
      'REPEATABLE READ',1,120_000);
  }finally{clearInterval(sampler);peakRss=Math.max(peakRss,process.memoryUsage().rss);}
  expect(maxRange).toBe(256*1024);
  console.log(JSON.stringify({event:'portable-export-memory',mediaBytes:size,maxReadRangeBytes:maxRange,
    startRssBytes:startRss,peakRssBytes:peakRss,deltaRssBytes:peakRss-startRss}));
  expect(result).toMatchObject({complete:true,unavailableMediaCount:0,counts:expect.objectContaining({media:1})});
  expect(result.partCount).toBeGreaterThan(20);
  expect(result.totalBytes).toBeGreaterThan(size);
});
