import {SharingOfficerService} from './sharingOfficer.js';
import {transaction} from './db.js';
import {requireActiveMemberWithClient} from './authority.js';
import {sharingFail as fail,sharingText as text} from './sharingOfficerPolicy.js';
import {boundedWechatJson} from './boundedWechatJson.js';
import {dependencySignal} from './operationBudget.js';

export class SharingOfficerAssets {
 private cachedToken:{value:string;expiresAt:number}|null=null;
 private tokenRequest:Promise<string>|null=null;
 constructor(private service:SharingOfficerService,private config:{appId:string|null;appSecret:string|null;environment:'trial'|'release'},private fetcher:typeof fetch=fetch){}
 private async token(){
  if(this.cachedToken&&this.cachedToken.expiresAt>Date.now())return this.cachedToken.value;
  if(this.tokenRequest)return this.tokenRequest;
  if(!this.config.appId||!this.config.appSecret)fail('SHARING_WECHAT_NOT_CONFIGURED','微信分享服务尚未配置',503);
  this.tokenRequest=(async()=>{
   const r=await boundedWechatJson<{access_token?:string;expires_in?:number}>(await this.fetcher('https://api.weixin.qq.com/cgi-bin/stable_token',{
    method:'POST',headers:{'Content-Type':'application/json'},redirect:'error',signal:dependencySignal(12_000),
    body:JSON.stringify({grant_type:'client_credential',appid:this.config.appId,secret:this.config.appSecret})}));
   if(typeof r.access_token!=='string'||!r.access_token||r.access_token.length>4096||!Number.isFinite(r.expires_in)||r.expires_in!<120||r.expires_in!>7200)fail('SHARING_WECHAT_UNAVAILABLE','微信分享服务暂不可用',503);
   this.cachedToken={value:r.access_token,expiresAt:Date.now()+(r.expires_in!-120)*1000};return r.access_token;
  })();try{return await this.tokenRequest;}finally{this.tokenRequest=null;}
 }
 private async post(path:string,body:unknown,retry=true):Promise<Response>{const token=await this.token();const response=await this.fetcher(`https://api.weixin.qq.com/${path}?access_token=${encodeURIComponent(token)}`,{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:dependencySignal(12_000)});
  if(retry&&response.headers.get('content-type')?.includes('json')){
   const result=await boundedWechatJson<{errcode?:number}>(response.clone());
   if([40001,40014,42001].includes(result.errcode??0)){await response.body?.cancel();this.cachedToken=null;return this.post(path,body,false);}
  }return response;
 }
 private async access(actor:string|undefined,shareId:string){
  return transaction(this.service.pool,async client=>{
   const owner=await requireActiveMemberWithClient(client,actor);
   const row=(await client.query(`SELECT l.*,a.qr_png,a.url_link,a.url_expires_at FROM sharing_link l
    JOIN sharing_officer o ON o.member_id=l.officer_id LEFT JOIN sharing_asset a ON a.share_id=l.share_id
    JOIN catalog_product p ON p.code=l.product_code WHERE l.share_id=$1 AND l.officer_id=$2 AND o.state='active'
    AND p.publication_status='published' AND p.qualification_status='eligible'
    AND COALESCE((SELECT enabled FROM sharing_policy ORDER BY version DESC LIMIT 1),false)`,[shareId,owner])).rows[0];
   if(!row)fail('SHARING_LINK_UNAVAILABLE','该推广链接当前不可使用',404);return row;
  });
 }
 async assets(actor:string|undefined,shareInput:unknown){
  const shareId=text(shareInput,'分享编号',32,32);if(!/^[0-9a-f]{32}$/.test(shareId))fail('SHARING_LINK_UNAVAILABLE','分享编号无效',422);
  const source=await this.access(actor,shareId);let png=source.qr_png as Buffer|null,url=source.url_link as string|null,expiresAt=source.url_expires_at as Date|null;
  if(!png){
   const response=await this.post('wxa/getwxacodeunlimit',{scene:shareId,page:'pages/product/index',check_path:this.config.environment==='release',env_version:this.config.environment,width:430,auto_color:false,line_color:{r:70,g:40,b:91},is_hyaline:true});
   const reader=response.body?.getReader();if(!response.ok||!reader)fail('SHARING_CODE_UNAVAILABLE','小程序码暂未生成，请稍后重试',503);
   const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1_048_576){await reader.cancel();fail('SHARING_CODE_INVALID','微信返回的图片无效',502);}chunks.push(part.value);}}
   finally{reader.releaseLock();}
   png=Buffer.concat(chunks);
   if(!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail('SHARING_CODE_UNAVAILABLE','小程序码暂未生成，请稍后重试',503);
  }
  let urlAvailable=true;
  if(!url||!expiresAt||expiresAt.getTime()<Date.now()+60_000){
   try{
    const result=await boundedWechatJson<{url_link?:string;errcode?:number}>(await this.post('wxa/generate_urllink',{
     path:'pages/product/index',query:`id=${encodeURIComponent(source.product_code)}&officer_share=${shareId}`,env_version:this.config.environment,
     is_expire:true,expire_type:1,expire_interval:28}));
    if(result.errcode&&result.errcode!==0||typeof result.url_link!=='string'||!/^https:\/\/(?:wxaurl|wxmpurl)\.cn\/[A-Za-z0-9/?=_-]+$/.test(result.url_link))fail('SHARING_URL_UNAVAILABLE','微信分享链接暂不可用',503);
    url=result.url_link;expiresAt=new Date(Date.now()+28*86400_000-60_000);
   }catch{url=null;expiresAt=null;urlAvailable=false;}
  }
  await this.access(actor,shareId);
  await this.service.pool.query(`INSERT INTO sharing_asset(share_id,qr_png,url_link,url_expires_at) VALUES($1,$2,$3,$4)
   ON CONFLICT(share_id) DO UPDATE SET qr_png=$2,url_link=$3,url_expires_at=$4,updated_at=clock_timestamp()`,[shareId,png,url,expiresAt]);
  return {shareId,qrPngBase64:png.toString('base64'),urlLink:url,urlExpiresAt:expiresAt?.toISOString()??null,urlAvailable,
   path:`/pages/product/index?id=${encodeURIComponent(source.product_code)}&officer_share=${shareId}`};
 }
}
