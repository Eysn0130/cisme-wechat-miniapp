import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { loadConfig } from "@cisme/config";
import { TEST_DATABASE_URL, resetDatabase, testPool } from "@cisme/testkit";
import { createApp } from "../../services/api/src/server";
import { createApiGatewayStorage } from "../../services/api/src/storage";

const pool=testPool();
const base={APP_ENV:"test",DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:"ugc-editor-session",ADMIN_API_TOKEN:"ugc-editor-admin",
  UPLOAD_TOKEN_SECRET:"ugc-editor-upload",OBJECT_STORAGE_DRIVER:"api_gateway"};
const closedConfig=loadConfig(base);
const openConfig=loadConfig({...base,UGC_GO_LIVE_GATE:"true",UGC_LEGAL_APPROVAL_ID:"synthetic-test-approval",
  UGC_PROVENANCE_READY:"true",UGC_CONTENT_SAFETY_READY:"true",UGC_MODERATION_READY:"true"});
let app:FastifyInstance,openApp:FastifyInstance;
let owner:{memberId:string;sessionToken:string},other:{memberId:string;sessionToken:string},reviewer:{memberId:string;sessionToken:string},publisher:{memberId:string;sessionToken:string};
const auth=(actor:{sessionToken:string})=>({authorization:`Bearer ${actor.sessionToken}`});
const identity=async(name:string)=>{
  const response=await app.inject({method:"POST",url:"/v1/identity/dev",payload:{externalUserId:name,displayName:name,
    consents:[{documentType:"privacy",version:"test"},{documentType:"terms",version:"test"}]}});
  expect(response.statusCode).toBe(200);return response.json();
};
beforeAll(async()=>{
  await resetDatabase(pool);
  const storage=createApiGatewayStorage(closedConfig);await storage.ensureReady();
  app=await createApp({config:closedConfig,pool,storage});
  owner=await identity("ugc-editor-owner");other=await identity("ugc-editor-other");
  reviewer=await identity("ugc-editor-reviewer");publisher=await identity("ugc-editor-publisher");
  for(const actor of [reviewer,publisher])await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'community.moderate','fixture','UGC isolated integration','test','integration_fixture')`,[actor.memberId]);
});
afterAll(async()=>{await openApp?.close();await app?.close();await pool.end();});

it("keeps image-only drafts private, reuses owned media across revisions, and publishes only after independent review",async()=>{
  const headers={...auth(owner),"idempotency-key":"ugc-editor-create-0001"};
  const created=await app.inject({method:"POST",url:"/v1/me/ugc/posts",headers,payload:{}});
  expect(created.statusCode).toBe(200);
  const draft=created.json();expect(draft).toMatchObject({state:"draft",version:1,body:""});
  const replay=await app.inject({method:"POST",url:"/v1/me/ugc/posts",headers,payload:{}});
  expect(replay.json()).toEqual(draft);
  const crossRead=await app.inject({method:"GET",url:`/v1/me/ugc/posts/${draft.id}`,headers:auth(other)});
  expect(crossRead.statusCode,JSON.stringify(crossRead.json())).toBe(404);

  const authorization=await app.inject({method:"POST",url:`/v1/me/ugc/posts/${draft.id}/media/authorize`,headers:auth(owner),
    payload:{mimeType:"image/png",maxBytes:100}});
  expect(authorization.statusCode).toBe(200);
  const upload=authorization.json(),bytes=await sharp({create:{width:2,height:2,channels:3,background:"#ffffff"}}).png().toBuffer();
  const chunk=await app.inject({method:"POST",url:`/v1/uploads/${upload.mediaId}/chunks`,payload:{token:upload.fields.token,index:0,totalBytes:bytes.length,base64:bytes.toString("base64")}});
  expect(chunk.statusCode).toBe(200);
  const assembled=await app.inject({method:"POST",url:`/v1/uploads/${upload.mediaId}/assemble`,payload:{token:upload.fields.token}});
  expect(assembled.statusCode,JSON.stringify(assembled.json())).toBe(200);
  const completed=await app.inject({method:"POST",url:`/v1/me/ugc/posts/${draft.id}/media/${upload.mediaId}/complete`,headers:auth(owner),payload:{}});
  expect(completed.statusCode).toBe(200);
  expect((await app.inject({method:"GET",url:`/v1/me/ugc/media/${upload.mediaId}`,headers:auth(other)})).statusCode).toBe(404);

  const imageOnly={title:"",body:"",mediaIds:[upload.mediaId],aiUsage:"none",rightsConfirmed:true,publicConsentConfirmed:true};
  const saved=await app.inject({method:"PUT",url:`/v1/me/ugc/posts/${draft.id}/draft`,headers:auth(owner),payload:{...imageOnly,expectedVersion:1}});
  expect(saved.statusCode).toBe(200);expect(saved.json()).toMatchObject({version:2,revision:2,body:""});
  expect((await app.inject({method:"GET",url:`/v1/me/ugc/media/${upload.mediaId}/preview-url`,headers:auth(other)})).statusCode).toBe(404);
  const ownPreview=await app.inject({method:"GET",url:`/v1/me/ugc/media/${upload.mediaId}/preview-url`,headers:auth(owner)});
  expect(ownPreview.statusCode).toBe(200);
  const ownPreviewPath=new URL(ownPreview.json().url).pathname+new URL(ownPreview.json().url).search;
  const previewImage=await app.inject({method:"GET",url:ownPreviewPath});
  expect(previewImage.statusCode).toBe(200);expect(previewImage.rawPayload.equals(bytes)).toBe(true);
  expect((await app.inject({method:"GET",url:ownPreviewPath.replace(upload.mediaId,other.memberId)})).statusCode).not.toBe(200);
  const resaved=await app.inject({method:"PUT",url:`/v1/me/ugc/posts/${draft.id}/draft`,headers:auth(owner),payload:{...imageOnly,expectedVersion:2}});
  expect(resaved.statusCode).toBe(200);expect(resaved.json()).toMatchObject({version:3,revision:3});
  expect((await app.inject({method:"DELETE",url:`/v1/me/ugc/media/${upload.mediaId}`,headers:auth(owner)})).statusCode).toBe(409);
  expect((await app.inject({method:"POST",url:`/v1/me/ugc/posts/${draft.id}/submit`,headers:auth(owner),payload:{expectedVersion:3}})).statusCode).toBe(503);
  expect((await app.inject({method:"GET",url:"/v1/ugc/posts"})).json()).toMatchObject({publicEnabled:false,items:[]});

  await pool.query(`UPDATE ugc_media_asset SET scan_result=$2::jsonb WHERE id=$1`,[upload.mediaId,
    JSON.stringify({verdict:"safe",provider:"test_fixture",checkedAt:new Date().toISOString()})]);
  await pool.query(`INSERT INTO ugc_go_live_approval(approval_reference,signed_by,evidence,signed_at,expires_at)
    VALUES('synthetic-test-approval-20260912','isolated test fixture',$1,now(),now()+interval '1 hour')`,[{scope:"isolated integration only"}]);
  await pool.query("UPDATE emergency_switch SET enabled=true WHERE key='community'");
  openApp=await createApp({config:openConfig,pool,storage:createApiGatewayStorage(openConfig)});
  const submitted=await openApp.inject({method:"POST",url:`/v1/me/ugc/posts/${draft.id}/submit`,headers:auth(owner),payload:{expectedVersion:3}});
  expect(submitted.statusCode).toBe(200);
  const mediaReview=await openApp.inject({method:"POST",url:`/v1/management/ugc/media/${upload.mediaId}/review`,headers:auth(reviewer),
    payload:{decision:"approve",reason:"合成图片已通过测试扫描",ruleVersion:"UGC-R1"}});
  expect(mediaReview.statusCode).toBe(200);
  expect((await openApp.inject({method:"POST",url:`/v1/management/ugc/posts/${draft.id}/review`,headers:auth(owner),
    payload:{decision:"approve",reason:"自行审核不允许",ruleVersion:"UGC-R1",expectedVersion:4}})).statusCode).toBe(403);
  const reviewed=await openApp.inject({method:"POST",url:`/v1/management/ugc/posts/${draft.id}/review`,headers:auth(reviewer),
    payload:{decision:"approve",reason:"内容与公开许可已核对",ruleVersion:"UGC-R1",expectedVersion:4}});
  expect(reviewed.statusCode).toBe(200);
  expect((await openApp.inject({method:"POST",url:`/v1/management/ugc/posts/${draft.id}/publish`,headers:auth(reviewer),payload:{expectedVersion:5}})).statusCode).toBe(403);
  const published=await openApp.inject({method:"POST",url:`/v1/management/ugc/posts/${draft.id}/publish`,headers:auth(publisher),payload:{expectedVersion:5}});
  expect(published.statusCode).toBe(200);
  const publicPost=await openApp.inject({method:"GET",url:`/v1/ugc/posts/${draft.id}`});
  expect(publicPost.statusCode).toBe(200);expect(publicPost.json().media).toHaveLength(1);
  const publicImage=await openApp.inject({method:"GET",url:`/v1/ugc/media/${upload.mediaId}`});
  expect(publicImage.statusCode).toBe(200);expect(publicImage.headers["content-type"]).toContain("image/webp");
  expect(publicImage.rawPayload.subarray(0,4).toString()).toBe("RIFF");
  const thumb=await openApp.inject({method:"GET",url:`/v1/ugc/media/${upload.mediaId}?variant=thumbnail`});
  expect(thumb.statusCode).toBe(200);expect(thumb.headers["content-type"]).toContain("image/webp");
  expect((await openApp.inject({method:"GET",url:"/v1/ugc/posts"})).json()).toMatchObject({publicEnabled:true,total:1});
  const client=await pool.connect();let secondId="";
  try{
    await client.query("BEGIN");
    secondId=(await client.query("INSERT INTO ugc_post(author_member_id,client_request_key) VALUES($1,'ugc-editor-second-post') RETURNING id",[owner.memberId])).rows[0].id;
    await client.query(`INSERT INTO ugc_post_revision(post_id,revision,created_by_member_id,title,body,moderation_state,rights_confirmed,public_consent_confirmed)
      VALUES($1,1,$2,'搜索词护理笔记','另一段真实感受','approved',true,true)`,[secondId,owner.memberId]);
    await client.query("UPDATE ugc_post SET state='published',visibility='public',published_revision=1,published_at=now()+interval '1 second' WHERE id=$1",[secondId]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  const firstPage=(await openApp.inject({method:"GET",url:"/v1/ugc/posts?limit=1"})).json();
  expect(firstPage.items.map((item:{id:string})=>item.id)).toEqual([secondId]);
  expect(firstPage.nextCursor).toBeTruthy();
  const nextPage=(await openApp.inject({method:"GET",url:`/v1/ugc/posts?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`})).json();
  expect(nextPage.items.map((item:{id:string})=>item.id)).toEqual([draft.id]);
  expect(nextPage.nextCursor).toBeNull();
  expect((await openApp.inject({method:"GET",url:"/v1/ugc/posts?q=%E6%90%9C%E7%B4%A2%E8%AF%8D"})).json().items.map((item:{id:string})=>item.id)).toEqual([secondId]);
  expect((await openApp.inject({method:"GET",url:"/v1/ugc/posts?cursor=not-a-cursor"})).statusCode).toBe(422);

  const liked=await openApp.inject({method:"PUT",url:`/v1/ugc/posts/${draft.id}/reaction`,headers:auth(other),payload:{kind:"like",active:true}});
  expect(liked.json()).toMatchObject({count:1,active:true});
  const comment=await openApp.inject({method:"POST",url:`/v1/ugc/posts/${draft.id}/comments`,headers:{...auth(other),"idempotency-key":"ugc-comment-0001"},payload:{body:"我的使用感受"}});
  expect(comment.statusCode).toBe(200);expect(comment.json().state).toBe("pending_review");
  expect((await openApp.inject({method:"POST",url:`/v1/ugc/posts/${draft.id}/comments`,
    headers:{...auth(other),"idempotency-key":"ugc-comment-0001"},payload:{body:"另一条评论"}})).statusCode).toBe(409);
  expect((await openApp.inject({method:"GET",url:`/v1/ugc/posts/${draft.id}`})).json().comments).toHaveLength(0);
  const commentReview=await openApp.inject({method:"POST",url:`/v1/management/ugc/comments/${comment.json().id}/review`,headers:auth(reviewer),payload:{decision:"approve",reason:"正常护理交流"}});
  expect(commentReview.statusCode).toBe(200);
  expect((await openApp.inject({method:"GET",url:`/v1/ugc/posts/${draft.id}`})).json().comments).toHaveLength(1);
  expect((await openApp.inject({method:"PUT",url:`/v1/me/ugc/blocks/${owner.memberId}`,headers:auth(other),payload:{active:true}})).statusCode).toBe(200);
  expect((await openApp.inject({method:"GET",url:"/v1/ugc/posts",headers:auth(other)})).json().items).toHaveLength(0);
  const edited=await openApp.inject({method:"PUT",url:`/v1/me/ugc/posts/${draft.id}/draft`,headers:auth(owner),
    payload:{...imageOnly,title:"未审核标题",body:"新版尚未审核",expectedVersion:6}});
  expect(edited.statusCode).toBe(200);expect(edited.json()).toMatchObject({state:"draft",version:7,publicVersionActive:true,publishedRevision:3});
  const stillPublic=(await openApp.inject({method:"GET",url:`/v1/ugc/posts/${draft.id}`})).json();
  expect(stillPublic.body).toBe("");expect(stillPublic.media).toHaveLength(1);
  expect((await openApp.inject({method:"GET",url:`/v1/management/ugc/posts/${draft.id}`,headers:auth(reviewer)})).statusCode).toBe(404);
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'member.profile.read','fixture','UGC private revision projection','test','integration_fixture')`,[reviewer.memberId]);
  const managementProfile=(await openApp.inject({method:"GET",url:`/v1/management/members/${owner.memberId}`,headers:auth(reviewer)})).json();
  expect(managementProfile.publicPosts).toEqual(expect.arrayContaining([expect.objectContaining({id:draft.id,title:null})]));
  expect(JSON.stringify(managementProfile.publicPosts)).not.toContain("未审核标题");
  expect((await openApp.inject({method:"GET",url:`/v1/ugc/media/${upload.mediaId}`})).statusCode).toBe(200);
  const hidden=await openApp.inject({method:"POST",url:`/v1/management/ugc/posts/${draft.id}/hide`,headers:auth(reviewer),payload:{expectedVersion:7,reason:"合成下架测试"}});
  expect(hidden.statusCode).toBe(200);
  expect((await openApp.inject({method:"GET",url:`/v1/ugc/media/${upload.mediaId}`})).statusCode).toBe(404);
});
