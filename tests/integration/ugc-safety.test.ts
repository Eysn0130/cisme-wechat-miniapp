import { createCipheriv,createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApiGatewayStorage } from "../../services/api/src/storage";
import { UgcSafetyService, securityTextParts } from "../../services/api/src/ugcSafety";
import { FormalUgcService } from "../../services/api/src/formalUgc";
import { AuthorityService } from "../../services/api/src/authority";
import { MemberProfile,communityAuthors } from "../../services/api/src/memberProfile";

const pool=testPool();
const config=loadConfig({APP_ENV:"test",DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:"ugc-safety-session",
  ADMIN_API_TOKEN:"ugc-safety-admin",UPLOAD_TOKEN_SECRET:"ugc-safety-upload",WECHAT_APP_ID:"wx-test-app",
  WECHAT_APP_SECRET:"test-secret",WECHAT_MESSAGE_TOKEN:"test-callback-token",
  WECHAT_MESSAGE_PLAINTEXT_TEST_ONLY:"true"});
let owner:string,post:string,media:string;
const signature=(timestamp:string,nonce:string)=>createHash("sha1").update(["test-callback-token",timestamp,nonce].sort().join("")).digest("hex");
const signedQuery=(nonce:string)=>{const timestamp=Math.floor(Date.now()/1000).toString();
  return {timestamp,nonce,signature:signature(timestamp,nonce)};};
// Independent synthetic message-push vector: explicit framing, padding and
// signature construction, not a round trip through the service decoder.
const messageKey=Buffer.from("0123456789abcdef0123456789abcdef");
const messageAesKey=messageKey.toString("base64").slice(0,43);
function encryptedVector(content:string,recipient="wx-test-app",nonce="cipher-nonce"){
  const message=Buffer.from(content,"utf8"),length=Buffer.alloc(4);length.writeUInt32BE(message.length);
  const plain=Buffer.concat([Buffer.from("abcdefghijklmnop"),length,message,Buffer.from(recipient)]);
  const pad=32-plain.length%32;
  const cipher=createCipheriv("aes-256-cbc",messageKey,messageKey.subarray(0,16));
  cipher.setAutoPadding(false);
  const encrypt=Buffer.concat([cipher.update(Buffer.concat([plain,Buffer.alloc(pad,pad)])),cipher.final()]).toString("base64");
  const timestamp=Math.floor(Date.now()/1000).toString();
  const msg_signature=createHash("sha1").update(["test-callback-token",timestamp,nonce,encrypt].sort().join("")).digest("hex");
  return {query:{timestamp,nonce,msg_signature},body:{Encrypt:encrypt}};
}
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
    expect(options?.redirect).toBe("error");
    const target=String(url);
    if(target.includes("/cgi-bin/token"))return new Response(JSON.stringify({access_token:"synthetic-token",expires_in:7200}),{status:200});
    if(target.includes("/msg_sec_check"))return new Response(JSON.stringify({errcode:0,trace_id:"text-trace",result:{suggest:"pass"}}),{status:200});
    if(target.includes("/media_check_async")){
      scanSourceUrl=String(JSON.parse(String(options?.body)).media_url);
      return new Response(JSON.stringify({errcode:0,trace_id:`image-trace-${++trace}`}),{status:200});
    }
    throw new Error("Unexpected URL");
  }) as typeof fetch;
  const storage=createApiGatewayStorage(config);
  const reader=vi.spyOn(storage,'read').mockResolvedValue({bytes:new Uint8Array([1,2,3]),mimeType:'image/png'});
  const service=new UgcSafetyService(pool,config,storage,fetcher);
  const started=await service.scanPost(owner,post,"https://scan.example.test");
  expect(started.results).toEqual([{kind:"text",state:"safe"},{kind:"image",id:media,state:"pending"}]);
  expect(scanSourceUrl).toContain(`/v1/ugc/scan-source/${media}`);
  await service.scanSource(media,new URL(scanSourceUrl).searchParams.get('token'));
  expect(reader).toHaveBeenCalledTimes(1);
  await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[owner]);
  try{
    await expect(service.scanSource(media,new URL(scanSourceUrl).searchParams.get('token')))
      .rejects.toMatchObject({code:'UGC_SCAN_SOURCE_INVALID',status:404});
    expect(reader).toHaveBeenCalledTimes(1);
  }finally{await pool.query("UPDATE member SET status='active' WHERE id=$1",[owner]);}
  await expect(service.scanSource("00000000-0000-4000-8000-000000000001",new URL(scanSourceUrl).searchParams.get("token")))
    .rejects.toMatchObject({code:"UGC_SCAN_SOURCE_INVALID",status:403});
  expect((await pool.query("SELECT scan_result FROM ugc_media_asset WHERE id=$1",[media])).rows[0].scan_result).toEqual({});
  const callback={Event:"wxa_media_check",appid:"wx-test-app",version:2,trace_id:"image-trace-1",errcode:0,
    result:{suggest:"pass",label:100}};
  const query=signedQuery("safety-nonce");
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

it("binds the callback ciphertext to its signature and the decrypted recipient",async()=>{
  const encryptedConfig={...config,wechat:{...config.wechat,messageAesKey,plaintextCallbackTestOnly:false}};
  const safety=new UgcSafetyService(pool,encryptedConfig,createApiGatewayStorage(config));
  const payload={Event:"wxa_media_check",appid:"wx-test-app",version:2,trace_id:"unknown-encrypted-trace-01",
    errcode:0,result:{suggest:"pass"}};
  const vector=encryptedVector(JSON.stringify(payload));
  await expect(safety.receiveCallback({...vector.query,msg_signature:"0".repeat(40)},vector.body))
    .rejects.toMatchObject({code:"UGC_CALLBACK_UNAUTHORIZED"});
  await expect(safety.receiveCallback(vector.query,{Encrypt:vector.body.Encrypt.slice(0,-4)+"AAAA"}))
    .rejects.toMatchObject({code:"UGC_CALLBACK_UNAUTHORIZED"});
  await expect(safety.receiveCallback(vector.query,payload)).rejects.toMatchObject({code:"UGC_CALLBACK_ENCRYPTION_REQUIRED"});
  const stale={...vector.query,timestamp:String(Number(vector.query.timestamp)-601)};
  await expect(safety.receiveCallback(stale,vector.body)).rejects.toMatchObject({code:"UGC_CALLBACK_UNAUTHORIZED"});
  const wrongRecipient=encryptedVector(JSON.stringify(payload),"wx-other-app");
  await expect(safety.receiveCallback(wrongRecipient.query,wrongRecipient.body))
    .rejects.toMatchObject({code:"UGC_CALLBACK_UNAUTHORIZED"});
  expect(await safety.receiveCallback(vector.query,vector.body)).toBe("success");
  expect(await safety.receiveCallback(vector.query,vector.body)).toBe("success");
  const changed=encryptedVector(JSON.stringify({...payload,result:{suggest:"risky"}}));
  await expect(safety.receiveCallback(changed.query,changed.body)).rejects.toMatchObject({code:"UGC_CALLBACK_CONFLICT"});
  const row=(await pool.query(`SELECT applied_at,payload FROM ugc_safety_callback_inbox WHERE trace_id=$1`,
    [payload.trace_id])).rows[0];
  expect(row.applied_at).toBeNull();expect(row.payload.result.suggest).toBe("pass");
  const challenge=encryptedVector("challenge-accepted");
  expect(safety.verifyChallenge({...challenge.query,echostr:challenge.body.Encrypt})).toBe("challenge-accepted");
});

it("commits one scan claim before concurrent workers call the external scanner",async()=>{
  const client=await pool.connect();let target="";
  try{await client.query("BEGIN");
    target=(await client.query(`INSERT INTO ugc_post(author_member_id,client_request_key)
      VALUES($1,'concurrent-safety-post-001') RETURNING id`,[owner])).rows[0].id;
    await client.query(`INSERT INTO ugc_post_revision(post_id,revision,created_by_member_id,body,
      moderation_state,rights_confirmed,public_consent_confirmed)
      VALUES($1,1,$2,'并发扫描内容','pending',true,true)`,[target,owner]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  const asset=(await pool.query(`INSERT INTO ugc_media_asset(owner_member_id,kind,object_key,mime_type,
    size_bytes,sha256,state,authorization_expires_at,uploaded_at,authorized_max_bytes)
    VALUES($1,'image',$2,'image/png',10,$3,'uploaded',now()+interval '1 hour',now(),100)
    RETURNING id`,[owner,`ugc/test/concurrent-${target}`,"d".repeat(64)])).rows[0].id;
  await pool.query(`INSERT INTO ugc_post_media(post_id,revision,media_asset_id,position)
    VALUES($1,1,$2,0)`,[target,asset]);
  await pool.query("UPDATE ugc_post SET state='pending_review' WHERE id=$1",[target]);
  let textCalls=0,imageCalls=0;
  const fetcher=(async(url:string|URL|Request)=>{
    const path=String(url);
    if(path.includes("/cgi-bin/token"))return new Response(JSON.stringify({access_token:"fixture-token"}),{status:200});
    if(path.includes("/msg_sec_check")){textCalls+=1;
      await new Promise(resolve=>setTimeout(resolve,20));
      return new Response(JSON.stringify({errcode:0,result:{suggest:"pass"}}),{status:200});}
    if(path.includes("/media_check_async")){imageCalls+=1;
      await new Promise(resolve=>setTimeout(resolve,20));
      return new Response(JSON.stringify({errcode:0,trace_id:"concurrent-trace-01"}),{status:200});}
    throw new Error("Unexpected scan path");
  }) as typeof fetch;
  const first=new UgcSafetyService(pool,config,createApiGatewayStorage(config),fetcher);
  const second=new UgcSafetyService(pool,config,createApiGatewayStorage(config),fetcher);
  await Promise.all([first.scanPost(owner,target,"https://scan.example.test"),
    second.scanPost(owner,target,"https://scan.example.test")]);
  expect(textCalls).toBe(1);expect(imageCalls).toBe(1);
  expect((await pool.query(`SELECT count(*)::int AS n FROM ugc_safety_scan WHERE post_id=$1`,[target])).rows[0].n).toBe(2);
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
  await pool.query(`INSERT INTO ugc_safety_scan(post_id,revision,media_asset_id,kind,content_sha256,provider,trace_id,requested_at,
    state,result,resolved_at)
    VALUES($1,1,$2,'image',$3,'wechat_v2','older-safe-trace',now()-interval '1 minute',
      'error','{"reason":"prior_scan_replaced"}'::jsonb,now()-interval '30 seconds'),
      ($1,1,$2,'image',$3,'wechat_v2','newer-risky-trace',now(),'pending',NULL,NULL)`,[newerPost,newerMedia,"b".repeat(64)]);
  const safety=new UgcSafetyService(pool,config,createApiGatewayStorage(config));
  const query=signedQuery("safety-order");
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

it("claims a comment scan before two workers can both call the provider",async()=>{
  const comment=(await pool.query(`INSERT INTO ugc_comment(post_id,author_member_id,body,operation_id)
    VALUES($1,$2,'另一条真实感受的内容检测','ugc-comment-lease-0001') RETURNING id`,[post,owner])).rows[0].id;
  let entered!:()=>void,release!:()=>void,scanCalls=0;
  const externalStarted=new Promise<void>(resolve=>{entered=resolve;});
  const finishExternal=new Promise<void>(resolve=>{release=resolve;});
  const fetcher=(async(url:string|URL|Request)=>{
    if(String(url).includes("/cgi-bin/token"))return new Response(JSON.stringify({access_token:"synthetic-token",expires_in:7200}),{status:200});
    if(String(url).includes("/msg_sec_check")){
      scanCalls++;entered();await finishExternal;
      return new Response(JSON.stringify({errcode:0,result:{suggest:"pass"}}),{status:200});
    }
    throw new Error("Unexpected URL");
  }) as typeof fetch;
  const firstService=new UgcSafetyService(pool,config,createApiGatewayStorage(config),fetcher);
  const secondService=new UgcSafetyService(pool,config,createApiGatewayStorage(config),fetcher);
  const first=firstService.scanComment(comment);
  await externalStarted;
  expect(await secondService.scanComment(comment)).toMatchObject({state:"pending"});
  expect(scanCalls).toBe(1);
  release();
  expect(await first).toMatchObject({state:"safe"});
  expect((await pool.query("SELECT count(*)::int AS n FROM ugc_comment_safety_scan WHERE comment_id=$1",[comment])).rows[0].n).toBe(1);
});

it("keeps a new nickname out of public projection until version-bound provider safety and independent review",async()=>{
  const profiles=new MemberProfile(pool,"production");
  const reviewer=(await pool.query("INSERT INTO member(display_name) VALUES('Nickname independent reviewer') RETURNING id")).rows[0].id;
  await profiles.update(owner,{displayName:"待检查昵称",communityVisible:true,expectedVersion:0});
  expect((await communityAuthors(pool,[owner]))[owner]?.name).toBe("CISME 会员");
  await expect(profiles.review(reviewer,`member:${reviewer}`,owner,
    {decision:"approve",expectedVersion:1,reason:"安全审核未完成"})).rejects.toMatchObject({code:"UGC_NICKNAME_SCAN_REQUIRED"});
  let calls=0;
  const fake=(async(url:string|URL|Request,options?:RequestInit)=>{
    if(String(url).includes("/cgi-bin/token"))return new Response(JSON.stringify({access_token:"synthetic-token",expires_in:7200}),{status:200});
    if(String(url).includes("/msg_sec_check")){
      calls++;
      const body=JSON.parse(String(options?.body));
      expect(body).toMatchObject({content:"待检查昵称",scene:1,version:2,openid:"test-openid"});
      return new Response(JSON.stringify({errcode:0,result:{suggest:"pass"}}),{status:200});
    }
    throw new Error("Unexpected URL");
  }) as typeof fetch;
  const safety=new UgcSafetyService(pool,config,createApiGatewayStorage(config),fake);
  expect(await safety.scanNickname(owner)).toMatchObject({state:"safe"});
  expect(await safety.scanNickname(owner)).toMatchObject({state:"pending"});
  expect(calls).toBe(1);
  expect((await communityAuthors(pool,[owner]))[owner]?.name).toBe("CISME 会员");
  expect(await profiles.review(reviewer,`member:${reviewer}`,owner,
    {decision:"approve",expectedVersion:1,reason:"昵称安全结果与人工审核均已通过"})).toMatchObject({status:"approved"});
  expect((await communityAuthors(pool,[owner]))[owner]?.name).toBe("待检查昵称");
  await profiles.update(owner,{displayName:"新版待审昵称",communityVisible:true,expectedVersion:1});
  expect((await communityAuthors(pool,[owner]))[owner]?.name).toBe("CISME 会员");
  await expect(profiles.review(reviewer,`member:${reviewer}`,owner,
    {decision:"approve",expectedVersion:2,reason:"旧检测不能覆盖新昵称"})).rejects.toMatchObject({code:"UGC_NICKNAME_SCAN_REQUIRED"});
});
