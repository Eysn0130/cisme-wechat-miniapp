import { createHash } from "node:crypto";
import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction } from "./db.js";
import { enqueue } from "./outbox.js";
import { assertPaymentBinding, decodePaymentNotification, type PaymentTransaction, WechatPayV3Client } from "./wechatPayV3.js";
import { claimDueMoneyInbox, recordMoneyInboxFailure } from "./moneyInboxRetry.js";

const orderPattern=/^CM[0-9]{8}[A-Z0-9]{12}$/;
const safeMoney=(value:unknown)=>{
  const amount=Number(value);
  if(!Number.isSafeInteger(amount)||amount<0||amount>9_900_000_000)
    throw new DomainError("PAYMENT_AMOUNT_INVALID","支付金额不在支持范围内",422);
  return amount;
};

/** A signed callback or a separately signed original-order query may create a
 * durable payment fact. Neither the client result nor a current identity read
 * can do so. */
export class VerifiedPaymentInbox {
  constructor(private readonly pool:pg.Pool,private readonly binding:{appId:string;merchantId:string;apiV3Key:string;
    platformKeys:ReadonlyMap<string,string>}){}

  async receive(rawBody:Uint8Array,headers:Record<string,string|undefined>,now=new Date()){
    const decoded=decodePaymentNotification({rawBody,headers,publicKeys:this.binding.platformKeys,
      apiV3Key:this.binding.apiV3Key,now});
    return this.persistTransaction(decoded.transaction,decoded.eventId,
      createHash("sha256").update(rawBody).digest("hex"));
  }

  async receiveQueried(client:WechatPayV3Client,outTradeNo:string){
    const {transaction,rawSha256}=await client.queryByMerchantOrderNumberWithEvidence(outTradeNo);
    if(transaction.out_trade_no!==outTradeNo)
      throw new DomainError("PAYMENT_QUERY_ORDER_MISMATCH","查单结果与原商户订单号不一致",409);
    if(typeof transaction.transaction_id!=="string"||!transaction.transaction_id)
      throw new DomainError("PAYMENT_QUERY_UNPAID","原商户订单尚未确认支付",409);
    return this.persistTransaction(transaction,`query:${transaction.transaction_id}`,rawSha256);
  }

  private async persistTransaction(transaction:PaymentTransaction,eventId:string,rawHash:string){
    const orderNumber=transaction.out_trade_no;
    if(typeof orderNumber!=="string"||!orderPattern.test(orderNumber))
      throw new DomainError("PAYMENT_ORDER_UNMATCHED","微信支付订单号未匹配",422);
    const row=(await this.pool.query(`SELECT o.id,o.order_number,o.total_cents,o.member_id,
      o.source_quote_id,o.pricing_rule_version AS order_pricing_rule_version,
      a.payer_openid,a.app_id,a.merchant_id,a.amount_cents,a.currency,a.expires_at,
      a.quote_id,a.pricing_rule_version,a.quote_price_version,q.price_version AS current_quote_price_version
      FROM commerce_order o JOIN commerce_payment_attempt a ON a.order_id=o.id
      JOIN commerce_checkout_quote q ON q.id=a.quote_id
      WHERE o.order_number=$1 AND o.transaction_source_kind='verified_commerce'`,[orderNumber])).rows[0];
    if(!row||row.app_id!==this.binding.appId||row.merchant_id!==this.binding.merchantId||
      row.amount_cents===null||row.quote_id===null||row.payer_openid===null)
      throw new DomainError("PAYMENT_ORDER_UNMATCHED","微信支付订单或支付意图未匹配",422);
    if(row.quote_id!==row.source_quote_id||row.pricing_rule_version!==row.order_pricing_rule_version||
      row.quote_price_version!==row.current_quote_price_version||row.currency!=="CNY"||
      safeMoney(row.amount_cents)!==safeMoney(row.total_cents))
      throw new DomainError("PAYMENT_INTENT_DRIFT","支付意图与订单快照不一致",409);
    const verified=assertPaymentBinding(transaction,{appId:this.binding.appId,
      merchantId:this.binding.merchantId,outTradeNo:row.order_number,totalCents:safeMoney(row.amount_cents),
      currency:"CNY",payerOpenid:row.payer_openid});
    const inserted=await this.pool.query<{id:string}>(`INSERT INTO commission_payment_inbox(
      notification_id,provider_transaction_id,order_id,app_id,merchant_id,amount_cents,currency,verified_paid_at,raw_sha256,
      payer_total_cents,composition_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
      [eventId,verified.providerTransactionId,row.id,verified.appId,verified.merchantId,
        verified.totalCents,verified.currency,verified.paidAt,rawHash,
        verified.payerTotalCents,verified.compositionStatus]);
    let id=inserted.rows[0]?.id;
    if(!id){
      const existing=(await this.pool.query(`SELECT id,notification_id,provider_transaction_id,order_id,app_id,
        merchant_id,amount_cents,currency,verified_paid_at,raw_sha256,payer_total_cents,composition_status
        FROM commission_payment_inbox
        WHERE notification_id=$1 OR provider_transaction_id=$2`,[eventId,verified.providerTransactionId])).rows[0];
      if(!existing||existing.provider_transaction_id!==verified.providerTransactionId||existing.order_id!==row.id||
        existing.app_id!==verified.appId||existing.merchant_id!==verified.merchantId||
        safeMoney(existing.amount_cents)!==verified.totalCents||existing.currency!==verified.currency||
        new Date(existing.verified_paid_at).toISOString()!==verified.paidAt||
        (existing.notification_id===eventId&&existing.raw_sha256!==rawHash))
        throw new DomainError("PAYMENT_EVENT_CONFLICT","微信支付通知与已收事实冲突",409);
      const differentComposition=(existing.payer_total_cents===null?null:safeMoney(existing.payer_total_cents))
        !==verified.payerTotalCents||existing.composition_status!==verified.compositionStatus;
      if(differentComposition){
        // A signed original-order query may omit payer_total while a later
        // signed callback provides it. Never overwrite the first fact or
        // silently apply stock/commission: retain the second raw observation
        // for manual resolution under the same provider transaction ID.
        const observed=await this.pool.query<{id:string}>(`INSERT INTO commission_payment_composition_observation
          (notification_id,provider_transaction_id,order_id,raw_sha256,payer_total_cents,composition_status)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(notification_id) DO NOTHING RETURNING id`,
          [eventId,verified.providerTransactionId,row.id,rawHash,verified.payerTotalCents,verified.compositionStatus]);
        if(!observed.rows[0]){
          const prior=(await this.pool.query<{raw_sha256:string;provider_transaction_id:string;order_id:string}>(
            `SELECT raw_sha256,provider_transaction_id,order_id FROM commission_payment_composition_observation
             WHERE notification_id=$1`,[eventId])).rows[0];
          if(!prior||prior.raw_sha256!==rawHash||prior.provider_transaction_id!==verified.providerTransactionId||
            prior.order_id!==row.id)throw new DomainError("PAYMENT_EVENT_CONFLICT","支付补充事实与已有通知冲突",409);
        }else await this.pool.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,trace_id)
          VALUES('inbox:payment','commerce.payment_composition_conflict','commerce_order',$1,
            'SIGNED_FACT_REQUIRES_RECONCILIATION',$2)`,[row.id,`payment-composition:${eventId}`]);
      }
      id=existing.id;
    }
    // Return as soon as the verified fact is durable. The caller can then
    // acknowledge within WeChat's callback deadline; workers apply effects.
    const durableId=id!;
    const status=(await this.pool.query<{state:"pending"|"applied"|"exception"}>(
      "SELECT state FROM commission_payment_inbox WHERE id=$1",[durableId])).rows[0]!.state;
    return {persisted:true,inboxId:durableId,state:status};
  }

  async processPending(limit=20){
    const ids=await claimDueMoneyInbox(this.pool,"payment",limit);
    const results=[];
    for(const id of ids){
      try{results.push({id,state:await this.processOne(id)});}
      catch(error){results.push({id,state:await recordMoneyInboxFailure(this.pool,"payment",id,error)});}
    }
    return results;
  }

  async processOne(inboxId:string):Promise<"pending"|"applied"|"exception">{
    return transaction(this.pool,async client=>{
      const fact=(await client.query(`SELECT * FROM commission_payment_inbox WHERE id=$1 FOR UPDATE`,[inboxId])).rows[0];
      if(!fact)throw new DomainError("PAYMENT_FACT_NOT_FOUND","支付事实不存在",404);
      if(fact.state!=="pending")return fact.state;
      const order=(await client.query(`SELECT * FROM commerce_order WHERE id=$1 FOR UPDATE`,[fact.order_id])).rows[0];
      const exception=async(code:string)=>{
        await client.query(`UPDATE commission_payment_inbox SET state='exception',exception_code=$2,lease_until=NULL WHERE id=$1`,[inboxId,code]);
        await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,trace_id)
          VALUES('worker:payment-inbox','commerce.payment_exception','commerce_order',$1,$2,$3)`,
          [fact.order_id,code,`payment-inbox:${inboxId}`]);
        return "exception" as const;
      };
      if(!order||order.transaction_source_kind!=="verified_commerce")return exception("ORDER_SOURCE_NOT_PAYABLE");
      if(fact.composition_status!=="full_cash"||safeMoney(fact.payer_total_cents)!==safeMoney(fact.amount_cents))
        return exception("PAYMENT_COMPOSITION_UNSUPPORTED");
      const attempt=(await client.query(`SELECT * FROM commerce_payment_attempt WHERE order_id=$1 FOR UPDATE`,[order.id])).rows[0];
      if(!attempt||attempt.out_trade_no!==order.order_number||attempt.member_id!==order.member_id||
        attempt.app_id!==fact.app_id||attempt.merchant_id!==fact.merchant_id||
        safeMoney(attempt.amount_cents)!==safeMoney(fact.amount_cents)||
        attempt.quote_id!==order.source_quote_id||attempt.pricing_rule_version!==order.pricing_rule_version)
        return exception("PAYMENT_ATTEMPT_MISMATCH");
      if(attempt.state==="closed")return exception("PAYMENT_CLOSED_CHANNEL_CONFLICT");
      if(order.status!=="pending_payment")return exception("ORDER_ALREADY_TERMINAL");
      const paidAt=new Date(fact.verified_paid_at);
      // WeChat timestamps are seconds; the DB order timestamp has milliseconds.
      if(paidAt.getTime()<Math.floor(new Date(order.created_at).getTime()/1000)*1000||
        paidAt>new Date(order.expires_at))return exception("PAYMENT_OUTSIDE_ORDER_WINDOW");
      const reservations=await client.query(`SELECT * FROM commerce_inventory_reservation WHERE order_id=$1 FOR UPDATE`,[order.id]);
      if(!reservations.rowCount||reservations.rows.some(row=>row.status!=="active"))return exception("RESERVATION_NOT_ACTIVE");
      const snapshot=(await client.query(`SELECT * FROM commission_order_snapshot WHERE order_id=$1`,[order.id])).rows[0];
      if(snapshot&&snapshot.source_kind!=="verified_commerce")return exception("SYNTHETIC_COMMISSION_SNAPSHOT");
      const line=(await client.query(`SELECT COALESCE(sum(line_total_cents),0)::text AS merchandise_cents,
        count(*)::int AS line_count FROM commerce_order_line WHERE order_id=$1`,[order.id])).rows[0];
      const merchandise=safeMoney(line.merchandise_cents);
      if(!line.line_count||merchandise!==safeMoney(order.subtotal_cents)-safeMoney(order.member_discount_cents)||
        merchandise+safeMoney(order.shipping_cents)!==safeMoney(fact.amount_cents))
        return exception("ORDER_CASH_LINES_MISMATCH");
      if(snapshot&&(snapshot.buyer_member_id!==order.member_id||
        safeMoney(snapshot.cash_merchandise_cents)>merchandise))
        return exception("COMMISSION_SNAPSHOT_MISMATCH");
      for(const reservation of reservations.rows){
        const stock=await client.query(`UPDATE catalog_inventory_level SET
          stock_on_hand=stock_on_hand-$2,reserved_quantity=reserved_quantity-$2,version=version+1,
          updated_by='worker:payment-inbox',updated_at=now()
          WHERE sku_id=$1 AND stock_on_hand>=$2 AND reserved_quantity>=$2 RETURNING sku_id`,
          [reservation.sku_id,reservation.quantity]);
        if(!stock.rowCount)throw new DomainError("PAYMENT_RESERVATION_MISMATCH","库存预留尚需人工核对",409);
        await client.query(`UPDATE commerce_inventory_reservation SET status='consumed',consumed_at=now()
          WHERE order_id=$1 AND sku_id=$2`,[order.id,reservation.sku_id]);
      }
      const updated=(await client.query(`UPDATE commerce_order SET status='paid',paid_at=$2,
        terminal_reason='WECHAT_PAY_VERIFIED',version=version+1,updated_at=now() WHERE id=$1 RETURNING version`,
        [order.id,paidAt])).rows[0];
      await client.query(`INSERT INTO commerce_order_transition(order_id,from_status,to_status,reason_code,
        actor_principal_id,order_version,occurred_at) VALUES($1,'pending_payment','paid','WECHAT_PAY_VERIFIED',
        'worker:payment-inbox',$2,now())`,[order.id,updated.version]);
      await client.query(`UPDATE commission_payment_inbox SET state='applied',applied_at=now(),lease_until=NULL WHERE id=$1`,[inboxId]);
      await client.query(`UPDATE commerce_payment_attempt SET state='paid',request_lease_until=NULL,
        updated_at=now() WHERE id=$1`,[attempt.id]);
      if(snapshot){
        const base=BigInt(snapshot.cash_merchandise_cents),rate=BigInt(snapshot.basis_points);
        const commission=(base*rate+5000n)/10000n;
        if(commission>0n)await client.query(`INSERT INTO commission_ledger_entry(order_id,referrer_member_id,
          event_key,kind,amount_cents,source_fact_id,actor_principal_id)
          VALUES($1,$2,$3,'accrual',$4,$5,'worker:payment-inbox')`,
          [order.id,snapshot.referrer_member_id,`wechat-pay:${fact.provider_transaction_id}`,commission.toString(),inboxId]);
      }
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        before_state,after_state,trace_id) VALUES('worker:payment-inbox','commerce.payment_applied',
        'commerce_order',$1,'WECHAT_PAY_VERIFIED',$2,$3,$4)`,
        [order.id,{status:order.status,version:order.version},{status:"paid",version:updated.version},`payment-inbox:${inboxId}`]);
      await enqueue(client,{eventType:"commerce.order.paid.v1",aggregateType:"commerce_order",
        aggregateId:order.id,aggregateVersion:updated.version,businessKey:`commerce-order:${order.id}:v${updated.version}`,
        payload:{orderId:order.id,status:"paid",currency:"CNY",totalCents:safeMoney(order.total_cents)},occurredAt:paidAt});
      return "applied";
    });
  }
}
