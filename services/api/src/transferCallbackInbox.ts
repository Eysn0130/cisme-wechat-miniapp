import { createHash } from "node:crypto";
import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { decodeTransferNotification } from "./wechatPayV3.js";
import { SettlementCommandService } from "./settlementCommand.js";

/** Bound callback is durable before acknowledgement. A signed original-number
 * query independently confirms amount, AppID and status before ledger entry. */
export class TransferCallbackInbox{
  constructor(private readonly pool:pg.Pool,private readonly options:{merchantId:string;
    apiV3Key:string;platformKeys:ReadonlyMap<string,string>}){}

  async receive(rawBody:Uint8Array,headers:Record<string,string|undefined>){
    const decoded=decodeTransferNotification({rawBody,headers,apiV3Key:this.options.apiV3Key,
      publicKeys:this.options.platformKeys});
    const fact=decoded.transfer,outBillNo=String(fact.out_bill_no),rawSha256=createHash("sha256")
      .update(rawBody).digest("hex");
    const request=(await this.pool.query(`SELECT id,merchant_id,payee_openid,amount_cents,
      provider_bill_no FROM commission_settlement_request WHERE out_bill_no=$1`,[outBillNo])).rows[0];
    if(!request||request.merchant_id!==this.options.merchantId||
      fact.mch_id!==request.merchant_id||fact.openid!==request.payee_openid||
      fact.transfer_amount!==Number(request.amount_cents)||
      request.provider_bill_no&&request.provider_bill_no!==fact.transfer_bill_no)
      throw new DomainError("WECHAT_TRANSFER_BINDING_INVALID","转账通知与商户单、金额或收款人不一致",422);
    const inserted=(await this.pool.query<{id:string}>(`INSERT INTO commission_transfer_callback_inbox
      (notification_id,request_id,out_bill_no,provider_bill_no,transfer_state,merchant_id,
        payee_openid,amount_cents,raw_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(notification_id) DO NOTHING RETURNING id`,
      [decoded.eventId,request.id,outBillNo,fact.transfer_bill_no,fact.state,
        fact.mch_id,fact.openid,fact.transfer_amount,rawSha256])).rows[0];
    if(!inserted){
      const prior=(await this.pool.query(`SELECT request_id,raw_sha256,transfer_state
        FROM commission_transfer_callback_inbox WHERE notification_id=$1`,[decoded.eventId])).rows[0];
      if(!prior||prior.request_id!==request.id||prior.raw_sha256!==rawSha256||
        prior.transfer_state!==fact.state)throw new DomainError("WECHAT_TRANSFER_NOTIFICATION_CONFLICT",
          "转账通知 ID 对应不同事实",409);
    }
    return {accepted:true};
  }

  async processPending(settlement:SettlementCommandService,limit=20){
    const claimed=(await this.pool.query<{id:string;request_id:string;transfer_state:string;
      provider_bill_no:string;attempts:number}>(`WITH due AS (
      SELECT id FROM commission_transfer_callback_inbox WHERE state='pending'
        AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp())
      ORDER BY next_attempt_at,id LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE commission_transfer_callback_inbox i SET lease_until=clock_timestamp()+interval '30 seconds'
      FROM due WHERE i.id=due.id RETURNING i.id,i.request_id,i.transfer_state,i.provider_bill_no,i.attempts`,
      [limit])).rows;
    const results:{id:string;state:string}[]=[];
    for(const row of claimed){
      try{
        const confirmed=await settlement.confirmCallback(row.request_id);
        if(confirmed.state!==row.transfer_state||confirmed.providerBillNo!==row.provider_bill_no){
          if(["SUCCESS","FAIL","CANCELLED"].includes(confirmed.state))
            throw new DomainError("WECHAT_TRANSFER_CALLBACK_QUERY_CONFLICT",
              "回调终态与原单查单终态冲突",409);
          throw new DomainError("WECHAT_TRANSFER_QUERY_NOT_FINAL","渠道原单仍在处理",503);
        }
        await this.pool.query(`UPDATE commission_transfer_callback_inbox SET state='applied',
          applied_at=clock_timestamp(),lease_until=NULL,last_error_code=NULL WHERE id=$1 AND state='pending'`,
          [row.id]);
        results.push({id:row.id,state:"applied"});
      }catch(error){
        const code=error instanceof DomainError&&/^[A-Z0-9_]{3,80}$/.test(error.code)?error.code:
          "CHANNEL_UNAVAILABLE";
        const count=Math.min(8,row.attempts+1),exception=count===8||
          code==="WECHAT_TRANSFER_CALLBACK_QUERY_CONFLICT";
        await this.pool.query(`UPDATE commission_transfer_callback_inbox SET
          state=CASE WHEN $2 THEN 'exception' ELSE 'pending' END,attempts=$3,
          exception_code=CASE WHEN $2 THEN $4 ELSE NULL END,last_error_code=$4,
          lease_until=NULL,next_attempt_at=clock_timestamp()+
            (LEAST(1800000,5000*POWER(2,LEAST(8,attempts)))::integer*interval '1 millisecond')
          WHERE id=$1 AND state='pending'`,[row.id,exception,count,code]);
        results.push({id:row.id,state:exception?"exception":"retry_scheduled"});
      }
    }
    return results;
  }
}
