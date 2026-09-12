import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApiGatewayStorage } from "../../services/api/src/storage";
import { UgcSafetyService, securityTextParts } from "../../services/api/src/ugcSafety";
import { FormalUgcService } from "../../services/api/src/formalUgc";
import { AuthorityService } from "../../services/api/src/authority";

const pool=testPool();
const config=loadConfig({APP_ENV:"test",DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:"ugc-safety-session",
  ADMIN_API_TOKEN:"ugc-safety-admin",UPLOAD_TOKEN_SECRET:"ugc-safety-upload",WECHAT_APP_ID:"wx-test-app",
  WECHAT_APP_SECRET:"test-secret",WECHAT_MESSAGE_TOKEN:"test-callback-token"});
let owner:string,post:string,media:string;
const signature=(timestamp:string,nonce:string)=>createHash("sha1").update(["test-callback-token",timestamp,nonce].sort().join("")).digest("hex");
it("checks long Chinese stories in overlapping chunks within the platform limit",()=>{
  const content=Array.from({length:5000},(_,index)=>String.fromCharCode(0x4e00+index)).join("");
  const parts=securityTextParts(content);
  expect(parts.length).toBe(3);
  expect(parts.every(part=>Array.from(part).length<=2500)).toBe(true);
  expect(parts[0]!.slice(-200)).toBe(parts[1]!.slice(0,200));
  expect(parts[1]!.slice(-200)).toBe(parts[2]!.slice(0,200));
});
beforeAll(async()=>{
  await resetDatabase(pool);
  owner=(await pool.query("INSERT INTO member(display_name) VALUES('UGC safety owner') RETURNING id")).rows[0].id;
  await pool.query(`INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter)
    VALUES($1,'wechat_miniprogram','wx-test-app','test-openid','wechat')`,[owner]);
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    post=(await client.query("INSERT INTO ugc_post(author_member_id,client_request_key) VALUES($1,'safety-request-0001') RETURNING id",[owner])).rows[0].id;
    await client.query(`INSERT INTO ugc_post_revision(post_id,revision,created_by_member_id,title,body,moderation_state,rights_confirmed,public_consent_confirmed)
      VALUES($1,1,$2,'测试标题','真实使用感受','pending',true,true)`,[post,owner]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  media=(await pool.query(`INSERT INTO ugc_media_asset(owner_member_id,kind,object_key,mime_type,size_bytes,sha256,
    state,authorization_expires_at,uploaded_at,authorized_max_bytes)
    VALUES($1,'image','ugc/test/safety','image/png',10,$2,'uploaded',now()+interval '1 hour',now(),100)
    RETURNING id`,[owner,"a".repeat(64)])).rows[0].id;
  await pool.query("INSERT INTO ugc_post_media(post_id,revision,media_asset_id,position) VALUES($1,1,$2,0)",[post,media]);
  await pool.query("UPDATE ugc_post SET state='pending_review' WHERE id=$1",[post]);
});
afterAll(async()=>pool.end());

it("correlates signed async media results, ignores replay, and never revives deleted posts",async()=>{
  let trace=0,scanSourceUrl="";
  const fetcher=(async(url:string|URL|Request,options?:RequestInit)=>{
    const target=String(url);
    if(target.includes("/cgi-bin/token"))return new Response(JSON.stringify({access_token:"synthetic-token",expires_in:7200}),{status:200});
    if(target.includes("/msg_sec_check"))return new Response(JSON.stringify({errcode:0,trace_id:"text-trace",result:{suggest:"pass"}}),{status:200});
    if(target.includes("/media_check_async")){
      scanSourceUrl=String(JSON.parse(String(options?.body)).media_url);
      return new Response(JSON.stringify({errcode:0,trace_id:`image-trace-${++trace}`}),{status:200});
    }
    throw new Error("Unexpected URL");
  }) as typeof fetch;
  const service=new UgcSafetyService(pool,config,createApiGatewayStorage(config),fetcher);
  const started=await service.scanPost(owner,post,"https://scan.example.test");
  expect(started.results).toEqual([{kind:"text",state:"safe"},{kind:"image",id:media,state:"pending"}]);
  expect(scanSourceUrl).toContain(`/v1/ugc/scan-source/${media}`);
  await expect(service.scanSource("00000000-0000-4000-8000-000000000001",new URL(scanSourceUrl).searchParams.get("token")))
    .rejects.toMatchObject({code:"UGC_SCAN_SOURCE_INVALID",status:403});
  expect((await pool.query("SELECT scan_result FROM ugc_media_asset WHERE id=$1",[media])).rows[0].scan_result).toEqual({});
  const callback={Event:"wxa_media_check",appid:"wx-test-app",version:2,trace_id:"image-trace-1",errcode:0,
    result:{suggest:"pass",label:100}};
  const query={timestamp:"1789250000",nonce:"safety-nonce",signature:signature("1789250000","safety-nonce")};
  await expect(service.receiveCallback({...query,signature:"invalid"},callback)).rejects.toMatchObject({code:"UGC_CALLBACK_UNAUTHORIZED"});
  expect(await service.receiveCallback(query,callback)).toBe("success");
  expect(await service.receiveCallback(query,callback)).toBe("success");
  const asset=(await pool.query("SELECT state,scan_result FROM ugc_media_asset WHERE id=$1",[media])).rows[0];
  expect(asset.state).toBe("scanning");
  expect(asset.scan_result).toMatchObject({verdict:"safe",provider:"wechat_v2",traceId:"image-trace-1"});
  expect((await pool.query("SELECT count(*)::int AS n FROM ugc_safety_callback_inbox")).rows[0].n).toBe(1);

  await pool.query("UPDATE ugc_media_asset SET scan_result='{}'::jsonb WHERE id=$1",[media]);
  await pool.query(`INSERT INTO ugc_safety_scan(post_id,revision,media_asset_id,kind,content_sha256,provider,trace_id)
    VALUES($1,1,$2,'image',$3,'wechat_v2','image-trace-late')`,[post,media,"a".repeat(64)]);
  await pool.query("UPDATE ugc_post SET state='deleted',visibility='private',deleted_at=now() WHERE id=$1",[post]);
  await expect(service.scanSource(media,new URL(scanSourceUrl).searchParams.get("token")))
    .rejects.toMatchObject({code:"UGC_SCAN_SOURCE_INVALID",status:404});
  await service.receiveCallback(query,{...callback,trace_id:"image-trace-late"});
  expect((await pool.query("SELECT scan_result FROM ugc_media_asset WHERE id=$1",[media])).rows[0].scan_result).toEqual({});
});

it("keeps the newest image scan authoritative when callbacks arrive out of order",async()=>{
  const client=await pool.connect();let newerPost="";
  try{
    await client.query("BEGIN");
    newerPost=(await client.query("INSERT INTO ugc_post(author_member_id,client_request_key) VALUES($1,'safety-ordered-post') RETURNING id",[owner])).rows[0].id;
    await client.query(`INSERT INTO ugc_post_revision(post_id,revision,created_by_member_id,body,moderation_state,rights_confirmed,public_consent_confirmed)
      VALUES($1,1,$2,'另一张图片','pending',true,true)`,[newerPost,owner]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  const newerMedia=(await pool.query(`INSERT INTO ugc_media_asset(owner_member_id,kind,object_key,mime_type,size_bytes,sha256,
    state,authorization_expires_at,uploaded_at,authorized_max_bytes)
    VALUES($1,'image','ugc/test/ordered','image/png',10,$2,'scanning',now()+interval '1 hour',now(),100) RETURNING id`,
    [owner,"b".repeat(64)])).rows[0].id;
  await pool.query("INSERT INTO ugc_post_media(post_id,revision,media_asset_id,position) VALUES($1,1,$2,0)",[newerPost,newerMedia]);
  await pool.query("UPDATE ugc_post SET state='pending_review' WHERE id=$1",[newerPost]);
  await pool.query(`INSERT INTO ugc_safety_scan(post_id,revision,media_asset_id,kind,content_sha256,provider,trace_id,requested_at)
    VALUES($1,1,$2,'image',$3,'wechat_v2','older-safe-trace',now()-interval '1 minute'),
      ($1,1,$2,'image',$3,'wechat_v2','newer-risky-trace',now())`,[newerPost,newerMedia,"b".repeat(64)]);
  const safety=new UgcSafetyService(pool,config,createApiGatewayStorage(config));
  const query={timestamp:"1789250000",nonce:"safety-order",signature:signature("1789250000","safety-order")};
  const callback={Event:"wxa_media_check",appid:"wx-test-app",version:2,errcode:0};
  await safety.receiveCallback(query,{...callback,trace_id:"newer-risky-trace",result:{suggest:"risky"}});
  await safety.receiveCallback(query,{...callback,trace_id:"older-safe-trace",result:{suggest:"pass"}});
  expect((await pool.query("SELECT scan_result->>'verdict' AS verdict FROM ugc_media_asset WHERE id=$1",[newerMedia])).rows[0].verdict).toBe("risky");
});

it("requires a WeChat text result before a human can publish a comment",async()=>{
  const reviewer=(await pool.query("INSERT INTO member(display_name) VALUES('UGC safety reviewer') RETURNING id")).rows[0].id;
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'community.moderate','fixture','isolated scanner test','test','integration_fixture')`,[reviewer]);
  const client=await pool.connect();let published="";
  try{
    await client.query("BEGIN");
    published=(await client.query("INSERT INTO ugc_post(author_member_id,client_request_key) VALUES($1,'safety-comment-post') RETURNING id",[owner])).rows[0].id;
    await client.query(`INSERT INTO ugc_post_revision(post_id,revision,created_by_member_id,body,moderation_state,rights_confirmed,public_consent_confirmed)
      VALUES($1,1,$2,'公开故事','approved',true,true)`,[published,owner]);
    await client.query("UPDATE ugc_post SET state='published',visibility='public',published_revision=1,published_at=now() WHERE id=$1",[published]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  const comment=(await pool.query(`INSERT INTO ugc_comment(post_id,author_member_id,body,operation_id)
    VALUES($1,$2,'这是真实使用感受','ugc-comment-scan-0001') RETURNING id`,[published,owner])).rows[0].id;
  const formal=new FormalUgcService(pool,{...config,env:"production"},createApiGatewayStorage(config),new AuthorityService(pool,"test"));
  await expect(formal.reviewComment(reviewer,comment,{decision:"approve",reason:"合成评论安全复核"})).rejects.toMatchObject({code:"UGC_TEXT_SCAN_REQUIRED"});
  const fake=(async(url:string|URL|Request)=>new Response(JSON.stringify(String(url).includes("/cgi-bin/token")
    ?{access_token:"synthetic-token",expires_in:7200}:{errcode:0,result:{suggest:"pass"}}),{status:200})) as typeof fetch;
  const safety=new UgcSafetyService(pool,config,createApiGatewayStorage(config),fake);
  expect(await safety.scanComment(comment)).toMatchObject({state:"safe"});
  expect(await formal.reviewComment(reviewer,comment,{decision:"approve",reason:"合成评论安全复核"})).toMatchObject({state:"published"});
});
