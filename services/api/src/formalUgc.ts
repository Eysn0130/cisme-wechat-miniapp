import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import sharp from "sharp";
import type { AppConfig } from "@cisme/config";
import { DomainError } from "@cisme/domain";
import { transaction, type DbClient } from "./db.js";
import { AuthorityService } from "./authority.js";
import { communityAuthors } from "./memberProfile.js";
import { validateGatewayUpload, type ObjectStorage } from "./storage.js";

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern=/^[A-Za-z0-9._:-]{8,200}$/;
const mediaMimes=new Set(["image/jpeg","image/png","image/webp"]);
const chunkBytes=512*1024;
function member(value:string|undefined):string{if(!value)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);return value;}
function uuid(value:unknown):string{if(typeof value!=="string"||!uuidPattern.test(value))throw new DomainError("UGC_ID_INVALID","内容编号无效",422);return value;}
function key(value:unknown):string{if(typeof value!=="string"||!keyPattern.test(value))throw new DomainError("UGC_REQUEST_KEY_INVALID","提交编号无效",422);return value;}
function reason(value:unknown):string{const text=typeof value==="string"?value.trim():"";if(text.length<4||text.length>500)throw new DomainError("UGC_REVIEW_REASON_INVALID","请填写 4–500 字的处理依据",422);return text;}
function positiveVersion(value:unknown):number{if(!Number.isSafeInteger(value)||Number(value)<1)throw new DomainError("UGC_VERSION_INVALID","请刷新内容后重试",422);return Number(value);}
function cleanText(value:unknown,max:number,label:string):string|null{
  if(value==null||value==="")return null;
  if(typeof value!=="string")throw new DomainError("UGC_CONTENT_INVALID",`${label}格式无效`,422);
  const text=value.trim();if(!text)return null;
  if(Array.from(text).length>max||/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text))throw new DomainError("UGC_CONTENT_INVALID",`${label}超过长度或包含无效字符`,422);
  return text;
}
function mediaIds(value:unknown):string[]{
  if(!Array.isArray(value)||value.length>9)throw new DomainError("UGC_MEDIA_INVALID","最多选择 9 张图片",422);
  const ids=value.map(uuid);if(new Set(ids).size!==ids.length)throw new DomainError("UGC_MEDIA_INVALID","请移除重复图片",422);return ids;
}
type DraftInput={title?:unknown;body?:unknown;mediaIds?:unknown;aiUsage?:unknown;rightsConfirmed?:unknown;publicConsentConfirmed?:unknown;expectedVersion?:unknown};

export class FormalUgcService{
  constructor(private readonly pool:pg.Pool,private readonly config:AppConfig,private readonly storage:ObjectStorage,private readonly authority:AuthorityService){}

  async publicEnabled():Promise<boolean>{
    if(!this.config.ugcGoLiveGate)return false;
    const result=await this.pool.query(`SELECT 1 FROM emergency_switch s WHERE s.key='community' AND s.enabled
      AND EXISTS(SELECT 1 FROM ugc_go_live_approval a WHERE a.revoked_at IS NULL AND a.signed_at<=now() AND a.expires_at>now())`);
    return Boolean(result.rowCount);
  }
  private async requirePublicGate(client?:DbClient){
    if(!this.config.ugcGoLiveGate)throw new DomainError("UGC_GO_LIVE_GATE_CLOSED","社区公开发布尚未开放，可先保存草稿",503);
    const db=client??this.pool;
    const ready=await db.query(`SELECT 1 FROM emergency_switch s WHERE s.key='community' AND s.enabled
      AND EXISTS(SELECT 1 FROM ugc_go_live_approval a WHERE a.revoked_at IS NULL AND a.signed_at<=now() AND a.expires_at>now())`);
    if(!ready.rowCount)throw new DomainError("UGC_GO_LIVE_GATE_CLOSED","社区公开发布尚未开放，可先保存草稿",503);
  }

  async createDraft(memberId:string|undefined,requestKey:unknown){
    const owner=member(memberId),clientKey=key(requestKey);
    return transaction(this.pool,async client=>{
      const account=await client.query("SELECT 1 FROM member WHERE id=$1 AND status='active' FOR SHARE",[owner]);
      if(!account.rowCount)throw new DomainError("MEMBER_NOT_ACTIVE","账号暂不可发布",403);
      const existing=(await client.query("SELECT id FROM ugc_post WHERE author_member_id=$1 AND client_request_key=$2",[owner,clientKey])).rows[0];
      if(existing)return this.readOwnWithClient(client,owner,existing.id);
      const id=randomUUID();
      await client.query(`INSERT INTO ugc_post(id,author_member_id,client_request_key) VALUES($1,$2,$3)`,[id,owner,clientKey]);
      await client.query(`INSERT INTO ugc_post_revision(post_id,revision,created_by_member_id,title,body,ai_usage,rights_confirmed,public_consent_confirmed)
        VALUES($1,1,$2,NULL,NULL,'unknown',false,false)`,[id,owner]);
      return this.readOwnWithClient(client,owner,id);
    });
  }

  async saveDraft(memberId:string|undefined,postId:string,input:DraftInput){
    const owner=member(memberId),id=uuid(postId),expected=positiveVersion(input.expectedVersion);
    const title=cleanText(input.title,120,"标题"),body=cleanText(input.body,5000,"正文"),images=mediaIds(input.mediaIds??[]);
    const aiUsage=input.aiUsage;
    if(!["none","assisted","generated","unknown"].includes(String(aiUsage)))throw new DomainError("UGC_AI_DECLARATION_INVALID","请选择 AI 内容声明",422);
    if(typeof input.rightsConfirmed!=="boolean"||typeof input.publicConsentConfirmed!=="boolean")throw new DomainError("UGC_DECLARATION_INVALID","请确认内容权利与公开范围",422);
    return transaction(this.pool,async client=>{
      const post=(await client.query("SELECT * FROM ugc_post WHERE id=$1 AND author_member_id=$2 FOR UPDATE",[id,owner])).rows[0];
      if(!post)throw new DomainError("UGC_POST_NOT_FOUND","草稿不存在或不属于当前账号",404);
      if(!["draft","rejected","published"].includes(post.state))throw new DomainError("UGC_POST_LOCKED","当前审核状态不能编辑",409);
      if(post.version!==expected)throw new DomainError("UGC_VERSION_CONFLICT","草稿已更新，请重新加载后核对",409);
      if(images.length){const owned=await client.query(`SELECT id FROM ugc_media_asset WHERE id=ANY($1::uuid[]) AND owner_member_id=$2
        AND state IN ('uploaded','scanning','approved') AND (bound_post_id IS NULL OR bound_post_id=$3) FOR UPDATE`,[images,owner,id]);
        if(owned.rowCount!==images.length)throw new DomainError("UGC_MEDIA_NOT_READY","有图片尚未上传完成或不属于这篇内容",409);}
      const revision=post.current_revision+1;
      await client.query(`INSERT INTO ugc_post_revision(post_id,revision,created_by_member_id,title,body,ai_usage,rights_confirmed,public_consent_confirmed)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,revision,owner,title,body,aiUsage,input.rightsConfirmed,input.publicConsentConfirmed]);
      for(let position=0;position<images.length;position+=1)await client.query(`INSERT INTO ugc_post_media(post_id,revision,media_asset_id,position)
        VALUES($1,$2,$3,$4)`,[id,revision,images[position],position]);
      await client.query(`UPDATE ugc_post SET current_revision=$2,version=version+1,
        state=CASE WHEN published_revision IS NOT NULL AND state='published' THEN 'published' ELSE 'draft' END,
        visibility=CASE WHEN published_revision IS NOT NULL AND state='published' THEN 'public' ELSE 'private' END,
        updated_at=now() WHERE id=$1`,[id,revision]);
      return this.readOwnWithClient(client,owner,id);
    });
  }

  async submit(memberId:string|undefined,postId:string,expectedVersion:unknown){
    const owner=member(memberId),id=uuid(postId),expected=positiveVersion(expectedVersion);
    return transaction(this.pool,async client=>{
      await this.requirePublicGate(client);
      const post=(await client.query("SELECT * FROM ugc_post WHERE id=$1 AND author_member_id=$2 FOR UPDATE",[id,owner])).rows[0];
      if(!post)throw new DomainError("UGC_POST_NOT_FOUND","草稿不存在或不属于当前账号",404);
      if(!["draft","published"].includes(post.state)||post.version!==expected||post.current_revision===post.published_revision)
        throw new DomainError("UGC_VERSION_CONFLICT","草稿或审核状态已变化，请刷新后重试",409);
      const revision=(await client.query("SELECT moderation_state FROM ugc_post_revision WHERE post_id=$1 AND revision=$2",[id,post.current_revision])).rows[0];
      if(revision?.moderation_state!=="unreviewed")throw new DomainError("UGC_VERSION_CONFLICT","当前版本已进入审核，请刷新后重试",409);
      const media=await client.query(`SELECT a.state FROM ugc_post_media b JOIN ugc_media_asset a ON a.id=b.media_asset_id
        WHERE b.post_id=$1 AND b.revision=$2 FOR SHARE OF a`,[id,post.current_revision]);
      if(media.rows.some(row=>!["uploaded","scanning","approved"].includes(row.state)))throw new DomainError("UGC_MEDIA_NOT_READY","图片尚未完成上传，请稍后重试",409);
      await client.query(`UPDATE ugc_post_revision SET moderation_state='pending' WHERE post_id=$1 AND revision=$2`,[id,post.current_revision]);
      await client.query(`UPDATE ugc_post SET state=CASE WHEN published_revision IS NULL THEN 'pending_review' ELSE 'published' END,
        version=version+1,updated_at=now() WHERE id=$1`,[id]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
        VALUES($1,'ugc.post_submitted','ugc_post',$2,'USER_SUBMITTED',$3,gen_random_uuid()::text)`,[`member:${owner}`,id,{revision:post.current_revision}]);
      return this.readOwnWithClient(client,owner,id);
    });
  }

  async authorizeMedia(memberId:string|undefined,postId:string,input:{mimeType?:unknown;maxBytes?:unknown;baseUrl:string}){
    if(this.config.objectStorage.driver==="s3")
      throw new DomainError("UGC_DIRECT_UPLOAD_UNSAFE","当前图片存储尚不能保证上传后不可覆盖，请稍后重试",503);
    const owner=member(memberId),id=uuid(postId),mimeType=input.mimeType,size=Number(input.maxBytes);
    if(typeof mimeType!=="string"||!mediaMimes.has(mimeType)||!Number.isInteger(size)||size<1||size>10*1024*1024)
      throw new DomainError("UGC_MEDIA_INVALID","请选择小于 10MB 的 JPG、PNG 或 WEBP 图片",422);
    return transaction(this.pool,async client=>{
      const post=(await client.query("SELECT state FROM ugc_post WHERE id=$1 AND author_member_id=$2 FOR SHARE",[id,owner])).rows[0];
      if(!post||!["draft","rejected","published"].includes(post.state))throw new DomainError("UGC_POST_LOCKED","当前内容不能添加图片",409);
      const switchRow=await client.query("SELECT 1 FROM emergency_switch WHERE key='uploads' AND enabled");
      if(!switchRow.rowCount)throw new DomainError("UPLOADS_PAUSED","图片上传暂时不可用，请稍后重试",503);
      const mediaId=randomUUID(),objectKey=`ugc/${owner}/${id}/${mediaId}`;
      await client.query(`INSERT INTO ugc_media_asset(id,owner_member_id,kind,object_key,mime_type,authorization_expires_at,authorized_max_bytes)
        VALUES($1,$2,'image',$3,$4,$5,$6)`,[mediaId,owner,objectKey,mimeType,new Date(Date.now()+10*60_000),size]);
      return this.storage.authorize({mediaId,objectKey,mimeType,maxBytes:size,baseUrl:input.baseUrl,now:new Date()});
    });
  }

  async ownsAuthorizedUpload(mediaId:string):Promise<{id:string;object_key:string}|null>{
    const result=await this.pool.query<{id:string;object_key:string}>("SELECT id,object_key FROM ugc_media_asset WHERE id=$1 AND state='authorized' AND authorization_expires_at>now()",[uuid(mediaId)]);
    return result.rows[0]??null;
  }
  async gatewayUpload(mediaId:string,input:{token:string;bytes:Uint8Array;mimeType:string}){
    const id=uuid(mediaId);
    if(!this.storage.writeGatewayObject)throw new DomainError("UGC_MEDIA_NOT_FOUND","图片上传入口不可用",404);
    return transaction(this.pool,async client=>{
      // Hold the same asset lock used by completeMedia. Once a checksum is
      // finalized, even a still-valid gateway token cannot overwrite bytes.
      const row=(await client.query(`SELECT id,object_key,state,authorization_expires_at FROM ugc_media_asset
        WHERE id=$1 FOR UPDATE`,[id])).rows[0];
      if(!row||row.state!=="authorized"||new Date(row.authorization_expires_at)<=new Date())
        throw new DomainError("UGC_MEDIA_NOT_FOUND","图片上传授权不存在或已过期",404);
      const stored=await this.storage.writeGatewayObject!({token:input.token,mediaId:id,objectKey:row.object_key,
        bytes:input.bytes,mimeType:input.mimeType,now:new Date()});
      return {mediaId:id,bytes:stored.bytes,uploaded:true};
    });
  }
  async chunkMedia(mediaId:string,input:{token?:unknown;index?:unknown;totalBytes?:unknown;base64?:unknown}){
    const id=uuid(mediaId),token=input.token,base64=input.base64,total=Number(input.totalBytes),index=Number(input.index);
    if(typeof token!=="string"||typeof base64!=="string"||base64.length>699052||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
      throw new DomainError("UGC_CHUNK_INVALID","图片分块格式无效",422);
    const bytes=Buffer.from(base64,"base64"),count=Math.ceil(total/chunkBytes);
    if(!Number.isSafeInteger(total)||total<1||total>10*1024*1024||!Number.isSafeInteger(index)||index<0||index>=count||
      bytes.length!==(index===count-1?total-index*chunkBytes:chunkBytes))
      throw new DomainError("UGC_CHUNK_INVALID","图片分块大小或顺序无效",422);
    return transaction(this.pool,async client=>{
      const asset=(await client.query("SELECT * FROM ugc_media_asset WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if(!asset||asset.state!=="authorized"||new Date(asset.authorization_expires_at)<=new Date())
        throw new DomainError("UGC_MEDIA_EXPIRED","图片上传授权已过期",409);
      const claims=validateGatewayUpload({token,mediaId:id,objectKey:asset.object_key,mimeType:asset.mime_type,
        bytes:new Uint8Array(1),now:new Date()},this.config.objectStorage.uploadTokenSecret);
      if(total>claims.maxBytes||total>asset.authorized_max_bytes)throw new DomainError("UGC_MEDIA_MISMATCH","图片超出授权大小",422);
      const hash=createHash("sha256").update(token).digest("hex");
      if(index===0)await client.query("DELETE FROM ugc_upload_chunk WHERE media_id=$1 AND (token_hash<>$2 OR expires_at<=now())",[id,hash]);
      else {const previous=await client.query(`SELECT 1 FROM ugc_upload_chunk WHERE media_id=$1 AND chunk_index=$2
        AND token_hash=$3 AND total_bytes=$4 AND expires_at>now()`,[id,index-1,hash,total]);
        if(!previous.rowCount)throw new DomainError("UGC_CHUNK_ORDER_INVALID","请按顺序重试上传",409);}
      const existing=(await client.query("SELECT bytes,total_bytes,token_hash FROM ugc_upload_chunk WHERE media_id=$1 AND chunk_index=$2",[id,index])).rows[0];
      if(existing&&(!existing.bytes.equals(bytes)||existing.total_bytes!==total||existing.token_hash!==hash))
        throw new DomainError("UGC_CHUNK_CONFLICT","重试的图片内容发生变化，请重新选择",409);
      await client.query(`INSERT INTO ugc_upload_chunk(media_id,chunk_index,token_hash,total_bytes,bytes,expires_at)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[id,index,hash,total,bytes,new Date(claims.expires)]);
      return {received:index,count};
    });
  }
  async finishMedia(mediaId:string,token:unknown){
    const id=uuid(mediaId);
    if(typeof token!=="string")throw new DomainError("UGC_UPLOAD_TOKEN_INVALID","缺少图片上传授权",401);
    const hash=createHash("sha256").update(token).digest("hex");
    const chunks=await this.pool.query(`SELECT chunk_index,total_bytes,bytes FROM ugc_upload_chunk
      WHERE media_id=$1 AND token_hash=$2 AND expires_at>now() ORDER BY chunk_index`,[id,hash]);
    const total=chunks.rows[0]?.total_bytes,count=Math.ceil(total/chunkBytes);
    if(!total||chunks.rows.length!==count||chunks.rows.some((row,index)=>row.chunk_index!==index||row.total_bytes!==total))
      throw new DomainError("UGC_UPLOAD_INCOMPLETE","图片尚未完整上传",409);
    const bytes=Buffer.concat(chunks.rows.map(row=>row.bytes));
    if(bytes.length!==total)throw new DomainError("UGC_UPLOAD_INCOMPLETE","图片大小不一致",409);
    const asset=await this.pool.query("SELECT mime_type FROM ugc_media_asset WHERE id=$1 AND state='authorized'",[id]);
    if(!asset.rowCount)throw new DomainError("UGC_MEDIA_EXPIRED","图片上传授权已失效",409);
    return this.gatewayUpload(id,{token,bytes,mimeType:asset.rows[0].mime_type});
  }
  async completeMedia(memberId:string|undefined,postId:string,mediaId:string){
    const owner=member(memberId),id=uuid(postId),assetId=uuid(mediaId);
    return transaction(this.pool,async client=>{
      const post=await client.query("SELECT 1 FROM ugc_post WHERE id=$1 AND author_member_id=$2 AND state IN ('draft','rejected','published') FOR SHARE",[id,owner]);
      if(!post.rowCount)throw new DomainError("UGC_POST_LOCKED","当前内容不能完成图片上传",409);
      const asset=(await client.query(`SELECT * FROM ugc_media_asset WHERE id=$1 AND owner_member_id=$2
        AND (bound_post_id IS NULL OR bound_post_id=$3) FOR UPDATE`,[assetId,owner,id])).rows[0];
      if(!asset)throw new DomainError("UGC_MEDIA_NOT_FOUND","图片不存在或不属于当前内容",404);
      if(["uploaded","scanning","approved"].includes(asset.state))return {id:assetId,state:asset.state};
      if(asset.state!=="authorized"||new Date(asset.authorization_expires_at)<=new Date())throw new DomainError("UGC_MEDIA_EXPIRED","图片上传授权已过期，请重新选择",409);
      const stored=await this.storage.verify(asset.object_key);
      if(stored.bytes<1||stored.bytes>asset.authorized_max_bytes||stored.detectedMime!==asset.mime_type)
        throw new DomainError("UGC_MEDIA_MISMATCH","图片大小或格式与选择时不同，请重新上传",422);
      const sha256=Buffer.from(stored.checksumBase64,"base64").toString("hex");
      await client.query(`UPDATE ugc_media_asset SET state='uploaded',size_bytes=$2,sha256=$3,uploaded_at=now(),updated_at=now()
        WHERE id=$1`,[assetId,stored.bytes,sha256]);
      return {id:assetId,state:"uploaded"};
    });
  }

  private async readOwnWithClient(client:DbClient,owner:string,id:string){
    const post=(await client.query(`SELECT p.id,p.state,p.visibility,p.current_revision,p.published_revision,p.version,p.updated_at,r.title,r.body,r.ai_usage,
      r.rights_confirmed,r.public_consent_confirmed,r.moderation_state
      FROM ugc_post p JOIN ugc_post_revision r ON r.post_id=p.id AND r.revision=p.current_revision
      WHERE p.id=$1 AND p.author_member_id=$2`,[id,owner])).rows[0];
    if(!post)throw new DomainError("UGC_POST_NOT_FOUND","内容不存在或不属于当前账号",404);
    const media=await client.query(`SELECT a.id,a.state,b.position FROM ugc_post_media b JOIN ugc_media_asset a ON a.id=b.media_asset_id
      WHERE b.post_id=$1 AND b.revision=$2 ORDER BY b.position`,[id,post.current_revision]);
    const review=await client.query(`SELECT decision,reason,created_at FROM ugc_post_review_action
      WHERE post_id=$1 AND revision=$2 ORDER BY created_at DESC LIMIT 1`,[id,post.current_revision]);
    const workflowState=post.published_revision && post.current_revision!==post.published_revision
      ? post.moderation_state==="unreviewed"?"draft":post.moderation_state==="pending"?"pending_review":post.moderation_state==="rejected"?"rejected":post.state
      : post.state;
    return {id:post.id,state:workflowState,publicVersionActive:post.state==="published"&&Boolean(post.published_revision),
      visibility:post.visibility,revision:post.current_revision,publishedRevision:post.published_revision,version:post.version,
      title:post.title??"",body:post.body??"",aiUsage:post.ai_usage,rightsConfirmed:post.rights_confirmed,
      publicConsentConfirmed:post.public_consent_confirmed,moderationState:post.moderation_state,updatedAt:post.updated_at,
      media:media.rows.map(row=>({id:row.id,state:row.state,position:row.position})),reviewNote:review.rows[0]?.reason??null};
  }
  async readOwn(memberId:string|undefined,postId:string){const owner=member(memberId),id=uuid(postId);
    return transaction(this.pool,client=>this.readOwnWithClient(client,owner,id),"REPEATABLE READ");}
  async myPosts(memberId:string|undefined){const owner=member(memberId);
    const result=await this.pool.query(`SELECT p.id,p.state,p.published_revision,p.current_revision,p.version,p.updated_at,r.title,r.body,r.moderation_state,
      (SELECT count(*)::int FROM ugc_post_media b WHERE b.post_id=p.id AND b.revision=p.current_revision) AS image_count
      FROM ugc_post p JOIN ugc_post_revision r ON r.post_id=p.id AND r.revision=p.current_revision
      WHERE p.author_member_id=$1 AND p.state<>'deleted' ORDER BY p.updated_at DESC,p.id DESC LIMIT 50`,[owner]);
    return {items:result.rows.map(row=>({id:row.id,state:row.published_revision&&row.current_revision!==row.published_revision
      ? row.moderation_state==="unreviewed"?"draft":row.moderation_state==="pending"?"pending_review":row.moderation_state==="rejected"?"rejected":row.state
      : row.state,publicVersionActive:row.state==="published"&&Boolean(row.published_revision),version:row.version,updatedAt:row.updated_at,
      title:row.title||row.body?.slice(0,30)||"图片护理故事",imageCount:row.image_count}))};}

  async feed(memberId:string|undefined,input:{q?:unknown;authorId?:unknown;limit?:unknown;cursor?:unknown;following?:unknown}={}){
    if(!await this.publicEnabled())return {items:[],total:0,nextCursor:null,publicEnabled:false};
    const followingOnly=input.following===true||input.following==="1";
    if(followingOnly&&!memberId)throw new DomainError("AUTH_REQUIRED","请先登录查看关注内容",401);
    const q=typeof input.q==="string"?input.q.trim().slice(0,80):"";
    const authorId=input.authorId?uuid(input.authorId):null;
    const limit=Number.isInteger(Number(input.limit))?Math.max(1,Math.min(30,Number(input.limit))):20;
    let cursorAt:Date|null=null,cursorId:string|null=null;
    if(input.cursor!==undefined){
      if(typeof input.cursor!=="string"||input.cursor.length>300)throw new DomainError("UGC_CURSOR_INVALID","请重新加载社区内容",422);
      try{
        const value=JSON.parse(Buffer.from(input.cursor,"base64url").toString("utf8")) as {at?:string;id?:string};
        if(!value.at||!value.id||!uuidPattern.test(value.id)||!Number.isFinite(Date.parse(value.at)))throw new Error("invalid");
        cursorAt=new Date(value.at);cursorId=value.id;
      }catch{throw new DomainError("UGC_CURSOR_INVALID","请重新加载社区内容",422);}
    }
    const result=await this.pool.query(`SELECT p.id,p.author_member_id,p.published_at,r.title,r.body,r.ai_usage,
      (SELECT b.media_asset_id FROM ugc_post_media b WHERE b.post_id=p.id AND b.revision=p.published_revision ORDER BY b.position LIMIT 1) AS cover_id,
      (SELECT count(*)::int FROM ugc_post_reaction x WHERE x.post_id=p.id AND x.kind='like') AS like_count
      FROM ugc_post p JOIN ugc_post_revision r ON r.post_id=p.id AND r.revision=p.published_revision
      JOIN member author ON author.id=p.author_member_id AND author.status='active'
      LEFT JOIN member_profile profile ON profile.member_id=author.id
      WHERE p.state='published' AND p.visibility='public' AND ($1='' OR r.title ILIKE '%'||$1||'%' OR r.body ILIKE '%'||$1||'%'
        OR (profile.community_visible AND profile.public_status='approved' AND author.display_name ILIKE '%'||$1||'%'))
        AND ($2::uuid IS NULL OR p.author_member_id=$2)
        AND ($3::uuid IS NULL OR NOT EXISTS(SELECT 1 FROM ugc_block_relation b WHERE b.blocker_member_id=$3 AND b.blocked_member_id=p.author_member_id))
        AND ($5::timestamptz IS NULL OR (p.published_at,p.id)<($5::timestamptz,$6::uuid))
        AND (NOT $7::boolean OR EXISTS(SELECT 1 FROM ugc_author_follow f
          WHERE f.follower_member_id=$3 AND f.followed_member_id=p.author_member_id))
      ORDER BY p.published_at DESC,p.id DESC LIMIT $4`,[q,authorId,memberId??null,limit+1,cursorAt,cursorId,followingOnly]);
    const page=result.rows.slice(0,limit),last=page[page.length-1],hasMore=result.rows.length>limit;
    const authors=await communityAuthors(this.pool,page.map(row=>row.author_member_id));
    return {items:page.map(row=>({id:row.id,authorId:row.author_member_id,author:authors[row.author_member_id]?.name??"CISME 会员",
      avatar:authors[row.author_member_id]?.avatar??"",title:row.title||row.body?.slice(0,40)||"图片护理故事",
      excerpt:row.body?.slice(0,100)||"",aiUsage:row.ai_usage,coverId:row.cover_id,likeCount:row.like_count,publishedAt:row.published_at})),
      total:page.length,nextCursor:hasMore&&last?Buffer.from(JSON.stringify({at:new Date(last.published_at).toISOString(),id:last.id})).toString("base64url"):null,
      publicEnabled:true};
  }

  async publicPost(memberId:string|undefined,postId:string){
    if(!await this.publicEnabled())throw new DomainError("UGC_POST_NOT_FOUND","护理故事暂不可见",404);
    const id=uuid(postId);
    const post=(await this.pool.query(`SELECT p.id,p.author_member_id,p.published_at,p.published_revision,p.version,r.title,r.body,r.ai_usage
      FROM ugc_post p JOIN ugc_post_revision r ON r.post_id=p.id AND r.revision=p.published_revision
      JOIN member author ON author.id=p.author_member_id AND author.status='active'
      WHERE p.id=$1 AND p.state='published' AND p.visibility='public'
        AND ($2::uuid IS NULL OR NOT EXISTS(SELECT 1 FROM ugc_block_relation b WHERE b.blocker_member_id=$2 AND b.blocked_member_id=p.author_member_id))`,[id,memberId??null])).rows[0];
    if(!post)throw new DomainError("UGC_POST_NOT_FOUND","护理故事已下架或不可见",404);
    const [media,reactions,comments,authors,follow]=await Promise.all([
      this.pool.query(`SELECT b.media_asset_id AS id,b.position FROM ugc_post_media b JOIN ugc_media_asset a ON a.id=b.media_asset_id
        WHERE b.post_id=$1 AND b.revision=$2 AND a.state='approved' ORDER BY b.position`,[id,post.published_revision]),
      this.pool.query(`SELECT kind,count(*)::int AS count,bool_or(member_id=$2) AS mine FROM ugc_post_reaction WHERE post_id=$1 GROUP BY kind`,[id,memberId??null]),
      this.pool.query(`SELECT c.id,c.body,c.created_at,c.author_member_id,c.parent_id,c.reply_to_id,c.state
        FROM ugc_comment c JOIN member commenter ON commenter.id=c.author_member_id AND commenter.status='active'
        WHERE c.post_id=$1 AND c.state='published' AND
        (c.parent_id IS NULL OR EXISTS(SELECT 1 FROM ugc_comment parent WHERE parent.id=c.parent_id AND parent.state='published'))
        ORDER BY c.created_at,c.id LIMIT 100`,[id]),
      communityAuthors(this.pool,[post.author_member_id]),
      memberId?this.pool.query(`SELECT EXISTS(SELECT 1 FROM ugc_author_follow
        WHERE follower_member_id=$1 AND followed_member_id=$2) AS following`,[memberId,post.author_member_id])
        :Promise.resolve({rows:[{following:false}]})
    ]);
    const commentAuthors=await communityAuthors(this.pool,comments.rows.map(row=>row.author_member_id));
    return {id,version:post.version,authorId:post.author_member_id,author:authors[post.author_member_id]?.name??"CISME 会员",
      avatar:authors[post.author_member_id]?.avatar??"",title:post.title??"",body:post.body??"",aiUsage:post.ai_usage,
      publishedAt:post.published_at,isMine:memberId===post.author_member_id,following:follow.rows[0]?.following===true,media:media.rows,
      likeCount:reactions.rows.find(row=>row.kind==="like")?.count??0,saveCount:reactions.rows.find(row=>row.kind==="save")?.count??0,
      liked:reactions.rows.find(row=>row.kind==="like")?.mine??false,saved:reactions.rows.find(row=>row.kind==="save")?.mine??false,
      comments:comments.rows.map(row=>({id:row.id,body:row.body,createdAt:row.created_at,authorId:row.author_member_id,
        author:commentAuthors[row.author_member_id]?.name??"CISME 会员",parentId:row.parent_id,replyToId:row.reply_to_id}))};
  }

  async publicMedia(mediaId:string,variant:"thumbnail"|"detail"="detail"){
    if(!await this.publicEnabled())throw new DomainError("UGC_MEDIA_NOT_FOUND","图片暂不可见",404);
    const id=uuid(mediaId);
    const row=(await this.pool.query(`SELECT a.public_object_key,a.thumbnail_object_key FROM ugc_media_asset a JOIN ugc_post_media b ON b.media_asset_id=a.id
      JOIN ugc_post p ON p.id=b.post_id AND p.published_revision=b.revision
      JOIN member author ON author.id=p.author_member_id AND author.status='active'
      WHERE a.id=$1 AND a.state='approved' AND p.state='published' AND p.visibility='public'`,[id])).rows[0];
    if(!row)throw new DomainError("UGC_MEDIA_NOT_FOUND","图片已撤回或不可见",404);
    return this.storage.read(variant==="thumbnail"?row.thumbnail_object_key:row.public_object_key);
  }

  async ownMedia(memberId:string|undefined,mediaId:string){
    const owner=member(memberId),id=uuid(mediaId);
    const row=(await this.pool.query(`SELECT object_key FROM ugc_media_asset WHERE id=$1 AND owner_member_id=$2
      AND state IN ('uploaded','scanning','approved')`,[id,owner])).rows[0];
    if(!row)throw new DomainError("UGC_MEDIA_NOT_FOUND","图片不存在或不属于当前账号",404);
    return this.storage.read(row.object_key);
  }

  async ownMediaPreviewUrl(memberId:string|undefined,mediaId:string,baseUrl:string){
    const owner=member(memberId),id=uuid(mediaId);
    const row=(await this.pool.query(`SELECT 1 FROM ugc_media_asset a WHERE a.id=$1 AND a.owner_member_id=$2
      AND a.state IN ('uploaded','scanning','approved')
      AND EXISTS(SELECT 1 FROM ugc_post_media b JOIN ugc_post p ON p.id=b.post_id
        WHERE b.media_asset_id=a.id AND p.author_member_id=$2 AND p.current_revision=b.revision
          AND p.state<>'deleted')`,[id,owner])).rows[0];
    if(!row)throw new DomainError("UGC_MEDIA_NOT_FOUND","图片不存在或不属于当前账号",404);
    const expires=Date.now()+5*60_000;
    const signature=createHmac("sha256",this.config.sessionSecret).update(`ugc-own-preview:${owner}:${id}:${expires}`).digest("base64url");
    return {url:`${baseUrl}/v1/ugc/own-preview/${owner}/${id}?token=${expires}.${signature}`,expiresAt:new Date(expires).toISOString()};
  }

  async ownMediaPreview(ownerId:string,mediaId:string,token:unknown){
    const owner=uuid(ownerId),id=uuid(mediaId),parts=typeof token==="string"?token.split("."):[];
    const expires=Number(parts[0]);
    if(parts.length!==2||!Number.isSafeInteger(expires)||expires<Date.now()||expires>Date.now()+5*60_000)
      throw new DomainError("UGC_PREVIEW_EXPIRED","草稿图片预览已过期",403);
    const expected=createHmac("sha256",this.config.sessionSecret).update(`ugc-own-preview:${owner}:${id}:${expires}`).digest("base64url");
    const supplied=Buffer.from(parts[1]??""),expectedBytes=Buffer.from(expected);
    if(supplied.length!==expectedBytes.length||!timingSafeEqual(supplied,expectedBytes))
      throw new DomainError("UGC_PREVIEW_INVALID","草稿图片预览无效",403);
    const row=(await this.pool.query(`SELECT a.object_key FROM ugc_media_asset a WHERE a.id=$1 AND a.owner_member_id=$2
      AND a.state IN ('uploaded','scanning','approved')
      AND EXISTS(SELECT 1 FROM ugc_post_media b JOIN ugc_post p ON p.id=b.post_id
        WHERE b.media_asset_id=a.id AND p.author_member_id=$2 AND p.current_revision=b.revision
          AND p.state<>'deleted')`,[id,owner])).rows[0];
    if(!row)throw new DomainError("UGC_MEDIA_NOT_FOUND","图片已撤回",404);
    return this.storage.read(row.object_key);
  }

  async reviewQueue(memberId:string|undefined){
    await this.authority.require(memberId,"community.moderate");
    const result=await this.pool.query(`SELECT p.id,p.author_member_id,p.current_revision,p.published_revision,p.version,p.updated_at,r.title,r.body,r.ai_usage,r.moderation_state,
      (SELECT count(*)::int FROM ugc_post_media b WHERE b.post_id=p.id AND b.revision=p.current_revision) AS image_count
      FROM ugc_post p JOIN ugc_post_revision r ON r.post_id=p.id AND r.revision=p.current_revision
      WHERE p.state IN ('pending_review','published') AND r.moderation_state IN ('pending','approved')
        AND (p.published_revision IS NULL OR p.current_revision<>p.published_revision)
      ORDER BY p.updated_at,p.id LIMIT 50`);
    return {items:result.rows};
  }

  async reviewCandidate(memberId:string|undefined,postId:string){
    await this.authority.require(memberId,"community.moderate");
    const id=uuid(postId);
    const post=(await this.pool.query(`SELECT p.id,p.author_member_id,p.state,p.current_revision,p.published_revision,p.version,p.updated_at,
      r.title,r.body,r.ai_usage,r.rights_confirmed,r.public_consent_confirmed,r.moderation_state
      FROM ugc_post p JOIN ugc_post_revision r ON r.post_id=p.id AND r.revision=p.current_revision
      WHERE p.id=$1 AND p.state IN ('pending_review','published') AND r.moderation_state IN ('pending','approved')
        AND (p.published_revision IS NULL OR p.current_revision<>p.published_revision)`,[id])).rows[0];
    if(!post)throw new DomainError("UGC_POST_NOT_FOUND","内容不存在",404);
    const [media,approval]=await Promise.all([
      this.pool.query(`SELECT a.id,a.state,a.scan_result->>'verdict' AS scan_verdict,
        a.scan_result->>'provider' AS scan_provider,b.position FROM ugc_post_media b JOIN ugc_media_asset a ON a.id=b.media_asset_id
        WHERE b.post_id=$1 AND b.revision=$2 ORDER BY b.position`,[id,post.current_revision]),
      this.pool.query(`SELECT reviewer_member_id,decision,reason,created_at FROM ugc_post_review_action
        WHERE post_id=$1 AND revision=$2 ORDER BY created_at DESC LIMIT 1`,[id,post.current_revision])]);
    return {id:post.id,authorId:post.author_member_id,state:post.state,revision:post.current_revision,
      publishedRevision:post.published_revision,version:post.version,
      title:post.title??"",body:post.body??"",aiUsage:post.ai_usage,rightsConfirmed:post.rights_confirmed,
      publicConsentConfirmed:post.public_consent_confirmed,moderationState:post.moderation_state,
      media:media.rows.map(row=>({id:row.id,state:row.state,scanVerdict:row.scan_verdict,scanProvider:row.scan_provider,position:row.position})),
      lastAction:approval.rows[0]??null};
  }
  async reviewPreviewUrl(memberId:string|undefined,mediaId:string,baseUrl:string){
    await this.authority.require(memberId,"community.moderate");
    const id=uuid(mediaId);
    const row=(await this.pool.query(`SELECT a.object_key FROM ugc_media_asset a
      WHERE a.id=$1 AND a.state IN ('uploaded','scanning','approved','rejected')
      AND EXISTS(SELECT 1 FROM ugc_post_media b JOIN ugc_post p ON p.id=b.post_id
        WHERE b.media_asset_id=a.id AND p.current_revision=b.revision AND p.state IN ('pending_review','published')
          AND (p.published_revision IS NULL OR p.current_revision<>p.published_revision))`,[id])).rows[0];
    if(!row)throw new DomainError("UGC_MEDIA_NOT_FOUND","审核图片不存在",404);
    const expires=Date.now()+5*60_000;
    const signature=createHmac("sha256",this.config.sessionSecret).update(`ugc-preview:${id}:${expires}`).digest("base64url");
    return {url:`${baseUrl}/v1/ugc/review-preview/${id}?token=${expires}.${signature}`,expiresAt:new Date(expires).toISOString()};
  }
  async reviewMediaPreview(mediaId:string,token:unknown){
    const id=uuid(mediaId),parts=typeof token==="string"?token.split("."):[];
    const expires=Number(parts[0]);
    if(parts.length!==2||!Number.isSafeInteger(expires)||expires<Date.now()||expires>Date.now()+5*60_000)
      throw new DomainError("UGC_PREVIEW_EXPIRED","审核图片预览已过期",403);
    const expected=createHmac("sha256",this.config.sessionSecret).update(`ugc-preview:${id}:${expires}`).digest("base64url");
    const supplied=Buffer.from(parts[1]??""),expectedBytes=Buffer.from(expected);
    if(supplied.length!==expectedBytes.length||!timingSafeEqual(supplied,expectedBytes))
      throw new DomainError("UGC_PREVIEW_INVALID","审核图片预览无效",403);
    const row=(await this.pool.query(`SELECT a.object_key FROM ugc_media_asset a
      WHERE a.id=$1 AND a.state IN ('uploaded','scanning','approved','rejected')
      AND EXISTS(SELECT 1 FROM ugc_post_media b JOIN ugc_post p ON p.id=b.post_id
        WHERE b.media_asset_id=a.id AND p.current_revision=b.revision AND p.state IN ('pending_review','published')
          AND (p.published_revision IS NULL OR p.current_revision<>p.published_revision))`,[id])).rows[0];
    if(!row)throw new DomainError("UGC_MEDIA_NOT_FOUND","审核图片不存在",404);
    return this.storage.read(row.object_key);
  }

  async reviewMedia(memberId:string|undefined,mediaId:string,input:{decision?:unknown;reason?:unknown;ruleVersion?:unknown}){
    const reviewer=member(memberId),id=uuid(mediaId),decision=input.decision,why=reason(input.reason);
    if(decision!=="approve"&&decision!=="reject")throw new DomainError("UGC_REVIEW_INVALID","请选择通过或退回",422);
    const rule=typeof input.ruleVersion==="string"?input.ruleVersion.trim():"";
    if(rule.length<3||rule.length>100)throw new DomainError("UGC_REVIEW_RULE_INVALID","审核规则版本无效",422);
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,reviewer,"community.moderate");
      const asset=(await client.query("SELECT * FROM ugc_media_asset WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if(!asset)throw new DomainError("UGC_MEDIA_NOT_FOUND","图片不存在",404);
      if(asset.owner_member_id===reviewer)throw new DomainError("UGC_SELF_REVIEW_FORBIDDEN","不能审核自己的图片",403);
      if(!["uploaded","scanning"].includes(asset.state))throw new DomainError("UGC_MEDIA_REVIEW_CONFLICT","图片审核状态已变化",409);
      const submitted=await client.query(`SELECT 1 FROM ugc_post_media b JOIN ugc_post p ON p.id=b.post_id
        JOIN ugc_post_revision r ON r.post_id=b.post_id AND r.revision=b.revision
        WHERE b.media_asset_id=$1 AND p.current_revision=b.revision AND r.moderation_state='pending'
          AND p.state IN ('pending_review','published')`,[id]);
      if(!submitted.rowCount)throw new DomainError("UGC_MEDIA_REVIEW_CONFLICT","图片所属内容尚未提交或已变化",409);
      if(decision==="approve" && (asset.scan_result?.verdict!=="safe"||!asset.scan_result?.provider||!asset.scan_result?.checkedAt||
        (this.config.env!=="test"&&asset.scan_result.provider==="test_fixture")))
        throw new DomainError("UGC_MEDIA_SCAN_REQUIRED","图片安全检测尚未通过",409);
      if(decision==="approve"&&this.config.env!=="test"){
        const latest=(await client.query(`SELECT state,trace_id,content_sha256,provider FROM ugc_safety_scan
          WHERE media_asset_id=$1 AND kind='image' ORDER BY requested_at DESC,id DESC LIMIT 1`,[id])).rows[0];
        if(!latest||latest.state!=="safe"||latest.content_sha256!==asset.sha256||latest.provider!=="wechat_v2"||
          latest.trace_id!==asset.scan_result?.traceId)
          throw new DomainError("UGC_MEDIA_SCAN_REQUIRED","最新图片安全检测尚未通过",409);
      }
      if(decision==="approve"){
        const original=await this.storage.read(asset.object_key);
        const pipeline=sharp(Buffer.from(original.bytes),{limitInputPixels:36_000_000}).rotate();
        const detail=await pipeline.clone().resize({width:1600,height:1600,fit:"inside",withoutEnlargement:true}).webp({quality:82}).toBuffer();
        const thumbnail=await pipeline.clone().resize({width:480,height:640,fit:"inside",withoutEnlargement:true}).webp({quality:76}).toBuffer();
        const detailKey=`ugc-derived/${id}/detail-${createHash("sha256").update(detail).digest("hex")}.webp`;
        const thumbnailKey=`ugc-derived/${id}/thumb-${createHash("sha256").update(thumbnail).digest("hex")}.webp`;
        await this.storage.writeDerivedImage(detailKey,detail);
        await this.storage.writeDerivedImage(thumbnailKey,thumbnail);
        await client.query(`UPDATE ugc_media_asset SET state='approved',public_object_key=$2,thumbnail_object_key=$3,
          derived_at=now(),updated_at=now() WHERE id=$1`,[id,detailKey,thumbnailKey]);
      }else await client.query("UPDATE ugc_media_asset SET state='rejected',updated_at=now() WHERE id=$1",[id]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
        VALUES($1,'ugc.media_review','ugc_media_asset',$2,$3,$4,$5)`,[`member:${reviewer}`,id,why,{decision,ruleVersion:rule,scanResult:asset.scan_result},randomUUID()]);
      return {id,state:decision==="approve"?"approved":"rejected"};
    });
  }

  async reviewPost(memberId:string|undefined,postId:string,input:{decision?:unknown;reason?:unknown;ruleVersion?:unknown;expectedVersion?:unknown}){
    const reviewer=member(memberId),id=uuid(postId),decision=input.decision,why=reason(input.reason),expected=positiveVersion(input.expectedVersion);
    if(decision!=="approve"&&decision!=="reject")throw new DomainError("UGC_REVIEW_INVALID","请选择通过或退回",422);
    const rule=typeof input.ruleVersion==="string"?input.ruleVersion.trim():"";
    if(rule.length<3||rule.length>100)throw new DomainError("UGC_REVIEW_RULE_INVALID","审核规则版本无效",422);
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,reviewer,"community.moderate");
      const post=(await client.query("SELECT * FROM ugc_post WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if(!post)throw new DomainError("UGC_POST_NOT_FOUND","内容不存在",404);
      if(post.author_member_id===reviewer)throw new DomainError("UGC_SELF_REVIEW_FORBIDDEN","不能审核自己的内容",403);
      if(!["pending_review","published"].includes(post.state)||post.version!==expected||post.current_revision===post.published_revision)
        throw new DomainError("UGC_REVIEW_CONFLICT","内容已变化，请刷新后重试",409);
      const revision=(await client.query("SELECT moderation_state,title,body FROM ugc_post_revision WHERE post_id=$1 AND revision=$2",[id,post.current_revision])).rows[0];
      if(revision?.moderation_state!=="pending")throw new DomainError("UGC_REVIEW_CONFLICT","当前版本已完成审核，请刷新",409);
      if(decision==="approve"){
        const scanText=[revision.title,revision.body].filter(Boolean).join("\n").trim();
        if(scanText&&this.config.env!=="test"){
          const fingerprint=createHash("sha256").update(scanText).digest("hex");
          const latest=(await client.query(`SELECT state,content_sha256,provider FROM ugc_safety_scan
            WHERE post_id=$1 AND revision=$2 AND kind='text' ORDER BY requested_at DESC,id DESC LIMIT 1`,
            [id,post.current_revision])).rows[0];
          if(!latest||latest.state!=="safe"||latest.content_sha256!==fingerprint||latest.provider!=="wechat_v2")
            throw new DomainError("UGC_TEXT_SCAN_REQUIRED","最新文字安全检测尚未通过",409);
        }
        const assets=await client.query(`SELECT a.state,a.scan_result FROM ugc_post_media b JOIN ugc_media_asset a ON a.id=b.media_asset_id
          WHERE b.post_id=$1 AND b.revision=$2 FOR SHARE OF a`,[id,post.current_revision]);
        if(assets.rows.some(row=>row.state!=="approved"||row.scan_result?.verdict!=="safe"))
          throw new DomainError("UGC_MEDIA_SCAN_REQUIRED","请先完成所有图片的安全检测与审核",409);
      }
      await client.query("UPDATE ugc_post_revision SET moderation_state=$3 WHERE post_id=$1 AND revision=$2",[id,post.current_revision,decision==="approve"?"approved":"rejected"]);
      await client.query(`UPDATE ugc_post SET state=CASE WHEN published_revision IS NULL AND $2='reject' THEN 'rejected'
        WHEN published_revision IS NULL THEN 'pending_review' ELSE 'published' END,version=version+1,updated_at=now() WHERE id=$1`,[id,decision]);
      await client.query(`INSERT INTO ugc_post_review_action(post_id,revision,reviewer_member_id,decision,reason,rule_version,evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,post.current_revision,reviewer,decision,why,rule,{reviewedAt:new Date().toISOString(),mediaChecked:decision==="approve"}]);
      return {id,decision,revision:post.current_revision,version:post.version+1};
    });
  }

  async publish(memberId:string|undefined,postId:string,expectedVersion:unknown){
    const publisher=member(memberId),id=uuid(postId),expected=positiveVersion(expectedVersion);
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,publisher,"community.moderate");
      await this.requirePublicGate(client);
      const post=(await client.query("SELECT * FROM ugc_post WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if(!post)throw new DomainError("UGC_POST_NOT_FOUND","内容不存在",404);
      if(post.author_member_id===publisher)throw new DomainError("UGC_SELF_REVIEW_FORBIDDEN","不能发布自己的内容",403);
      if(!["pending_review","published"].includes(post.state)||post.version!==expected||post.current_revision===post.published_revision)
        throw new DomainError("UGC_REVIEW_CONFLICT","内容已变化，请刷新后重试",409);
      const revision=(await client.query("SELECT moderation_state FROM ugc_post_revision WHERE post_id=$1 AND revision=$2",[id,post.current_revision])).rows[0];
      if(revision?.moderation_state!=="approved")throw new DomainError("UGC_SECOND_REVIEW_REQUIRED","当前版本尚未通过内容审核",409);
      const approval=(await client.query(`SELECT reviewer_member_id FROM ugc_post_review_action
        WHERE post_id=$1 AND revision=$2 AND decision='approve' ORDER BY created_at DESC LIMIT 1`,[id,post.current_revision])).rows[0];
      if(!approval||approval.reviewer_member_id===publisher)throw new DomainError("UGC_SECOND_REVIEW_REQUIRED","需要另一名审核员确认公开",403);
      await client.query(`UPDATE ugc_post SET state='published',visibility='public',published_revision=current_revision,published_at=now(),version=version+1,updated_at=now()
        WHERE id=$1`,[id]);
      await client.query(`INSERT INTO ugc_post_review_action(post_id,revision,reviewer_member_id,decision,reason,rule_version,evidence)
        VALUES($1,$2,$3,'publish','复核通过并公开','UGC-R1',$4)`,[id,post.current_revision,publisher,{approvedBy:approval.reviewer_member_id,publishedAt:new Date().toISOString()}]);
      return {id,state:"published",version:post.version+1};
    });
  }

  async deleteOwn(memberId:string|undefined,postId:string,expectedVersion:unknown){
    const owner=member(memberId),id=uuid(postId),expected=positiveVersion(expectedVersion);
    return transaction(this.pool,async client=>{
      const post=(await client.query("SELECT * FROM ugc_post WHERE id=$1 AND author_member_id=$2 FOR UPDATE",[id,owner])).rows[0];
      if(!post)throw new DomainError("UGC_POST_NOT_FOUND","内容不存在或不属于当前账号",404);
      if(post.state==="deleted")return {id,state:"deleted",version:post.version};
      if(post.version!==expected)throw new DomainError("UGC_VERSION_CONFLICT","内容已变化，请刷新后重试",409);
      await client.query(`UPDATE ugc_post SET state='deleted',visibility='private',deleted_at=now(),version=version+1,updated_at=now() WHERE id=$1`,[id]);
      return {id,state:"deleted",version:post.version+1};
    });
  }

  async react(memberId:string|undefined,postId:string,input:{kind?:unknown;active?:unknown}){
    const owner=member(memberId),id=uuid(postId),kind=input.kind;
    if(kind!=="like"&&kind!=="save"||typeof input.active!=="boolean")throw new DomainError("UGC_REACTION_INVALID","操作无效",422);
    return transaction(this.pool,async client=>{
      await this.requirePublicGate(client);
      const post=await client.query(`SELECT 1 FROM ugc_post p JOIN member author ON author.id=p.author_member_id
        AND author.status='active' WHERE p.id=$1 AND p.state='published' AND p.visibility='public' FOR SHARE OF p`,[id]);
      if(!post.rowCount)throw new DomainError("UGC_POST_NOT_FOUND","内容已下架",404);
      if(input.active)await client.query(`INSERT INTO ugc_post_reaction(post_id,member_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[id,owner,kind]);
      else await client.query("DELETE FROM ugc_post_reaction WHERE post_id=$1 AND member_id=$2 AND kind=$3",[id,owner,kind]);
      const count=await client.query("SELECT count(*)::int AS value FROM ugc_post_reaction WHERE post_id=$1 AND kind=$2",[id,kind]);
      return {kind,active:input.active,count:count.rows[0].value};
    });
  }

  async follow(memberId:string|undefined,authorId:string,active:unknown){
    const owner=member(memberId),author=uuid(authorId);
    if(owner===author||typeof active!=="boolean")throw new DomainError("UGC_FOLLOW_INVALID","关注操作无效",422);
    return transaction(this.pool,async client=>{
      await this.requirePublicGate(client);
      if(active){
        const visible=await client.query(`SELECT 1 FROM member a WHERE a.id=$1 AND a.status='active'
          AND EXISTS(SELECT 1 FROM ugc_post p WHERE p.author_member_id=a.id AND p.state='published' AND p.visibility='public')
          AND NOT EXISTS(SELECT 1 FROM ugc_block_relation b WHERE
            (b.blocker_member_id=$2 AND b.blocked_member_id=$1)
            OR (b.blocker_member_id=$1 AND b.blocked_member_id=$2))`,[author,owner]);
        if(!visible.rowCount)throw new DomainError("UGC_AUTHOR_NOT_FOUND","作者暂不可关注",404);
        await client.query(`INSERT INTO ugc_author_follow(follower_member_id,followed_member_id)
          VALUES($1,$2) ON CONFLICT DO NOTHING`,[owner,author]);
      }else await client.query(`DELETE FROM ugc_author_follow
        WHERE follower_member_id=$1 AND followed_member_id=$2`,[owner,author]);
      return {authorId:author,following:active};
    });
  }

  async comment(memberId:string|undefined,postId:string,operationKey:unknown,input:{body?:unknown;parentId?:unknown;replyToId?:unknown}){
    const owner=member(memberId),id=uuid(postId),op=key(operationKey),body=cleanText(input.body,1000,"评论");
    if(!body)throw new DomainError("UGC_COMMENT_EMPTY","请输入评论内容",422);
    const parentId=input.parentId?uuid(input.parentId):null,replyToId=input.replyToId?uuid(input.replyToId):null;
    return transaction(this.pool,async client=>{
      await this.requirePublicGate(client);
      const previous=(await client.query(`SELECT id,state,post_id,body,parent_id,reply_to_id FROM ugc_comment
        WHERE author_member_id=$1 AND operation_id=$2`,[owner,op])).rows[0];
      if(previous){
        if(previous.post_id!==id||previous.body!==body||previous.parent_id!==parentId||previous.reply_to_id!==replyToId)
          throw new DomainError("UGC_COMMENT_RETRY_CONFLICT","评论内容已变化，请重新发送",409);
        return {id:previous.id,state:previous.state};
      }
      const post=await client.query(`SELECT 1 FROM ugc_post p JOIN member author ON author.id=p.author_member_id
        AND author.status='active' WHERE p.id=$1 AND p.state='published' AND p.visibility='public' FOR SHARE OF p`,[id]);
      if(!post.rowCount)throw new DomainError("UGC_POST_NOT_FOUND","内容已下架",404);
      if(parentId){const parent=(await client.query("SELECT post_id,state FROM ugc_comment WHERE id=$1",[parentId])).rows[0];
        if(!parent||parent.post_id!==id||parent.state!=="published")throw new DomainError("UGC_COMMENT_PARENT_INVALID","回复对象已不可见",409);}
      if(replyToId){const reply=(await client.query("SELECT post_id,state FROM ugc_comment WHERE id=$1",[replyToId])).rows[0];
        if(!reply||reply.post_id!==id||reply.state!=="published")throw new DomainError("UGC_COMMENT_PARENT_INVALID","回复对象已不可见",409);}
      const created=await client.query(`INSERT INTO ugc_comment(post_id,author_member_id,parent_id,reply_to_id,body,operation_id)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id,state`,[id,owner,parentId,replyToId,body,op]);
      return created.rows[0];
    });
  }

  async deleteComment(memberId:string|undefined,postId:string,commentId:string){
    const owner=member(memberId),id=uuid(postId),comment=uuid(commentId);
    return transaction(this.pool,async client=>{
      const row=(await client.query("SELECT * FROM ugc_comment WHERE id=$1 AND post_id=$2 AND author_member_id=$3 FOR UPDATE",[comment,id,owner])).rows[0];
      if(!row)throw new DomainError("UGC_COMMENT_NOT_FOUND","评论不存在或不属于当前账号",404);
      if(row.state==="deleted")return {id:comment,state:"deleted"};
      await client.query("UPDATE ugc_comment SET state='deleted',body=NULL,deleted_at=now(),version=version+1,updated_at=now() WHERE id=$1",[comment]);
      return {id:comment,state:"deleted"};
    });
  }

  async reviewComment(memberId:string|undefined,commentId:string,input:{decision?:unknown;reason?:unknown}){
    const reviewer=member(memberId),id=uuid(commentId),decision=input.decision,why=reason(input.reason);
    if(decision!=="approve"&&decision!=="reject")throw new DomainError("UGC_REVIEW_INVALID","请选择通过或退回",422);
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,reviewer,"community.moderate");
      const comment=(await client.query("SELECT * FROM ugc_comment WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if(!comment)throw new DomainError("UGC_COMMENT_NOT_FOUND","评论不存在",404);
      if(comment.author_member_id===reviewer)throw new DomainError("UGC_SELF_REVIEW_FORBIDDEN","不能审核自己的评论",403);
      if(comment.state!=="pending_review")throw new DomainError("UGC_REVIEW_CONFLICT","评论审核状态已变化",409);
      if(decision==="approve"){
        if(this.config.env!=="test"){
          const fingerprint=createHash("sha256").update(comment.body).digest("hex");
          const safe=await client.query(`SELECT 1 FROM ugc_comment_safety_scan WHERE comment_id=$1 AND body_sha256=$2
            AND provider='wechat_v2' AND state='safe' LIMIT 1`,[id,fingerprint]);
          if(!safe.rowCount)throw new DomainError("UGC_TEXT_SCAN_REQUIRED","评论安全检测尚未通过",409);
        }
        const post=await client.query("SELECT 1 FROM ugc_post WHERE id=$1 AND state='published' AND visibility='public'",[comment.post_id]);
        if(!post.rowCount)throw new DomainError("UGC_POST_NOT_FOUND","内容已下架，评论不能公开",409);
        if(comment.parent_id){const parent=await client.query("SELECT 1 FROM ugc_comment WHERE id=$1 AND state='published'",[comment.parent_id]);
          if(!parent.rowCount)throw new DomainError("UGC_COMMENT_PARENT_INVALID","上级评论已不可见",409);}
      }
      await client.query(`UPDATE ugc_comment SET state=$2,was_public=$3,version=version+1,updated_at=now() WHERE id=$1`,
        [id,decision==="approve"?"published":"rejected",decision==="approve"]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
        VALUES($1,'ugc.comment_review','ugc_comment',$2,$3,$4,$5)`,[`member:${reviewer}`,id,why,{decision},randomUUID()]);
      return {id,state:decision==="approve"?"published":"rejected"};
    });
  }

  async hidePost(memberId:string|undefined,postId:string,input:{reason?:unknown;expectedVersion?:unknown}){
    const reviewer=member(memberId),id=uuid(postId),why=reason(input.reason),expected=positiveVersion(input.expectedVersion);
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,reviewer,"community.moderate");
      const post=(await client.query("SELECT * FROM ugc_post WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if(!post)throw new DomainError("UGC_POST_NOT_FOUND","内容不存在",404);
      if(post.author_member_id===reviewer)throw new DomainError("UGC_SELF_REVIEW_FORBIDDEN","不能下架自己的内容",403);
      if(post.state!=="published"||post.version!==expected)throw new DomainError("UGC_REVIEW_CONFLICT","内容已变化，请刷新后重试",409);
      await client.query("UPDATE ugc_post SET state='hidden',visibility='private',version=version+1,updated_at=now() WHERE id=$1",[id]);
      await client.query(`INSERT INTO ugc_post_review_action(post_id,revision,reviewer_member_id,decision,reason,rule_version,evidence)
        VALUES($1,$2,$3,'hide',$4,'UGC-R1',$5)`,[id,post.current_revision,reviewer,why,{hiddenAt:new Date().toISOString()}]);
      return {id,state:"hidden",version:post.version+1};
    });
  }

  async deleteOwnMedia(memberId:string|undefined,mediaId:string){
    const owner=member(memberId),id=uuid(mediaId);
    return transaction(this.pool,async client=>{
      const asset=(await client.query("SELECT * FROM ugc_media_asset WHERE id=$1 AND owner_member_id=$2 FOR UPDATE",[id,owner])).rows[0];
      if(!asset)throw new DomainError("UGC_MEDIA_NOT_FOUND","图片不存在或不属于当前账号",404);
      if(asset.state==="deleted")return {id,state:"deleted"};
      const referenced=await client.query("SELECT 1 FROM ugc_post_media WHERE media_asset_id=$1 LIMIT 1",[id]);
      if(referenced.rowCount)throw new DomainError("UGC_MEDIA_IN_USE","图片仍被内容版本引用，无法删除",409);
      await client.query("UPDATE ugc_media_asset SET state='deleted',deleted_at=now(),updated_at=now() WHERE id=$1",[id]);
      await client.query("DELETE FROM ugc_upload_chunk WHERE media_id=$1",[id]);
      return {id,state:"deleted"};
    });
  }

  async report(memberId:string|undefined,targetType:unknown,targetId:unknown,input:{category?:unknown;description?:unknown}){
    const reporter=member(memberId),id=uuid(targetId),type=targetType;
    if(!["post","comment","member"].includes(String(type)))throw new DomainError("UGC_REPORT_INVALID","举报对象无效",422);
    if(!["spam","harassment","unsafe_advice","illegal","intellectual_property","privacy","other"].includes(String(input.category)))
      throw new DomainError("UGC_REPORT_INVALID","请选择举报原因",422);
    const description=cleanText(input.description,1000,"补充说明");
    return transaction(this.pool,async client=>{
      const targetTable=type==="post"?"ugc_post":type==="comment"?"ugc_comment":"member";
      const target=await client.query(`SELECT 1 FROM ${targetTable} WHERE id=$1`,[id]);
      if(!target.rowCount)throw new DomainError("UGC_REPORT_INVALID","举报对象不存在",404);
      const created=await client.query(`INSERT INTO ugc_report(reporter_member_id,target_type,target_id,category,description)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT (reporter_member_id,target_type,target_id,category)
        WHERE state IN ('received','triaged') DO UPDATE SET updated_at=ugc_report.updated_at RETURNING id,state`,[reporter,type,id,input.category,description]);
      await client.query(`INSERT INTO moderation_case(source_report_id,target_type,target_id,severity,policy_version)
        VALUES($1,$2,$3,'medium','UGC-R1') ON CONFLICT (target_type,target_id)
        WHERE state IN ('open','reviewing','appealed') DO NOTHING`,[created.rows[0].id,type,id]);
      return created.rows[0];
    });
  }

  async block(memberId:string|undefined,blockedId:string,active:unknown){
    const owner=member(memberId),blocked=uuid(blockedId);
    if(owner===blocked||typeof active!=="boolean")throw new DomainError("UGC_BLOCK_INVALID","屏蔽操作无效",422);
    await transaction(this.pool,async client=>{
      if(active){
        await client.query(`INSERT INTO ugc_block_relation(blocker_member_id,blocked_member_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[owner,blocked]);
        await client.query(`DELETE FROM ugc_author_follow WHERE follower_member_id=$1 AND followed_member_id=$2`,[owner,blocked]);
      }else await client.query("DELETE FROM ugc_block_relation WHERE blocker_member_id=$1 AND blocked_member_id=$2",[owner,blocked]);
    });
    return {memberId:blocked,blocked:active};
  }
}
