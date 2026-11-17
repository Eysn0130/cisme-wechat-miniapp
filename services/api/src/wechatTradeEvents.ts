import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {DomainError} from '@cisme/domain';
import {transaction,type DbClient} from './db.js';
import type {WechatTradeAccountClient} from './wechatTradeAccount.js';
import type {ShippingBinding,WechatOrderShippingClient} from './wechatOrderShipping.js';

export const WECHAT_TRADE_EVENTS=new Set(['wxa_trade_controlled','trade_manage_remind_access_api','trade_manage_remind_shipping','trade_manage_order_settlement']);
const invalid=():never=>{throw new DomainError('WECHAT_TRADE_NOTICE_INVALID','微信交易通知无效',422);};
export function tradeNotice(value:unknown,appId:string){
  if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
  const v=value as Record<string,unknown>;
  if(v.MsgType!=='event'||typeof v.Event!=='string'||!WECHAT_TRADE_EVENTS.has(v.Event)
    ||v.appid!==undefined&&v.appid!==appId||typeof v.CreateTime!=='number'||!Number.isSafeInteger(v.CreateTime)||v.CreateTime<1||v.CreateTime>Math.floor(Date.now()/1000)+300)return invalid();
  const payload:Record<string,string|number>={Event:v.Event,CreateTime:v.CreateTime};
  const orderEvent=['trade_manage_remind_shipping','trade_manage_order_settlement'].includes(v.Event);
  for(const name of ['transaction_id','merchant_id','merchant_trade_no'] as const){
    if(!orderEvent)continue;
    const field=v[name];if(typeof field!=='string'||!field||field.length>64||!/^[-A-Za-z0-9_*]+$/.test(field))return invalid();payload[name]=field;
  }
  if(orderEvent&&(!/^\d{6,20}$/.test(String(payload.merchant_id))||!/^CM[0-9]{8}[A-Z0-9]{12}$/.test(String(payload.merchant_trade_no))||v.sub_merchant_id!==undefined&&v.sub_merchant_id!==''))return invalid();
  for(const name of ['pay_time','shipped_time','estimated_settlement_time','confirm_receive_time','settlement_time','confirm_receive_method'] as const){
    if(v[name]===undefined)continue;const field=v[name];
    if(typeof field!=='number'||!Number.isSafeInteger(field)||field<0||field>4102444800)return invalid();payload[name]=field;
  }
  // Do not persist FromUserName, OpenID, arbitrary text or encrypted envelopes.
  return {type:v.Event,at:new Date(v.CreateTime*1000),payload,
    key:createHash('sha256').update(JSON.stringify([appId,payload])).digest('hex')};
}

export class WechatTradeEvents {
 constructor(private pool:pg.Pool,private appId:string,private merchantId:string,
   private query?:Pick<WechatOrderShippingClient,'queryOrder'>,private account?:Pick<WechatTradeAccountClient,'read'>){}
 /** Caller must authenticate/decrypt the WeChat envelope before dispatch. */
 async receive(body:unknown){
  const event=tradeNotice(body,this.appId);
  await transaction(this.pool,async c=>{
   const inserted=await c.query(`INSERT INTO wechat_trade_notice(notice_key,app_id,event_type,event_created_at,payload,state,processed_at)
     VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6='recorded' THEN clock_timestamp() ELSE NULL END) ON CONFLICT DO NOTHING`,
     [event.key,this.appId,event.type,event.at,event.payload,event.payload.merchant_trade_no?'pending':'recorded']);
   if(inserted.rowCount&&event.type==='wxa_trade_controlled')await c.query(`INSERT INTO wechat_trade_account_state(app_id,restricted_at) VALUES($1,clock_timestamp())
     ON CONFLICT(app_id) DO UPDATE SET restricted_at=GREATEST(wechat_trade_account_state.restricted_at,EXCLUDED.restricted_at)`,[this.appId]);
  });
  return 'success';
 }
 async refreshAccount(){
  if(!this.account)throw new DomainError('WECHAT_TRADE_NOT_CONFIGURED','微信交易接入状态暂不可核验',503);
  const r=await this.account.read();
  await this.pool.query(`INSERT INTO wechat_trade_account_state(app_id,managed,settlement_confirmed,checked_at,order_detail_path,path_verified,checks)
   VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(app_id) DO UPDATE SET
   managed=COALESCE($2,wechat_trade_account_state.managed),settlement_confirmed=COALESCE($3,wechat_trade_account_state.settlement_confirmed),
   checked_at=$4,order_detail_path=CASE WHEN $6 THEN $5 ELSE wechat_trade_account_state.order_detail_path END,path_verified=$6,checks=$7
   WHERE wechat_trade_account_state.checked_at IS NULL OR wechat_trade_account_state.checked_at<$4`,
   [this.appId,r.managed,r.settlementConfirmed,r.observedAt,r.orderDetailPath,r.pathVerified,JSON.stringify(r.checks)]);
  return {...r,...await this.restriction()};
 }
 async restriction(){
  const row=(await this.pool.query(`SELECT managed,settlement_confirmed,restricted_at,restriction_cleared_at FROM wechat_trade_account_state WHERE app_id=$1`,[this.appId])).rows[0];
  const restricted=Boolean(row&&(row.managed===false||row.settlement_confirmed===false||row.restricted_at&&(!row.restriction_cleared_at||row.restricted_at>row.restriction_cleared_at)));
  return {restricted,reason:restricted?'wechat_trade_management':null};
 }
 async requirePaymentsAllowed(){if((await this.restriction()).restricted)throw new DomainError('WECHAT_TRADE_RESTRICTED','微信支付暂不可用，已有订单仍可查询和申请售后',503);}
 /** Explicit operator acknowledgement is required; both status booleans alone
  * are not evidence that every WeChat payment restriction has been lifted. */
 async clearControl(actor:string,reference:unknown,authorizeWithClient:(client:DbClient)=>Promise<void>){
  if(typeof reference!=='string'||reference.trim().length<8||reference.length>200)throw new DomainError('PLATFORM_CLEARANCE_REQUIRED','请填写微信解除限制的处理单号',422);
  const startedAt=(await this.pool.query<{at:string}>('SELECT clock_timestamp()::text AS at')).rows[0]!.at;
  const observed=await this.refreshAccount();
  if(observed.managed!==true||observed.settlementConfirmed!==true)throw new DomainError('WECHAT_TRADE_NOT_READY','请先完成微信交易结算管理确认',409);
  await transaction(this.pool,async c=>{
   await authorizeWithClient(c);
   // A control notification received during the read cannot be cleared.
   const changed=await c.query(`UPDATE wechat_trade_account_state SET restriction_cleared_at=clock_timestamp()
     WHERE app_id=$1 AND checked_at=$2 AND (restricted_at IS NULL OR restricted_at<$3)`,[this.appId,observed.observedAt,startedAt]);
   if(!changed.rowCount)throw new DomainError('WECHAT_TRADE_STATE_CHANGED','微信交易状态已变化，请重新核验',409);
   await c.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
     VALUES($1,'commerce.wechat_trade.clearance_recorded','wechat_app',NULL,$2,$3)`,[actor,{appId:this.appId,reference},randomUUID()]);
  });
  return this.restriction();
 }
 async runCycle(limit=4){
  if(!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('WECHAT_TRADE_QUERY_LIMIT_INVALID');
  if(!this.query)return {processed:0};let processed=0;
  for(let i=0;i<limit;i++){
   const lease=randomUUID();const row=(await this.pool.query(`UPDATE wechat_trade_notice SET lease_token=$2,lease_until=clock_timestamp()+interval '90 seconds'
     WHERE notice_key=(SELECT notice_key FROM wechat_trade_notice WHERE app_id=$1 AND state='pending' AND next_attempt_at<=clock_timestamp()
      AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY next_attempt_at,notice_key FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,[this.appId,lease])).rows[0];
   if(!row)break;
   let orderId:string|null=null;
   try{
    const p=row.payload;const paid=(await this.pool.query(`SELECT o.id,p.payer_openid,i.payer_total_cents FROM commerce_order o
      JOIN commerce_payment_attempt p ON p.order_id=o.id AND p.member_id=o.member_id
      JOIN commission_payment_inbox i ON i.order_id=o.id AND i.app_id=p.app_id AND i.merchant_id=p.merchant_id
      WHERE o.order_number=$1 AND p.out_trade_no=$1 AND p.app_id=$2 AND p.merchant_id=$3 AND i.provider_transaction_id=$4
       AND o.status='paid' AND p.state='paid' AND i.state='applied' AND i.composition_status='full_cash' AND o.transaction_source_kind='verified_commerce'
       AND p.amount_cents=i.payer_total_cents AND p.currency=i.currency`,[p.merchant_trade_no,this.appId,this.merchantId,p.transaction_id])).rows[0];
    if(!paid||p.merchant_id!==this.merchantId)throw Error('PAYMENT_NOT_MATCHED');
    orderId=paid.id;
    const binding:ShippingBinding={merchantId:this.merchantId,merchantOrderNumber:p.merchant_trade_no,transactionId:p.transaction_id,payerOpenid:paid.payer_openid,payerTotalCents:Number(paid.payer_total_cents)};
    const observed=await this.query.queryOrder(binding);
    await transaction(this.pool,async c=>{
     const updated=await c.query(`UPDATE wechat_trade_notice SET order_id=$3,state='observed',observation=$4,processed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
       WHERE notice_key=$1 AND lease_token=$2`,[row.notice_key,lease,orderId,{...observed,observedAt:new Date().toISOString()}]);
     if(updated.rowCount)await c.query(`UPDATE commerce_wechat_receipt_observation SET watch_next_attempt_at=clock_timestamp()
       WHERE order_id=$1 AND watch_state='active' AND watch_lease_token IS NULL`,[orderId]);
    });processed++;
   }catch{
    await this.pool.query(`UPDATE wechat_trade_notice SET order_id=$3,attempts=attempts+1,state=CASE WHEN attempts>=11 THEN 'manual_review' ELSE 'pending' END,
      next_attempt_at=clock_timestamp()+interval '30 minutes',lease_token=NULL,lease_until=NULL WHERE notice_key=$1 AND lease_token=$2`,[row.notice_key,lease,orderId]);
   }
  }
  return {processed};
 }
}
