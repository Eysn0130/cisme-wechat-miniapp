import { createHash } from "node:crypto";
import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction } from "./db.js";
import { enqueue } from "./outbox.js";
import { assertPaymentBinding, decodePaymentNotification } from "./wechatPayV3.js";

const orderPattern=/^CM[0-9]{8}[A-Z0-9]{12}$/;
const safeMoney=(value:unknown)=>{
  const amount=Number(value);
  if(!Number.isSafeInteger(amount)||amount<0||amount>9_900_000_000)
    throw new DomainError("PAYMENT_AMOUNT_INVALID","支付金额不在支持范围内",422);
  return amount;
};

/** Internal PAY-MAKE inbox. It is deliberately not mounted as a public route:
 * the current synthetic-only checkout cannot obtain a WeChat prepay order. */
export class VerifiedPaymentInbox {
  constructor(private readonly pool:pg.Pool,private readonly binding:{appId:string;merchantId:string;apiV3Key:string;
    platformKeys:ReadonlyMap<string,string>}){}

  async receive(rawBody:Uint8Array,headers:Record<string,string|undefined>,now=new Date()){
    const decoded=decodePaymentNotification({rawBody,headers,publicKeys:this.binding.platformKeys,
      apiV3Key:this.binding.apiV3Key,now});
    const orderNumber=decoded.transaction.out_trade_no;
    if(typeof orderNumber!=="string"||!orderPattern.test(orderNumber))
      throw new DomainError("PAYMENT_ORDER_UNMATCHED","微信支付订单号未匹配",422);
    const row=(await this.pool.query(`SELECT o.id,o.order_number,o.total_cents,o.member_id,i.openid
      FROM commerce_order o LEFT JOIN LATERAL (
        SELECT openid FROM wechat_identity WHERE member_id=o.member_id AND provider='wechat_miniprogram'
          AND app_id=$2 ORDER BY created_at DESC LIMIT 1) i ON true
      WHERE o.order_number=$1`,[orderNumber,this.binding.appId])).rows[0];
    if(!row||!row.openid)throw new DomainError("PAYMENT_ORDER_UNMATCHED","微信支付订单或付款身份未匹配",422);
    const verified=assertPaymentBinding(decoded.transaction,{appId:this.binding.appId,
      merchantId:this.binding.merchantId,outTradeNo:row.order_number,totalCents:safeMoney(row.total_cents),
      currency:"CNY",payerOpenid:row.openid});
    const rawHash=createHash("sha256").update(rawBody).digest("hex");
    const inserted=await this.pool.query<{id:string}>(`INSERT INTO commission_payment_inbox(
      notification_id,provider_transaction_id,order_id,app_id,merchant_id,amount_cents,currency,verified_paid_at,raw_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
      [decoded.eventId,verified.providerTransactionId,row.id,verified.appId,verified.merchantId,
        verified.totalCents,verified.currency,verified.paidAt,rawHash]);
    let id=inserted.rows[0]?.id;
    if(!id){
      const existing=(await this.pool.query(`SELECT id,notification_id,provider_transaction_id,order_id,app_id,
        merchant_id,amount_cents,currency,verified_paid_at,raw_sha256 FROM commission_payment_inbox
        WHERE notification_id=$1 OR provider_transaction_id=$2`,[decoded.eventId,verified.providerTransactionId])).rows[0];
      if(!existing||existing.provider_transaction_id!==verified.providerTransactionId||existing.order_id!==row.id||
        existing.app_id!==verified.appId||existing.merchant_id!==verified.merchantId||
        safeMoney(existing.amount_cents)!==verified.totalCents||existing.currency!==verified.currency||
        new Date(existing.verified_paid_at).toISOString()!==verified.paidAt||
        (existing.notification_id===decoded.eventId&&existing.raw_sha256!==rawHash))
        throw new DomainError("PAYMENT_EVENT_CONFLICT","微信支付通知与已收事实冲突",409);
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
    const rows=await this.pool.query<{id:string}>(`SELECT id FROM commission_payment_inbox WHERE state='pending'
      ORDER BY received_at,id LIMIT $1`,[Math.max(1,Math.min(limit,100))]);
    const results=[];
    for(const row of rows.rows){
      try{results.push({id:row.id,state:await this.processOne(row.id)});}
      catch{results.push({id:row.id,state:"pending" as const});}
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
        await client.query(`UPDATE commission_payment_inbox SET state='exception',exception_code=$2 WHERE id=$1`,[inboxId,code]);
        await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,trace_id)
          VALUES('worker:payment-inbox','commerce.payment_exception','commerce_order',$1,$2,$3)`,
          [fact.order_id,code,`payment-inbox:${inboxId}`]);
        return "exception" as const;
      };
      if(!order||order.transaction_source_kind!=="verified_commerce")return exception("ORDER_SOURCE_NOT_PAYABLE");
      if(order.status!=="pending_payment")return exception("ORDER_ALREADY_TERMINAL");
      const paidAt=new Date(fact.verified_paid_at);
      if(paidAt<new Date(order.created_at)||paidAt>new Date(order.expires_at))return exception("PAYMENT_OUTSIDE_ORDER_WINDOW");
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
      await client.query(`UPDATE commission_payment_inbox SET state='applied',applied_at=now() WHERE id=$1`,[inboxId]);
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
