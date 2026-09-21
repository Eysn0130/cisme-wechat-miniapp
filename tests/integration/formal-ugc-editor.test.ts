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
  const unsavedPreview=await app.inject({method:"GET",url:`/v1/me/ugc/posts/${draft.id}/media/${upload.mediaId}/preview-url`,headers:auth(owner)});
  expect(unsavedPreview.statusCode).toBe(200);
  const unsavedPath=new URL(unsavedPreview.json().url).pathname+new URL(unsavedPreview.json().url).search;
  expect((await app.inject({method:"GET",url:unsavedPath})).statusCode).toBe(200);
  expect((await app.inject({method:"GET",url:`/v1/me/ugc/posts/${draft.id}/media/${upload.mediaId}/preview-url`,headers:auth(other)})).statusCode).toBe(404);
  expect((await app.inject({method:"GET",url:`/v1/me/ugc/posts/${other.memberId}/media/${upload.mediaId}/preview-url`,headers:auth(owner)})).statusCode).toBe(404);

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
  const reviewPreview=await openApp.inject({method:"GET",url:`/v1/management/ugc/media/${upload.mediaId}/preview-url`,headers:auth(reviewer)});
  expect(reviewPreview.statusCode).toBe(200);
  const reviewPreviewPath=new URL(reviewPreview.json().url).pathname+new URL(reviewPreview.json().url).search;
  expect((await openApp.inject({method:"GET",url:reviewPreviewPath})).statusCode).toBe(200);
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
  expect((await openApp.inject({method:"GET",url:reviewPreviewPath})).statusCode).toBe(404);
  const publicPost=await openApp.inject({method:"GET",url:`/v1/ugc/posts/${draft.id}`});
  expect(publicPost.statusCode).toBe(200);expect(publicPost.json().media).toHaveLength(1);
  const privateOnly=await openApp.inject({method:"POST",url:"/v1/me/ugc/posts",
    headers:{...auth(owner),"idempotency-key":"ugc-editor-private-report-0001"},payload:{}});
  expect(privateOnly.statusCode).toBe(200);
  expect((await openApp.inject({method:"POST",url:`/v1/ugc/reports/post/${privateOnly.json().id}`,
    headers:auth(other),payload:{category:"other",description:"不应举报未提交草稿"}})).statusCode).toBe(404);
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
  const authorProfile=await openApp.inject({method:"GET",url:`/v1/ugc/authors/${owner.memberId}`});
  expect(authorProfile.statusCode).toBe(200);
  expect(authorProfile.json()).toMatchObject({id:owner.memberId,postCount:2,following:false,isMine:false});
  expect(JSON.stringify(authorProfile.json())).not.toMatch(/phone|openid|contact|reviewNote/i);

  expect((await openApp.inject({method:"GET",url:"/v1/ugc/posts?following=1"})).statusCode).toBe(401);
  expect((await openApp.inject({method:"GET",url:"/v1/ugc/posts?following=1",headers:auth(other)})).json().items).toHaveLength(0);
  const follow=await openApp.inject({method:"PUT",url:`/v1/me/ugc/follows/${owner.memberId}`,
    headers:auth(other),payload:{active:true}});
  expect(follow.statusCode).toBe(200);expect(follow.json().following).toBe(true);
  expect((await openApp.inject({method:"PUT",url:`/v1/me/ugc/follows/${owner.memberId}`,
    headers:auth(other),payload:{active:true}})).statusCode).toBe(200);
  expect((await openApp.inject({method:"PUT",url:`/v1/me/ugc/follows/${owner.memberId}`,
    headers:auth(owner),payload:{active:true}})).statusCode).toBe(422);
  expect((await openApp.inject({method:"GET",url:"/v1/ugc/posts?following=1",headers:auth(other)})).json().items)
    .toHaveLength(2);
  expect((await openApp.inject({method:"GET",url:`/v1/ugc/posts/${draft.id}`,headers:auth(other)})).json().following).toBe(true);
  expect((await openApp.inject({method:"GET",url:`/v1/ugc/authors/${owner.memberId}`,headers:auth(other)})).json().following).toBe(true);

  const liked=await openApp.inject({method:"PUT",url:`/v1/ugc/posts/${draft.id}/reaction`,headers:auth(other),payload:{kind:"like",active:true}});
  expect(liked.json()).toMatchObject({count:1,active:true});
  const comment=await openApp.inject({method:"POST",url:`/v1/ugc/posts/${draft.id}/comments`,headers:{...auth(other),"idempotency-key":"ugc-comment-0001"},payload:{body:"我的使用感受"}});
  expect(comment.statusCode).toBe(200);expect(comment.json().state).toBe("pending_review");
  const ownPending=await openApp.inject({method:"GET",url:`/v1/me/ugc/activity/comments?postId=${draft.id}`,headers:auth(other)});
  expect(ownPending.statusCode).toBe(200);
  expect(ownPending.json()).toMatchObject({matchingTotal:1,items:[{id:comment.json().id,state:"pending_review",body:"我的使用感受"}]});
  expect((await openApp.inject({method:"GET",url:`/v1/me/ugc/activity/comments?postId=${draft.id}`,headers:auth(owner)})).json().items).toHaveLength(0);
  expect((await openApp.inject({method:"POST",url:`/v1/ugc/posts/${draft.id}/comments`,
    headers:{...auth(other),"idempotency-key":"ugc-comment-0001"},payload:{body:"另一条评论"}})).statusCode).toBe(409);
  expect((await openApp.inject({method:"GET",url:`/v1/ugc/posts/${draft.id}`})).json().comments).toHaveLength(0);
  const commentReview=await openApp.inject({method:"POST",url:`/v1/management/ugc/comments/${comment.json().id}/review`,headers:auth(reviewer),payload:{decision:"approve",reason:"正常护理交流"}});
  expect(commentReview.statusCode).toBe(200);
  expect((await openApp.inject({method:"GET",url:`/v1/me/ugc/activity/comments?postId=${draft.id}`,headers:auth(other)})).json().items[0].state).toBe("published");
  expect((await openApp.inject({method:"GET",url:`/v1/ugc/posts/${draft.id}`})).json().comments).toHaveLength(1);
  expect((await openApp.inject({method:"PUT",url:`/v1/ugc/posts/${draft.id}/reaction`,headers:auth(other),payload:{kind:"save",active:true}})).statusCode).toBe(200);
  expect((await openApp.inject({method:"GET",url:"/v1/me/ugc/activity/saves",headers:auth(other)})).json())
    .toMatchObject({matchingTotal:1,items:[{postId:draft.id,available:true}]});
  const report=await openApp.inject({method:"POST",url:`/v1/ugc/reports/post/${draft.id}`,
    headers:auth(other),payload:{category:"other",description:"合成测试举报"}});
  expect(report.statusCode).toBe(200);
  const queue=await openApp.inject({method:"GET",url:"/v1/management/ugc/reports",headers:auth(reviewer)});
  expect(queue.statusCode).toBe(200);
  expect(queue.json().items).toContainEqual(expect.objectContaining({id:report.json().id,version:1,targetType:"post",reportedRevision:3}));
  expect((await openApp.inject({method:"GET",url:"/v1/management/ugc/reports",headers:auth(owner)})).statusCode).toBe(403);
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'community.moderate','fixture','Conflicted report reviewer','test','integration_fixture')`,[owner.memberId]);
  const conflictedQueue=(await openApp.inject({method:"GET",url:"/v1/management/ugc/reports",headers:auth(owner)})).json();
  expect(conflictedQueue.items.find((item:{id:string})=>item.id===report.json().id)).toBeUndefined();
  const conflictedDecision=await openApp.inject({method:"POST",url:`/v1/management/ugc/reports/${report.json().id}/decision`,
    headers:auth(owner),payload:{decision:"dismiss",reason:"不能驳回针对本人内容的举报",expectedVersion:1}});
  expect(conflictedDecision.statusCode).toBe(403);
  await pool.query(`UPDATE authority_grant SET revoked_at=now(),revoked_by='fixture',revoke_reason='Conflict check complete'
    WHERE member_id=$1 AND capability='community.moderate'`,[owner.memberId]);
  expect((await openApp.inject({method:"POST",url:`/v1/management/ugc/reports/${report.json().id}/decision`,
    headers:auth(other),payload:{decision:"dismiss",reason:"本人不能决定举报",expectedVersion:1}})).statusCode).toBe(403);
  const decision=await openApp.inject({method:"POST",url:`/v1/management/ugc/reports/${report.json().id}/decision`,
    headers:auth(reviewer),payload:{decision:"dismiss",reason:"合成内容经核对无违规",expectedVersion:1}});
  expect(decision.statusCode,JSON.stringify(decision.json())).toBe(200);
  expect(decision.json()).toMatchObject({state:"rejected",decisionCode:"dismiss",version:2});
  expect((await openApp.inject({method:"GET",url:"/v1/me/ugc/activity/reports",headers:auth(other)})).json())
    .toMatchObject({matchingTotal:1,items:[{id:report.json().id,state:"rejected",decisionCode:"dismiss"}]});
  expect((await openApp.inject({method:"POST",url:`/v1/management/ugc/reports/${report.json().id}/decision`,
    headers:auth(reviewer),payload:{decision:"dismiss",reason:"再次处理应拒绝",expectedVersion:1}})).statusCode).toBe(409);
  const commentReport=await openApp.inject({method:"POST",url:`/v1/ugc/reports/comment/${comment.json().id}`,
    headers:auth(owner),payload:{category:"harassment",description:"合成评论处理测试"}});
  expect(commentReport.statusCode).toBe(200);
  const commentQueue=(await openApp.inject({method:"GET",url:"/v1/management/ugc/reports",headers:auth(reviewer)})).json();
  const commentItem=commentQueue.items.find((item:{id:string})=>item.id===commentReport.json().id);
  expect(commentItem).toMatchObject({targetType:"comment",postId:draft.id,targetVersion:2});
  expect((await openApp.inject({method:"POST",url:`/v1/management/ugc/reports/${commentReport.json().id}/decision`,
    headers:auth(reviewer),payload:{decision:"remove_comment",reason:"版本过期应拒绝",expectedVersion:1,expectedTargetVersion:1}})).statusCode).toBe(409);
  const commentRemoved=await openApp.inject({method:"POST",url:`/v1/management/ugc/reports/${commentReport.json().id}/decision`,
    headers:auth(reviewer),payload:{decision:"remove_comment",reason:"经核实这条评论需要移除",expectedVersion:1,expectedTargetVersion:2}});
  expect(commentRemoved.statusCode,JSON.stringify(commentRemoved.json())).toBe(200);
  expect((await openApp.inject({method:"GET",url:`/v1/ugc/posts/${draft.id}`})).json().comments).toHaveLength(0);
  expect((await openApp.inject({method:"GET",url:`/v1/me/ugc/activity/comments?postId=${draft.id}`,headers:auth(other)})).json().items[0])
    .toMatchObject({state:"deleted",body:null});
  expect((await openApp.inject({method:"PUT",url:`/v1/me/ugc/blocks/${owner.memberId}`,headers:auth(other),payload:{active:true}})).statusCode).toBe(200);
  expect((await openApp.inject({method:"GET",url:"/v1/me/ugc/activity/blocks",headers:auth(other)})).json())
    .toMatchObject({matchingTotal:1,items:[{memberId:owner.memberId}]});
  expect((await openApp.inject({method:"GET",url:"/v1/ugc/posts",headers:auth(other)})).json().items).toHaveLength(0);
  expect((await openApp.inject({method:"GET",url:"/v1/ugc/posts?following=1",headers:auth(other)})).json().items).toHaveLength(0);
  expect((await openApp.inject({method:"GET",url:`/v1/ugc/authors/${owner.memberId}`,headers:auth(other)})).statusCode).toBe(404);
  expect((await openApp.inject({method:"PUT",url:`/v1/ugc/posts/${draft.id}/reaction`,headers:auth(other),
    payload:{kind:"like",active:true}})).statusCode).toBe(404);
  expect((await openApp.inject({method:"POST",url:`/v1/ugc/posts/${draft.id}/comments`,
    headers:{...auth(other),"idempotency-key":"ugc-blocked-comment-0001"},payload:{body:"屏蔽后不应互动"}})).statusCode).toBe(404);
  expect((await pool.query("SELECT count(*)::int AS n FROM ugc_author_follow WHERE follower_member_id=$1",[other.memberId])).rows[0].n).toBe(0);
  const edited=await openApp.inject({method:"PUT",url:`/v1/me/ugc/posts/${draft.id}/draft`,headers:auth(owner),
    payload:{...imageOnly,title:"未审核标题",body:"新版尚未审核",expectedVersion:6}});
  expect(edited.statusCode).toBe(200);expect(edited.json()).toMatchObject({state:"draft",version:7,publicVersionActive:true,publishedRevision:3});
  const privateAuthorization=await openApp.inject({method:"POST",url:`/v1/me/ugc/posts/${draft.id}/media/authorize`,headers:auth(owner),
    payload:{mimeType:"image/png",maxBytes:100}});
  expect(privateAuthorization.statusCode).toBe(200);
  const privateUpload=privateAuthorization.json();
  expect((await openApp.inject({method:"POST",url:`/v1/uploads/${privateUpload.mediaId}/chunks`,payload:{token:privateUpload.fields.token,index:0,
    totalBytes:bytes.length,base64:bytes.toString("base64")}})).statusCode).toBe(200);
  expect((await openApp.inject({method:"POST",url:`/v1/uploads/${privateUpload.mediaId}/assemble`,payload:{token:privateUpload.fields.token}})).statusCode).toBe(200);
  expect((await openApp.inject({method:"POST",url:`/v1/me/ugc/posts/${draft.id}/media/${privateUpload.mediaId}/complete`,headers:auth(owner),payload:{}})).statusCode).toBe(200);
  const privateDraft=await openApp.inject({method:"PUT",url:`/v1/me/ugc/posts/${draft.id}/draft`,headers:auth(owner),
    payload:{...imageOnly,mediaIds:[upload.mediaId,privateUpload.mediaId],title:"未提交私人版本",expectedVersion:7}});
  expect(privateDraft.statusCode).toBe(200);
  expect((await openApp.inject({method:"GET",url:`/v1/management/ugc/posts/${draft.id}`,headers:auth(reviewer)})).statusCode).toBe(404);
  expect((await openApp.inject({method:"GET",url:`/v1/management/ugc/media/${privateUpload.mediaId}/preview-url`,headers:auth(reviewer)})).statusCode).toBe(404);
  const privateSubmitted=await openApp.inject({method:"POST",url:`/v1/me/ugc/posts/${draft.id}/submit`,headers:auth(owner),payload:{expectedVersion:8}});
  expect(privateSubmitted.statusCode).toBe(200);
  const privatePreview=await openApp.inject({method:"GET",url:`/v1/management/ugc/media/${privateUpload.mediaId}/preview-url`,headers:auth(reviewer)});
  expect(privatePreview.statusCode).toBe(200);
  const privatePreviewPath=new URL(privatePreview.json().url).pathname+new URL(privatePreview.json().url).search;
  expect((await openApp.inject({method:"GET",url:privatePreviewPath})).statusCode).toBe(200);
  expect((await openApp.inject({method:"GET",url:privatePreviewPath.replace(privateUpload.mediaId,upload.mediaId)})).statusCode).toBe(403);
  const publisherPreview=await openApp.inject({method:"GET",url:`/v1/management/ugc/media/${privateUpload.mediaId}/preview-url`,headers:auth(publisher)});
  expect(publisherPreview.statusCode).toBe(200);
  const publisherPreviewPath=new URL(publisherPreview.json().url).pathname+new URL(publisherPreview.json().url).search;
  await pool.query(`UPDATE authority_grant SET revoked_at=now(),revoked_by='fixture',revoke_reason='Synthetic permission revocation'
    WHERE member_id=$1 AND capability='community.moderate'`,[publisher.memberId]);
  expect((await openApp.inject({method:"GET",url:publisherPreviewPath})).statusCode).toBe(403);
  expect((await openApp.inject({method:"GET",url:privatePreviewPath})).statusCode).toBe(200);
  const rejectedPrivate=await openApp.inject({method:"POST",url:`/v1/management/ugc/posts/${draft.id}/review`,headers:auth(reviewer),
    payload:{decision:"reject",reason:"私人修订退回作者修改",ruleVersion:"UGC-R1",expectedVersion:9}});
  expect(rejectedPrivate.statusCode).toBe(200);
  expect((await openApp.inject({method:"GET",url:privatePreviewPath})).statusCode).toBe(404);
  const stillPublic=(await openApp.inject({method:"GET",url:`/v1/ugc/posts/${draft.id}`})).json();
  expect(stillPublic.body).toBe("");expect(stillPublic.media).toHaveLength(1);
  expect((await openApp.inject({method:"GET",url:`/v1/management/ugc/posts/${draft.id}`,headers:auth(reviewer)})).statusCode).toBe(404);
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'member.profile.read','fixture','UGC private revision projection','test','integration_fixture')`,[reviewer.memberId]);
  const managementProfile=(await openApp.inject({method:"GET",url:`/v1/management/members/${owner.memberId}`,headers:auth(reviewer)})).json();
  expect(managementProfile.member.id).toBe(owner.memberId);
  const publicSection=(await openApp.inject({method:"GET",url:`/v1/management/members/${owner.memberId}/sections/posts`,headers:auth(reviewer)})).json();
  expect(publicSection.items).toEqual(expect.arrayContaining([expect.objectContaining({id:draft.id,title:"图片护理故事"})]));
  expect(JSON.stringify(publicSection)).not.toContain("未审核标题");
  expect((await openApp.inject({method:"GET",url:`/v1/ugc/media/${upload.mediaId}`})).statusCode).toBe(200);
  const hideReport=await openApp.inject({method:"POST",url:`/v1/ugc/reports/post/${draft.id}`,
    headers:auth(publisher),payload:{category:"unsafe_advice",description:"合成帖子下架测试"}});
  expect(hideReport.statusCode).toBe(200);
  const hideQueue=(await openApp.inject({method:"GET",url:"/v1/management/ugc/reports",headers:auth(reviewer)})).json();
  const hideItem=hideQueue.items.find((item:{id:string})=>item.id===hideReport.json().id);
  expect(hideItem).toMatchObject({targetVersion:10});
  const hidden=await openApp.inject({method:"POST",url:`/v1/management/ugc/reports/${hideReport.json().id}/decision`,
    headers:auth(reviewer),payload:{decision:"hide_post",reason:"核实后下架合成测试帖子",expectedVersion:1,expectedTargetVersion:10}});
  expect(hidden.statusCode).toBe(200);
  expect((await openApp.inject({method:"GET",url:`/v1/ugc/media/${upload.mediaId}`})).statusCode).toBe(404);
  const hiddenOwn=(await openApp.inject({method:"GET",url:`/v1/me/ugc/posts/${draft.id}`,headers:auth(owner)})).json();
  expect(hiddenOwn).toMatchObject({state:"hidden",version:11,hiddenReason:"核实后下架合成测试帖子"});
  expect(hiddenOwn.hiddenPublished.body).toBe("");
  expect((await openApp.inject({method:"GET",url:"/v1/me/ugc/posts",headers:auth(owner)})).json().items)
    .toContainEqual(expect.objectContaining({id:draft.id,state:"hidden"}));
  expect((await openApp.inject({method:"POST",url:`/v1/me/ugc/posts/${draft.id}/appeals`,headers:auth(other),
    payload:{reason:"他人不能代为申诉",expectedVersion:11}})).statusCode).toBe(404);
  const appeal=await openApp.inject({method:"POST",url:`/v1/me/ugc/posts/${draft.id}/appeals`,headers:auth(owner),
    payload:{reason:"请复核这次下架所依据的内容",expectedVersion:11}});
  expect(appeal.statusCode,JSON.stringify(appeal.json())).toBe(200);
  expect(appeal.json()).toMatchObject({state:"received",alreadyCreated:false});
  expect((await openApp.inject({method:"POST",url:`/v1/me/ugc/posts/${draft.id}/appeals`,headers:auth(owner),
    payload:{reason:"请复核这次下架所依据的内容",expectedVersion:11}})).json().alreadyCreated).toBe(true);
  expect((await openApp.inject({method:"GET",url:"/v1/me/ugc/activity/appeals",headers:auth(owner)})).json())
    .toMatchObject({matchingTotal:1,items:[{id:appeal.json().id,state:"received"}]});
  const appealQueue=(await openApp.inject({method:"GET",url:"/v1/management/ugc/appeals",headers:auth(reviewer)})).json();
  const appealRow=appealQueue.items.find((item:{id:string})=>item.id===appeal.json().id);
  expect(appealRow).toBeUndefined(); // The original hide reviewer cannot inspect this appeal or its reporter.
  expect((await openApp.inject({method:"POST",url:`/v1/management/ugc/appeals/${appeal.json().id}/decision`,
    headers:auth(reviewer),payload:{decision:"restore",reason:"本人下架不能复核",expectedVersion:1}})).statusCode).toBe(403);
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'community.moderate','fixture','Appeal reporter conflict test','test','integration_fixture')`,[publisher.memberId]);
  expect((await openApp.inject({method:"POST",url:`/v1/management/ugc/appeals/${appeal.json().id}/decision`,
    headers:auth(publisher),payload:{decision:"restore",reason:"举报人不能独立复核",expectedVersion:1}})).statusCode).toBe(403);
  await pool.query(`INSERT INTO authority_grant(member_id,capability,granted_by,grant_reason,environment,grant_source)
    VALUES($1,'community.moderate','fixture','Independent appeal review','test','integration_fixture')`,[other.memberId]);
  const independentQueue=(await openApp.inject({method:"GET",url:"/v1/management/ugc/appeals",headers:auth(other)})).json();
  const independentRow=independentQueue.items.find((item:{id:string})=>item.id===appeal.json().id);
  expect(independentRow).toMatchObject({postVersion:11,publishedRevision:3,hiddenByMemberId:reviewer.memberId,
    hideReporterMemberId:publisher.memberId});
  expect(JSON.stringify(independentRow)).not.toContain("未提交私人版本");
  const restored=await openApp.inject({method:"POST",url:`/v1/management/ugc/appeals/${appeal.json().id}/decision`,
    headers:auth(other),payload:{decision:"restore",reason:"复核原公开内容可继续展示",expectedVersion:1}});
  expect(restored.statusCode,JSON.stringify(restored.json())).toBe(200);
  expect(restored.json()).toMatchObject({state:"resolved",decisionCode:"restore",version:2});
  expect((await openApp.inject({method:"GET",url:`/v1/ugc/posts/${draft.id}`})).json().body).toBe("");
  expect((await openApp.inject({method:"GET",url:"/v1/me/ugc/activity/appeals",headers:auth(owner)})).json().items[0])
    .toMatchObject({state:"resolved",decisionCode:"restore"});
  expect((await openApp.inject({method:"POST",url:`/v1/management/ugc/appeals/${appeal.json().id}/decision`,
    headers:auth(other),payload:{decision:"restore",reason:"不能重复恢复内容",expectedVersion:1}})).statusCode).toBe(409);
  expect((await openApp.inject({method:"GET",url:"/v1/me/ugc/activity/saves",headers:auth(other)})).json().items[0])
    .toMatchObject({postId:draft.id,available:false,title:null});
  expect((await openApp.inject({method:"PUT",url:`/v1/ugc/posts/${draft.id}/reaction`,headers:auth(other),
    payload:{kind:"save",active:false}})).statusCode).toBe(200);
  expect((await openApp.inject({method:"GET",url:"/v1/me/ugc/activity/saves",headers:auth(other)})).json().matchingTotal).toBe(0);
});

it("pages 101 public comments without treating the first page as the whole thread",async()=>{
  const postId=(await pool.query("SELECT post_id FROM ugc_post_revision WHERE title='搜索词护理笔记'")).rows[0]?.post_id;
  expect(postId).toBeTruthy();
  await pool.query(`INSERT INTO ugc_comment(post_id,author_member_id,body,state,was_public,operation_id,created_at)
    SELECT $1,$2,'分页评论 '||n,'published',true,'paged-public-comment-'||lpad(n::text,3,'0'),
      now()+n*interval '1 microsecond' FROM generate_series(1,101) n`,[postId,reviewer.memberId]);
  const initial=await openApp.inject({method:"GET",url:`/v1/ugc/posts/${postId}`});
  expect(initial.statusCode).toBe(200);
  const body=initial.json();expect(body.commentsTotal).toBe(101);expect(body.comments).toHaveLength(30);
  let cursor=body.commentsNextCursor,all=[...body.comments];
  while(cursor){
    const response=await openApp.inject({method:"GET",url:`/v1/ugc/posts/${postId}/comments?limit=30&cursor=${encodeURIComponent(cursor)}`});
    expect(response.statusCode).toBe(200);
    const page=response.json();all.push(...page.items);cursor=page.nextCursor;
    expect(page.matchingTotal).toBe(101);
  }
  expect(all).toHaveLength(101);
  expect(new Set(all.map((item:{id:string})=>item.id)).size).toBe(101);
  expect(all[0].body).toBe("分页评论 1");expect(all.at(-1).body).toBe("分页评论 101");
});
it('revokes UGC upload chunks and assembly when the author becomes inactive',async()=>{
 const actor=await identity('ugc-revoked-upload');
 const draft=(await app.inject({method:'POST',url:'/v1/me/ugc/posts',headers:{...auth(actor),'idempotency-key':'ugc-upload-revocation'},payload:{}})).json();
 const upload=(await app.inject({method:'POST',url:`/v1/me/ugc/posts/${draft.id}/media/authorize`,headers:auth(actor),payload:{mimeType:'image/jpeg',maxBytes:100}})).json();
 const input={token:upload.fields.token,index:0,totalBytes:4,base64:Buffer.from([255,216,255,0]).toString('base64')};
 expect((await app.inject({method:'POST',url:`/v1/uploads/${upload.mediaId}/chunks`,payload:input})).statusCode).toBe(200);
 await pool.query("UPDATE member SET status='blocked' WHERE id=$1",[actor.memberId]);
 expect((await app.inject({method:'POST',url:`/v1/uploads/${upload.mediaId}/chunks`,payload:input})).json().code).toBe('UPLOAD_OWNER_INACTIVE');
 expect((await app.inject({method:'POST',url:`/v1/uploads/${upload.mediaId}/assemble`,payload:{token:upload.fields.token}})).json().code).toBe('UPLOAD_OWNER_INACTIVE');
});
it('invalidates unconsumed upload grants when their source draft is deleted',async()=>{
 const actor=await identity('ugc-deleted-source-upload');
 const draft=(await app.inject({method:'POST',url:'/v1/me/ugc/posts',headers:{...auth(actor),'idempotency-key':'ugc-source-revocation'},payload:{}})).json();
 const upload=(await app.inject({method:'POST',url:`/v1/me/ugc/posts/${draft.id}/media/authorize`,headers:auth(actor),payload:{mimeType:'image/jpeg',maxBytes:100}})).json();
 const input={token:upload.fields.token,index:0,totalBytes:4,base64:Buffer.from([255,216,255,0]).toString('base64')};
 expect((await app.inject({method:'POST',url:`/v1/uploads/${upload.mediaId}/chunks`,payload:input})).statusCode).toBe(200);
 expect((await app.inject({method:'DELETE',url:`/v1/me/ugc/posts/${draft.id}`,headers:auth(actor),payload:{expectedVersion:draft.version}})).statusCode).toBe(200);
 expect((await app.inject({method:'POST',url:`/v1/uploads/${upload.mediaId}/chunks`,payload:input})).json().code).toBe('UGC_POST_LOCKED');
 expect((await app.inject({method:'POST',url:`/v1/uploads/${upload.mediaId}/assemble`,payload:{token:upload.fields.token}})).json().code).toBe('UGC_POST_LOCKED');
});
