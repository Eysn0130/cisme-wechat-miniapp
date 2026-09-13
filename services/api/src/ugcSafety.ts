import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { AppConfig } from "@cisme/config";
import { DomainError } from "@cisme/domain";
import { transaction } from "./db.js";
import type { ObjectStorage } from "./storage.js";
import { pendingReviewRevisionSql } from "./ugcVisibility.js";
import { decryptWechatMessage, type MessageQuery } from "./wechatMessageCrypto.js";

type WechatResult={errcode?:number;errmsg?:string;trace_id?:string;result?:{suggest?:string;label?:number};detail?:unknown};
type ScanCallback=WechatResult&{Event?:string;appid?:string;version?:number};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
function validId(value:string){if(!uuid.test(value))throw new DomainError("UGC_ID_INVALID","内容编号无效",422);return value;}
function verdict(value:WechatResult):"safe"|"review"|"risky"|"error"{
  if(value.errcode!==0)return "error";
  return value.result?.suggest==="pass"?"safe":value.result?.suggest==="review"?"review":value.result?.suggest==="risky"?"risky":"error";
}
/** WeChat's text endpoint has a 2,500-character input limit. Keep overlap so
 * text at a split boundary is checked in both requests. */
export function securityTextParts(content:string):string[]{
  const chars=Array.from(content);
  const parts:string[]=[];
  for(let start=0;start<chars.length;start+=2200){
    const left=Math.max(0,start-100);
    parts.push(chars.slice(left,Math.min(chars.length,start+2300)).join(""));
  }
  return parts;
}

/** WeChat security v2 adapter. No fallback may mark a live item safe. */
export class UgcSafetyService{
  private tokenCache:{value:string;until:number}|null=null;
  constructor(private readonly pool:pg.Pool,private readonly config:AppConfig,private readonly storage:ObjectStorage,
    private readonly fetcher:typeof fetch=fetch){}

  private async accessToken():Promise<string>{
    if(!this.config.wechat.appId||!this.config.wechat.appSecret)throw new DomainError("UGC_SCAN_UNAVAILABLE","内容安全服务暂不可用，请稍后重试",503);
    if(this.tokenCache&&this.tokenCache.until>Date.now())return this.tokenCache.value;
    const url=`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(this.config.wechat.appId)}&secret=${encodeURIComponent(this.config.wechat.appSecret)}`;
    const response=await this.fetcher(url,{signal:AbortSignal.timeout(8000)});
    const body=await response.json() as {access_token?:string;expires_in?:number};
    if(!response.ok||!body.access_token)throw new DomainError("UGC_SCAN_UNAVAILABLE","内容安全服务暂不可用，请稍后重试",503);
    this.tokenCache={value:body.access_token,until:Date.now()+Math.max(60,(body.expires_in??7200)-120)*1000};
    return body.access_token;
  }
  private async request(path:string,body:Record<string,unknown>):Promise<WechatResult>{
    const token=await this.accessToken();
    const response=await this.fetcher(`https://api.weixin.qq.com/wxa/${path}?access_token=${encodeURIComponent(token)}`,
      {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
    const result=await response.json() as WechatResult;
    if(!response.ok||result.errcode!==0)throw new DomainError("UGC_SCAN_UNAVAILABLE","内容安全服务暂不可用，请稍后重试",503);
    return result;
  }
  private signedRawUrl(mediaId:string,postId:string,revision:number,sha256:string,baseUrl:string){
    const expires=Date.now()+45*60_000;
    const claims=`${postId}.${revision}.${sha256}.${expires}`;
    const signature=createHmac("sha256",this.config.sessionSecret).update(`ugc-scan:${mediaId}:${claims}`).digest("base64url");
    return `${baseUrl}/v1/ugc/scan-source/${mediaId}?token=${claims}.${signature}`;
  }
  private async claimScan(postId:string,revision:number,kind:"text"|"image",hash:string,mediaId:string|null){
    await this.pool.query(`UPDATE ugc_safety_scan SET state='error',resolved_at=clock_timestamp(),
      result='{"reason":"DISPATCH_LEASE_EXPIRED_WITHOUT_TRACE"}'::jsonb
      WHERE post_id=$1 AND revision=$2 AND kind=$3 AND media_asset_id IS NOT DISTINCT FROM $4::uuid
        AND content_sha256=$5 AND state='pending' AND trace_id IS NULL AND lease_until<clock_timestamp()`,
      [postId,revision,kind,mediaId,hash]);
    const result=await this.pool.query<{id:string}>(`INSERT INTO ugc_safety_scan
      (post_id,revision,media_asset_id,kind,content_sha256,provider,lease_until)
      VALUES($1,$2,$3,$4,$5,'wechat_v2',clock_timestamp()+interval '2 minutes')
      ON CONFLICT DO NOTHING RETURNING id`,[postId,revision,mediaId,kind,hash]);
    return result.rows[0]?.id??null;
  }
  async scanSource(mediaId:string,token:unknown){
    const id=validId(mediaId),parts=typeof token==="string"?token.split("."):[];
    const postId=parts[0],revision=Number(parts[1]),sha256=parts[2],expires=Number(parts[3]);
    if(parts.length!==5||!uuid.test(postId??"")||!Number.isSafeInteger(revision)||revision<1||
      !/^[0-9a-f]{64}$/.test(sha256??"")||!Number.isSafeInteger(expires)||expires<Date.now()||expires>Date.now()+45*60_000)
      throw new DomainError("UGC_SCAN_SOURCE_INVALID","扫描图片链接已失效",403);
    const claims=`${postId}.${revision}.${sha256}.${expires}`;
    const expected=createHmac("sha256",this.config.sessionSecret).update(`ugc-scan:${id}:${claims}`).digest("base64url");
    const a=Buffer.from(parts[4]??""),b=Buffer.from(expected);
    if(a.length!==b.length||!timingSafeEqual(a,b))throw new DomainError("UGC_SCAN_SOURCE_INVALID","扫描图片链接无效",403);
    const row=(await this.pool.query(`SELECT a.object_key FROM ugc_media_asset a
      JOIN ugc_post_media b ON b.media_asset_id=a.id JOIN ugc_post p ON p.id=b.post_id
      JOIN ugc_post_revision r ON r.post_id=b.post_id AND r.revision=b.revision
      WHERE a.id=$1 AND b.post_id=$2 AND b.revision=$3 AND a.sha256=$4 AND a.state IN ('uploaded','scanning')
        AND ${pendingReviewRevisionSql}`,[id,postId,revision,sha256])).rows[0];
    if(!row)throw new DomainError("UGC_SCAN_SOURCE_INVALID","待审图片已失效",404);
    return this.storage.read(row.object_key);
  }

  async scanPost(owner:string|undefined,postId:string,baseUrl:string){
    if(!owner)throw new DomainError("AUTH_REQUIRED","请先登录",401);
    const id=validId(postId);
    const post=(await this.pool.query(`SELECT p.id,p.current_revision,p.version,p.author_member_id,r.title,r.body,r.moderation_state,
      i.openid FROM ugc_post p JOIN ugc_post_revision r ON r.post_id=p.id AND r.revision=p.current_revision
      LEFT JOIN LATERAL (SELECT openid FROM wechat_identity WHERE member_id=p.author_member_id AND provider='wechat_miniprogram'
        AND app_id=$3 ORDER BY created_at DESC LIMIT 1) i ON true
      WHERE p.id=$1 AND p.author_member_id=$2 AND ${pendingReviewRevisionSql}`,[id,owner,this.config.wechat.appId??""])).rows[0];
    if(!post)throw new DomainError("UGC_SCAN_CONFLICT","内容已变化，请刷新后重试",409);
    if(!post.openid)throw new DomainError("UGC_SCAN_UNAVAILABLE","请用微信登录后再提交内容",409);
    const content=[post.title,post.body].filter(Boolean).join("\n").trim();
    const media=await this.pool.query(`SELECT a.id,a.sha256,a.state,a.scan_result FROM ugc_post_media b
      JOIN ugc_media_asset a ON a.id=b.media_asset_id WHERE b.post_id=$1 AND b.revision=$2 ORDER BY b.position`,[id,post.current_revision]);
    const results:{kind:string;id?:string;state:string}[]=[];
    if(content){
      const hash=digest(content);
      const prior=(await this.pool.query(`SELECT state,content_sha256,requested_at FROM ugc_safety_scan
        WHERE post_id=$1 AND revision=$2 AND kind='text' ORDER BY requested_at DESC,id DESC LIMIT 1`,
        [id,post.current_revision])).rows[0];
      if(prior?.content_sha256===hash&&(["safe","risky","review"].includes(prior.state)||
        (prior.state==="pending"&&Date.now()-new Date(prior.requested_at).getTime()<2*60_000)))
        results.push({kind:"text",state:prior.state});
      else{
        const scanId=await this.claimScan(id,post.current_revision,"text",hash,null);
        if(!scanId){results.push({kind:"text",state:"pending"});}
        else{
        try{
          const responses:WechatResult[]=[];
          for(const part of securityTextParts(content))responses.push(await this.request("msg_sec_check",
            {content:part,version:2,scene:3,openid:post.openid}));
          const states=responses.map(verdict);
          const state=states.includes("risky")?"risky":states.includes("review")?"review":states.includes("error")?"error":"safe";
          await this.pool.query(`UPDATE ugc_safety_scan SET state=$2,result=$3,resolved_at=now(),trace_id=$4 WHERE id=$1`,
            [scanId,state,{parts:responses},responses[0]?.trace_id??null]);
          results.push({kind:"text",state});
        }catch(error){
          await this.pool.query(`UPDATE ugc_safety_scan SET state='error',result=$2,resolved_at=now() WHERE id=$1`,
            [scanId,{error:(error as Error).message}]);
          results.push({kind:"text",state:"error"});
        }
        }
      }
    }
    for(const asset of media.rows){
      if(asset.state==="approved"&&asset.scan_result?.verdict==="safe"){
        results.push({kind:"image",id:asset.id,state:"safe"});continue;
      }
      if(!asset.sha256||!["uploaded","scanning"].includes(asset.state)){
        results.push({kind:"image",id:asset.id,state:"error"});continue;
      }
      const latest=(await this.pool.query(`SELECT state,content_sha256,requested_at FROM ugc_safety_scan
        WHERE media_asset_id=$1 AND kind='image' ORDER BY requested_at DESC,id DESC LIMIT 1`,[asset.id])).rows[0];
      if(latest?.content_sha256===asset.sha256&&(["safe","risky","review"].includes(latest.state)||
        (latest.state==="pending"&&Date.now()-new Date(latest.requested_at).getTime()<30*60_000))){
        results.push({kind:"image",id:asset.id,state:latest.state});continue;
      }
      const scanId=await this.claimScan(id,post.current_revision,"image",asset.sha256,asset.id);
      if(!scanId){results.push({kind:"image",id:asset.id,state:"pending"});continue;}
      try{
        const response=await this.request("media_check_async",{media_url:this.signedRawUrl(asset.id,id,post.current_revision,asset.sha256,baseUrl),media_type:2,version:2,scene:3,openid:post.openid});
        if(!response.trace_id)throw new Error("WECHAT_TRACE_MISSING");
        await transaction(this.pool,async client=>{
          await client.query("UPDATE ugc_safety_scan SET trace_id=$2 WHERE id=$1",[scanId,response.trace_id]);
          await client.query("UPDATE ugc_media_asset SET state='scanning',updated_at=now() WHERE id=$1 AND state='uploaded'",[asset.id]);
        });
        await this.applyCallback(response.trace_id);
        results.push({kind:"image",id:asset.id,state:"pending"});
      }catch(error){
        await this.pool.query(`UPDATE ugc_safety_scan SET state='error',result=$2,resolved_at=now() WHERE id=$1 AND state='pending'`,
          [scanId,{error:(error as Error).message}]);
        results.push({kind:"image",id:asset.id,state:"error"});
      }
    }
    return {postId:id,revision:post.current_revision,results};
  }

  async scanPendingBatch(baseUrl:string,limit=2){
    const candidates=await this.pool.query(`SELECT p.id,p.author_member_id FROM ugc_post p
      JOIN ugc_post_revision r ON r.post_id=p.id AND r.revision=p.current_revision
      WHERE ${pendingReviewRevisionSql}
        AND NOT EXISTS(SELECT 1 FROM ugc_safety_scan s WHERE s.post_id=p.id AND s.revision=p.current_revision
          AND s.requested_at>now()-interval '2 minutes')
      ORDER BY p.updated_at,p.id LIMIT $1`,[limit]);
    for(const row of candidates.rows){
      try{await this.scanPost(row.author_member_id,row.id,baseUrl);}catch{/* Remains pending for a later retry. */}
    }
    const comments=await this.pool.query(`SELECT c.id FROM ugc_comment c WHERE c.state='pending_review'
      AND NOT EXISTS(SELECT 1 FROM ugc_comment_scan_claim claim WHERE claim.comment_id=c.id AND
        (claim.state IN ('completed','quarantined') OR claim.lease_until>clock_timestamp()
          OR claim.next_attempt_at>clock_timestamp()))
      ORDER BY c.created_at,c.id LIMIT $1`,[limit]);
    for(const row of comments.rows){try{await this.scanComment(row.id);}catch{/* Comment stays private for retry. */}}
    const nicknames=await this.pool.query(`SELECT p.member_id FROM member_profile p JOIN member m ON m.id=p.member_id
      WHERE p.community_visible AND p.public_status='pending' AND m.status='active'
        AND NOT EXISTS(SELECT 1 FROM ugc_nickname_safety_scan s WHERE s.member_id=p.member_id
          AND s.profile_revision=p.profile_revision AND (s.state<>'pending'
            OR s.lease_until>clock_timestamp() OR s.next_attempt_at>clock_timestamp()))
      ORDER BY p.updated_at,p.member_id LIMIT $1`,[limit]);
    for(const row of nicknames.rows){try{await this.scanNickname(row.member_id);}catch{/* Keep pending public profile private. */}}
    return (candidates.rowCount??0)+(comments.rowCount??0)+(nicknames.rowCount??0);
  }

  async scanNickname(memberId:string){
    const id=validId(memberId);
    const profile=(await this.pool.query(`SELECT m.display_name,p.profile_revision,i.openid FROM member m
      JOIN member_profile p ON p.member_id=m.id
      LEFT JOIN LATERAL (SELECT openid FROM wechat_identity WHERE member_id=m.id
        AND provider='wechat_miniprogram' AND app_id=$2 AND adapter='wechat'
        ORDER BY created_at DESC,id DESC LIMIT 1) i ON true
      WHERE m.id=$1 AND m.status='active' AND p.community_visible AND p.public_status='pending'`,
      [id,this.config.wechat.appId??""])).rows[0];
    if(!profile)throw new DomainError("UGC_NICKNAME_SCAN_CONFLICT","公开资料已经变化",409);
    if(!profile.openid)throw new DomainError("UGC_SCAN_UNAVAILABLE","微信昵称检测身份不可用",503);
    const fingerprint=digest(profile.display_name);
    const claimed=(await this.pool.query<{id:string;lease_token:string}>(`INSERT INTO ugc_nickname_safety_scan
      (member_id,profile_revision,name_sha256) VALUES($1,$2,$3)
      ON CONFLICT(member_id,profile_revision) DO UPDATE SET lease_token=gen_random_uuid(),
        lease_until=clock_timestamp()+interval '30 seconds',attempt_count=ugc_nickname_safety_scan.attempt_count+1
      WHERE ugc_nickname_safety_scan.state='pending'
        AND ugc_nickname_safety_scan.name_sha256=EXCLUDED.name_sha256
        AND ugc_nickname_safety_scan.attempt_count<7
        AND ugc_nickname_safety_scan.lease_until<=clock_timestamp()
        AND ugc_nickname_safety_scan.next_attempt_at<=clock_timestamp()
      RETURNING id,lease_token`,[id,profile.profile_revision,fingerprint])).rows[0];
    if(!claimed)return {id,state:"pending"};
    try{
      const response=await this.request("msg_sec_check",{content:profile.display_name,
        version:2,scene:1,openid:profile.openid});
      const state=verdict(response);
      if(state==="error")throw new DomainError("UGC_NICKNAME_SCAN_UNDECIDED","昵称安全检测未给出可信结论",503);
      return transaction(this.pool,async client=>{
        const scan=(await client.query(`SELECT * FROM ugc_nickname_safety_scan WHERE id=$1 FOR UPDATE`,
          [claimed.id])).rows[0];
        if(scan?.lease_token!==claimed.lease_token||scan.state!=="pending")return {id,state:"pending"};
        const current=(await client.query(`SELECT m.display_name,p.profile_revision,p.public_status,p.community_visible
          FROM member m JOIN member_profile p ON p.member_id=m.id WHERE m.id=$1 FOR UPDATE OF m,p`,[id])).rows[0];
        const fresh=current?.profile_revision===profile.profile_revision&&current?.public_status==="pending"&&
          current?.community_visible===true&&digest(current.display_name)===fingerprint;
        await client.query(`UPDATE ugc_nickname_safety_scan SET state=$2,result=$3,
          resolved_at=clock_timestamp(),lease_until=clock_timestamp() WHERE id=$1 AND lease_token=$4`,
          [claimed.id,fresh?state:"obsolete",fresh?response:{reason:"PROFILE_CHANGED"},claimed.lease_token]);
        return {id,state:fresh?state:"obsolete"};
      });
    }catch(error){
      const code=error instanceof DomainError?error.code:"UGC_SCAN_UNAVAILABLE";
      await this.pool.query(`UPDATE ugc_nickname_safety_scan SET
        state=CASE WHEN attempt_count>=7 THEN 'quarantined' ELSE 'pending' END,
        result=CASE WHEN attempt_count>=7 THEN $3::jsonb ELSE NULL END,
        resolved_at=CASE WHEN attempt_count>=7 THEN clock_timestamp() ELSE NULL END,
        lease_until=clock_timestamp(),next_attempt_at=clock_timestamp()+
          LEAST(1800,5*POWER(2,attempt_count-1))*interval '1 second'
        WHERE id=$1 AND lease_token=$2 AND state='pending'`,
        [claimed.id,claimed.lease_token,JSON.stringify({error:code})]);
      return {id,state:"error"};
    }
  }

  async scanComment(commentId:string){
    const id=validId(commentId);
    const row=(await this.pool.query(`SELECT c.body,i.openid FROM ugc_comment c
      LEFT JOIN LATERAL (SELECT openid FROM wechat_identity WHERE member_id=c.author_member_id
        AND provider='wechat_miniprogram' AND app_id=$2 ORDER BY created_at DESC LIMIT 1) i ON true
      WHERE c.id=$1 AND c.state='pending_review'`,[id,this.config.wechat.appId??""])).rows[0];
    if(!row||!row.body)throw new DomainError("UGC_COMMENT_SCAN_CONFLICT","评论已变化",409);
    if(!row.openid)throw new DomainError("UGC_SCAN_UNAVAILABLE","评论作者需先完成微信登录",409);
    const fingerprint=digest(row.body);
    // Commit one identity and a fenced lease before any outbound call. A
    // second worker (or a retry while the first worker is alive) cannot send
    // the same body concurrently. Failures remain private and retry with a
    // bounded budget; they never become a publishable scan fact.
    const claim=(await this.pool.query<{lease_token:string}>(`INSERT INTO ugc_comment_scan_claim
      (comment_id,body_sha256) VALUES($1,$2)
      ON CONFLICT(comment_id) DO UPDATE SET
        body_sha256=EXCLUDED.body_sha256,lease_token=gen_random_uuid(),
        lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp(),
        state='pending',last_error=NULL,
        attempt_count=CASE WHEN ugc_comment_scan_claim.body_sha256<>EXCLUDED.body_sha256 THEN 1
          ELSE ugc_comment_scan_claim.attempt_count+1 END
      WHERE ugc_comment_scan_claim.body_sha256<>EXCLUDED.body_sha256 OR
        (ugc_comment_scan_claim.state='pending' AND ugc_comment_scan_claim.attempt_count<7
          AND ugc_comment_scan_claim.lease_until<=clock_timestamp()
          AND ugc_comment_scan_claim.next_attempt_at<=clock_timestamp())
      RETURNING lease_token`,[id,fingerprint])).rows[0];
    if(!claim)return {id,state:"pending"};
    try{
      const response=await this.request("msg_sec_check",{content:row.body,version:2,scene:2,openid:row.openid});
      const state=verdict(response);
      if(state==="error")throw new DomainError("UGC_COMMENT_SCAN_UNDECIDED","评论安全检测未给出可信结论",503);
      return transaction(this.pool,async client=>{
        const fence=(await client.query(`SELECT lease_token FROM ugc_comment_scan_claim
          WHERE comment_id=$1 FOR UPDATE`,[id])).rows[0];
        if(fence?.lease_token!==claim.lease_token)return {id,state:"pending"};
        const current=(await client.query(`SELECT body,state FROM ugc_comment WHERE id=$1 FOR UPDATE`,[id])).rows[0];
        if(current?.state!=="pending_review"||digest(current.body??"")!==fingerprint){
          await client.query(`UPDATE ugc_comment_scan_claim SET state='obsolete',lease_until=clock_timestamp(),
            updated_at=clock_timestamp() WHERE comment_id=$1 AND lease_token=$2`,[id,claim.lease_token]);
          return {id,state:"obsolete"};
        }
        await client.query(`INSERT INTO ugc_comment_safety_scan(comment_id,body_sha256,provider,state,result)
          VALUES($1,$2,'wechat_v2',$3,$4)`,[id,fingerprint,state,response]);
        await client.query(`UPDATE ugc_comment_scan_claim SET state='completed',lease_until=clock_timestamp(),
          updated_at=clock_timestamp() WHERE comment_id=$1 AND lease_token=$2`,[id,claim.lease_token]);
        return {id,state};
      });
    }catch(error){
      const code=error instanceof DomainError?error.code:"UGC_SCAN_UNAVAILABLE";
      await transaction(this.pool,async client=>{
        const fence=(await client.query(`SELECT lease_token,attempt_count FROM ugc_comment_scan_claim
          WHERE comment_id=$1 FOR UPDATE`,[id])).rows[0];
        if(fence?.lease_token!==claim.lease_token)return;
        await client.query(`INSERT INTO ugc_comment_safety_scan(comment_id,body_sha256,provider,state,result)
          VALUES($1,$2,'wechat_v2','error',$3)`,[id,fingerprint,{error:code}]);
        await client.query(`UPDATE ugc_comment_scan_claim SET state=CASE WHEN attempt_count>=7
          THEN 'quarantined' ELSE 'pending' END,lease_until=clock_timestamp(),
          next_attempt_at=clock_timestamp()+LEAST(1800,5*POWER(2,attempt_count-1)) * interval '1 second',
          last_error=$3,updated_at=clock_timestamp() WHERE comment_id=$1 AND lease_token=$2`,[id,claim.lease_token,code]);
      });
      return {id,state:"error"};
    }
  }

  verifyCallback(query:MessageQuery){
    if(this.config.env!=="test"||!this.config.wechat.plaintextCallbackTestOnly)
      throw new DomainError("UGC_CALLBACK_ENCRYPTION_REQUIRED","内容安全回调须使用安全模式密文",401);
    const token=this.config.wechat.messageToken;
    if(!token||typeof query.signature!=="string"||typeof query.timestamp!=="string"||typeof query.nonce!=="string"||
      !/^\d{10}$/.test(query.timestamp)||Math.abs(Date.now()/1000-Number(query.timestamp))>300||
      !query.nonce||query.nonce.length>100)
      throw new DomainError("UGC_CALLBACK_UNAUTHORIZED","内容安全回调未授权",401);
    const expected=createHash("sha1").update([token,query.timestamp,query.nonce].sort().join("")).digest("hex");
    const a=Buffer.from(query.signature),b=Buffer.from(expected);
    if(a.length!==b.length||!timingSafeEqual(a,b))throw new DomainError("UGC_CALLBACK_UNAUTHORIZED","内容安全回调签名无效",401);
  }
  verifyChallenge(query:MessageQuery&{echostr?:unknown}){
    if(typeof query.echostr!=="string")throw new DomainError("UGC_CALLBACK_UNAUTHORIZED","回调校验参数无效",401);
    if(this.config.wechat.messageAesKey)return decryptWechatMessage(query,query.echostr,{
      token:this.config.wechat.messageToken,aesKey:this.config.wechat.messageAesKey,
      appId:this.config.wechat.appId});
    this.verifyCallback(query);
    return query.echostr;
  }
  async receiveCallback(query:MessageQuery,outer:unknown){
    if(!outer||typeof outer!=="object"||Buffer.byteLength(JSON.stringify(outer))>256_000)
      throw new DomainError("UGC_CALLBACK_INVALID","内容安全回调内容无效",422);
    const envelope=outer as Record<string,unknown>;
    let body:ScanCallback;
    if(envelope.Encrypt!==undefined){
      const raw=decryptWechatMessage(query,envelope.Encrypt,{token:this.config.wechat.messageToken,
        aesKey:this.config.wechat.messageAesKey,appId:this.config.wechat.appId});
      try{body=JSON.parse(raw) as ScanCallback;}catch{throw new DomainError("UGC_CALLBACK_INVALID","内容安全回调正文无效",422);}
    }else{
      this.verifyCallback(query);
      body=outer as ScanCallback;
    }
    if(!body||typeof body!=="object"||body.Event!=="wxa_media_check"||body.appid!==this.config.wechat.appId||body.version!==2||
      typeof body.trace_id!=="string"||body.trace_id.length>200)
      throw new DomainError("UGC_CALLBACK_INVALID","内容安全回调内容无效",422);
    const inserted=await this.pool.query(`INSERT INTO ugc_safety_callback_inbox(trace_id,app_id,payload) VALUES($1,$2,$3)
      ON CONFLICT(trace_id) DO NOTHING`,[body.trace_id,body.appid,body]);
    if(!inserted.rowCount){
      const existing=(await this.pool.query(`SELECT app_id,payload=$2::jsonb AS same_payload
        FROM ugc_safety_callback_inbox WHERE trace_id=$1`,[body.trace_id,JSON.stringify(body)])).rows[0];
      if(!existing||existing.app_id!==body.appid||existing.same_payload!==true)
        throw new DomainError("UGC_CALLBACK_CONFLICT","相同扫描编号对应不同回调事实",409);
    }
    await this.applyCallback(body.trace_id);
    return "success";
  }
  private async applyCallback(traceId:string){
    await transaction(this.pool,async client=>{
      const inbox=(await client.query("SELECT * FROM ugc_safety_callback_inbox WHERE trace_id=$1 FOR UPDATE",[traceId])).rows[0];
      if(!inbox||inbox.applied_at)return;
      const scan=(await client.query("SELECT * FROM ugc_safety_scan WHERE trace_id=$1 FOR UPDATE",[traceId])).rows[0];
      if(!scan)return; // Callback arrived before the request response was persisted.
      const state=verdict(inbox.payload);
      const applied=await client.query(`UPDATE ugc_safety_scan SET state=$2,result=$3,resolved_at=now() WHERE id=$1 AND state='pending' RETURNING id`,
        [scan.id,state,inbox.payload]);
      if(applied.rowCount&&scan.media_asset_id){
        await client.query(`UPDATE ugc_media_asset a SET scan_result=$2,updated_at=now()
          WHERE a.id=$1 AND a.sha256=$3 AND a.state IN ('uploaded','scanning')
          AND $6=(SELECT id FROM ugc_safety_scan WHERE media_asset_id=a.id AND kind='image'
            ORDER BY requested_at DESC,id DESC LIMIT 1)
          AND EXISTS(SELECT 1 FROM ugc_post_media b JOIN ugc_post p ON p.id=b.post_id
            JOIN ugc_post_revision r ON r.post_id=b.post_id AND r.revision=b.revision
            WHERE b.media_asset_id=a.id AND p.id=$4 AND b.revision=$5 AND ${pendingReviewRevisionSql})`,
          [scan.media_asset_id,{verdict:state,provider:"wechat_v2",checkedAt:new Date().toISOString(),traceId},
            scan.content_sha256,scan.post_id,scan.revision,scan.id]);
      }
      await client.query("UPDATE ugc_safety_callback_inbox SET applied_at=now() WHERE trace_id=$1",[traceId]);
    });
  }
}

export function startUgcSafetyLoop(service:UgcSafetyService,baseUrl:string,onError:(error:unknown)=>void){
  let running=false;
  const tick=async()=>{if(running)return;running=true;try{await service.scanPendingBatch(baseUrl);}catch(error){onError(error);}finally{running=false;}};
  const timer=setInterval(()=>void tick(),30_000);
  void tick();
  return {stop:()=>clearInterval(timer)};
}
