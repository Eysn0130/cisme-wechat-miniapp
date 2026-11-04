import {createHash, randomUUID} from 'node:crypto';
import type pg from 'pg';
import {UgcSafetyService} from '../../services/api/src/ugcSafety';
import type {AppConfig} from '@cisme/config';
import type {ObjectStorage} from '../../services/api/src/storage';

// Synthetic external provider only; the API, revision guards, scans and
// publication service run against the owned disposable database and storage.
export const directSafetyEnv = {WECHAT_APP_ID:'wx-direct-fixture',WECHAT_APP_SECRET:'synthetic-secret',
  WECHAT_MESSAGE_TOKEN:'direct-fixture-callback',WECHAT_MESSAGE_PLAINTEXT_TEST_ONLY:'true',
  UGC_SCAN_BASE_URL:'https://scan.synthetic.invalid'};
export const safeProvider:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));
  if(url.origin!=='https://api.weixin.qq.com')throw new Error('UNEXPECTED_SYNTHETIC_PROVIDER_ORIGIN');
  const body=url.pathname==='/cgi-bin/token'?{access_token:'synthetic-token',expires_in:7200}:
    url.pathname==='/wxa/msg_sec_check'?{errcode:0,trace_id:randomUUID(),result:{suggest:'pass'}}:
    url.pathname==='/wxa/media_check_async'?{errcode:0,trace_id:randomUUID()}:null;
  if(!body||init?.redirect!=='error')throw new Error('UNEXPECTED_SYNTHETIC_PROVIDER_CALL');
  return new Response(JSON.stringify(body),{status:200});
};
export async function bindSafetyIdentity(pool:pg.Pool,memberId:string){
  await pool.query(`INSERT INTO wechat_identity(member_id,provider,app_id,openid,adapter)
    VALUES($1,'wechat_miniprogram',$2,$3,'wechat') ON CONFLICT DO NOTHING`,
    [memberId,directSafetyEnv.WECHAT_APP_ID,'synthetic-direct-'+memberId]);
}
export async function completeSafeImages(pool:pg.Pool,config:AppConfig,storage:ObjectStorage,postId:string,suggest="pass"){
  const scans=await pool.query(`SELECT s.trace_id FROM ugc_safety_scan s JOIN ugc_post p ON p.id=s.post_id
    WHERE s.post_id=$1 AND s.revision=p.current_revision AND s.kind='image' AND s.state='pending'`,[postId]);
  const safety=new UgcSafetyService(pool,config,storage,safeProvider);
  for(const row of scans.rows){
    const timestamp=String(Math.floor(Date.now()/1000)),nonce=randomUUID();
    const signature=createHash('sha1').update([directSafetyEnv.WECHAT_MESSAGE_TOKEN,timestamp,nonce].sort().join('')).digest('hex');
    await safety.receiveCallback({timestamp,nonce,signature},{Event:'wxa_media_check',appid:directSafetyEnv.WECHAT_APP_ID,
      version:2,trace_id:row.trace_id,errcode:0,result:{suggest,label:100}});
  }
}
