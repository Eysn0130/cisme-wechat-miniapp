import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction, type DbClient } from "./db.js";
import { CommerceOrderService } from "./commerceOrders.js";
import { VerifiedPaymentInbox } from "./verifiedPaymentInbox.js";
import { WechatPayV3Client, assertPaymentQueryBinding } from "./wechatPayV3.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Attempt={id:string;order_id:string;out_trade_no:string;member_id:string;payer_openid:string;
  app_id:string;merchant_id:string;amount_cents:string;currency:string;expires_at:Date;
  state:"prepared"|"prepay_ready"|"unknown"|"closed"|"paid";prepay_id:string|null;
  request_lease_until:Date|null;request_lease_token:string|null;first_dispatch_started_at:Date|null;
  order_status:string;order_version:number;product_name:string|null};

/** Test-environment orchestration over the same signed WeChat APIv3 wire
 * contract. No route can instantiate this without an isolated loopback channel. */
export class PaymentAttemptService{
  constructor(private readonly pool:pg.Pool,private readonly orders:CommerceOrderService,
    private readonly inbox:VerifiedPaymentInbox,private readonly channel:WechatPayV3Client,
    private readonly options:{appId:string;merchantId:string;notifyUrl:string;simulation?:boolean}){}

  private async attempt(orderId:string,memberId:string):Promise<Attempt>{
    if(!UUID.test(orderId))throw new DomainError("ORDER_ID_INVALID","订单编号无效",422);
    const row=(await this.pool.query<Attempt>(`SELECT a.*,o.status AS order_status,o.version AS order_version,
      l.product_name FROM commerce_payment_attempt a JOIN commerce_order o ON o.id=a.order_id
      LEFT JOIN LATERAL (SELECT product_name FROM commerce_order_line WHERE order_id=o.id ORDER BY line_number LIMIT 1) l ON true
      WHERE a.order_id=$1 AND a.member_id=$2 AND o.transaction_source_kind='verified_commerce'`,
      [orderId,memberId])).rows[0];
    if(!row)throw new DomainError("PAYMENT_ATTEMPT_NOT_FOUND","支付意图不存在",404);
    return row;
  }

  private ready(row:Attempt){
    if(!row.prepay_id)throw new DomainError("PAYMENT_PREPAY_MISSING","预支付标识暂不可用",409);
    return {orderId:row.order_id,orderVersion:row.order_version,state:"prepay_ready" as const,
      simulation:this.options.simulation??true,expiresAt:row.expires_at.toISOString(),
      requestPayment:this.channel.miniProgramPaymentParams(row.app_id,row.prepay_id)};
  }

  private async queryAttempt(row:Attempt){
    return assertPaymentQueryBinding(await this.channel.queryByMerchantOrderNumber(row.out_trade_no),{
      appId:row.app_id,merchantId:row.merchant_id,outTradeNo:row.out_trade_no,
      totalCents:Number(row.amount_cents),currency:'CNY',payerOpenid:row.payer_openid});
  }

  private async audit(client:DbClient|pg.Pool,actor:string,action:string,orderId:string,
    before:Record<string,unknown>,after:Record<string,unknown>,traceId:string){
    await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,before_state,after_state,trace_id)
      VALUES($1,$2,'commerce_payment_attempt',$3,$4,$5,$6)`,[actor,action,orderId,before,after,traceId]);
  }

  async prepare(memberId:string|undefined,principalId:string|undefined,orderId:string,traceId:string){
    if(!memberId||!principalId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    const current=await this.attempt(orderId,memberId);
    if(current.app_id!==this.options.appId||current.merchant_id!==this.options.merchantId)
      throw new DomainError("PAYMENT_ATTEMPT_CONFIG_MISMATCH","支付意图配置不一致",409);
    if(current.order_status!=="pending_payment"||current.state==="paid"||current.state==="closed")
      throw new DomainError("PAYMENT_ORDER_NOT_PENDING","订单已不在待支付状态",409);
    if(current.expires_at<=new Date())throw new DomainError("PAYMENT_ORDER_EXPIRED","订单支付时间已结束",409);
    if(current.state==="prepay_ready")return this.ready(current);
    const claim=await transaction(this.pool,async client=>{
      const prior=(await client.query<{state:Attempt["state"]}>(`SELECT state FROM commerce_payment_attempt
        WHERE id=$1 AND state IN ('prepared','unknown')
          AND (request_lease_until IS NULL OR request_lease_until<clock_timestamp()) FOR UPDATE`,[current.id])).rows[0];
      if(!prior)return undefined;
      const next=(await client.query<Attempt>(`UPDATE commerce_payment_attempt SET state='unknown',
        request_lease_until=clock_timestamp()+interval '20 seconds',request_lease_token=gen_random_uuid(),
        updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[current.id])).rows[0];
      if(!next)throw new DomainError("PAYMENT_ATTEMPT_IN_PROGRESS","支付意图已被其他处理者接管",409);
      await this.audit(client,principalId,"commerce.payment_intent.claim",orderId,
        {state:prior.state},{state:"unknown"},traceId);
      return {next,priorState:prior.state};
    });
    if(!claim)throw new DomainError("PAYMENT_ATTEMPT_IN_PROGRESS","支付意图正在处理，请稍后刷新",409);
    const claimed=claim.next;
    try{
      // An unknown prepay may already have reached the channel. A temporary
      // missing response does not prove the original number was never sent.
      if(claim.priorState==="unknown"){
        let queried;
        try{queried=await this.queryAttempt(current);}
        catch(error){
          if(!(error instanceof DomainError&&error.code==="WECHAT_PAY_ORDER_NOT_FOUND"))throw error;
        }
        if(queried){
          if(queried.trade_state==="SUCCESS"){
            const persisted=await this.inbox.receiveQueried(this.channel,current.out_trade_no);
            await this.audit(this.pool,principalId,"commerce.payment_intent.query_verified",orderId,
              {state:"unknown"},{state:"verified_pending",inboxId:persisted.inboxId},traceId);
            return {orderId,state:"verified_pending" as const,simulation:this.options.simulation??true};
          }
          if(queried.trade_state==="CLOSED"){
            await transaction(this.pool,async client=>{
              const closed=await client.query(`UPDATE commerce_payment_attempt SET state='closed',request_lease_until=NULL,
                updated_at=clock_timestamp() WHERE id=$1 AND state='unknown'`,[current.id]);
              if(closed.rowCount)await this.audit(client,principalId,"commerce.payment_intent.channel_closed",orderId,
                {state:"unknown"},{state:"closed"},traceId);
            });
            throw new DomainError("PAYMENT_CHANNEL_CLOSED","渠道订单已关闭",409);
          }
          if(queried.trade_state!=="NOTPAY")
            throw new DomainError("PAYMENT_CHANNEL_UNRESOLVED","渠道支付状态待确认，请稍后重查",409);
        }
        if(claimed.first_dispatch_started_at)
          throw new DomainError("PAYMENT_ORIGINAL_QUERY_REQUIRED","原支付单可能已发送，须沿原号核对",409);
      }
      const marked=await transaction(this.pool,async client=>{
        const active=await client.query("SELECT 1 FROM member WHERE id=$1 AND status='active' FOR SHARE",[memberId]);
        if(!active.rowCount)throw new DomainError('MEMBER_NOT_ACTIVE','账号暂不可发起支付',403);
        // Serialize the dispatch decision with local cancellation. A stale
        // initial read must never send a new prepay after inventory is freed.
        const order=await client.query(`SELECT 1 FROM commerce_order WHERE id=$1 AND member_id=$2
          AND status='pending_payment' FOR UPDATE`,[orderId,memberId]);
        if(!order.rowCount)throw new DomainError('PAYMENT_ORDER_NOT_PENDING','订单已不在待支付状态',409);
        return client.query(`UPDATE commerce_payment_attempt SET
          first_dispatch_started_at=clock_timestamp() WHERE id=$1 AND state='unknown'
          AND request_lease_token=$2 AND first_dispatch_started_at IS NULL AND expires_at>clock_timestamp() RETURNING id`,
          [claimed.id,claimed.request_lease_token]);
      });
      if(!marked.rowCount)throw new DomainError("PAYMENT_ATTEMPT_IN_PROGRESS","支付任务已被其他处理者接管",409);
      // This committed marker precedes the HTTP request. A crashed response
      // cannot make a later caller infer that prepay was never sent.
      const prepay=await this.channel.createJsapiPrepay({appId:claimed.app_id,outTradeNo:claimed.out_trade_no,
        payerOpenid:claimed.payer_openid,totalCents:Number(claimed.amount_cents),
        description:(claimed.product_name??"CISME 商品").slice(0,127),notifyUrl:this.options.notifyUrl,
        expiresAt:claimed.expires_at});
      const saved=await transaction(this.pool,async client=>{
        const next=(await client.query<Attempt>(`UPDATE commerce_payment_attempt SET state='prepay_ready',
          prepay_id=$2,request_lease_until=NULL,updated_at=clock_timestamp()
          WHERE id=$1 AND state='unknown' AND request_lease_token=$3 RETURNING *`,
          [claimed.id,prepay.prepayId,claimed.request_lease_token])).rows[0];
        if(next)await this.audit(client,principalId,"commerce.payment_intent.prepay_ready",orderId,
          {state:"unknown"},{state:"prepay_ready"},traceId);
        return next;
      });
      if(!saved)throw new DomainError("PAYMENT_ATTEMPT_CONFLICT","支付意图状态已变化，请刷新",409);
      return this.ready({...saved,order_version:current.order_version});
    }catch(error){
      await this.pool.query(`UPDATE commerce_payment_attempt SET request_lease_until=NULL,
        updated_at=clock_timestamp() WHERE id=$1 AND state='unknown'
          AND request_lease_token=$2`,[claimed.id,claimed.request_lease_token]);
      throw error;
    }
  }

  async refresh(memberId:string|undefined,principalId:string|undefined,orderId:string,traceId:string){
    if(!memberId||!principalId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    const current=await this.attempt(orderId,memberId);
    if(current.order_status==="paid")return {orderId,state:"paid" as const,simulation:this.options.simulation??true};
    if(current.order_status!=="pending_payment")return {orderId,state:current.order_status,simulation:this.options.simulation??true};
    const queried=await this.queryAttempt(current);
    if(queried.trade_state==="SUCCESS"){
      const persisted=await this.inbox.receiveQueried(this.channel,current.out_trade_no);
      await this.audit(this.pool,principalId,"commerce.payment_intent.refresh_verified",orderId,
        {state:current.state},{state:"verified_pending",inboxId:persisted.inboxId},traceId);
      return {orderId,state:"verified_pending" as const,inboxId:persisted.inboxId,simulation:this.options.simulation??true};
    }
    return {orderId,state:String(queried.trade_state??"unknown").toLowerCase(),simulation:this.options.simulation??true};
  }

  async cancel(memberId:string|undefined,principalId:string|undefined,orderId:string,
    key:string,input:Record<string,unknown>,traceId:string){
    if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    const current=await this.attempt(orderId,memberId);
    if(current.order_status!=="pending_payment")
      throw new DomainError("ORDER_NOT_CANCELLABLE","当前订单状态不可取消",409);
    let state:string;
    try{state=String((await this.queryAttempt(current)).trade_state);}
    catch(error){
      if(error instanceof DomainError&&error.code==="WECHAT_PAY_ORDER_NOT_FOUND"&&current.state==="prepared")
        state="ORDER_NOT_EXIST";
      else throw error;
    }
    if(state==="SUCCESS"){
      await this.inbox.receiveQueried(this.channel,current.out_trade_no);
      throw new DomainError("PAYMENT_ALREADY_SUCCEEDED","渠道已确认支付，订单待更新",409);
    }
    if(state==="NOTPAY"){
      await this.channel.closeByMerchantOrderNumber(current.out_trade_no);
      state=String((await this.queryAttempt(current)).trade_state);
    }
    if(state!=="CLOSED"&&state!=="ORDER_NOT_EXIST")
      throw new DomainError("PAYMENT_CHANNEL_UNRESOLVED","渠道支付状态待确认，不释放库存",409);
    // Keep the local close and inventory release in one database transaction.
    // A failed version check leaves the channel CLOSED and the attempt retryable.
    return this.orders.cancel(memberId,principalId,orderId,key,input,traceId,undefined,
      {attemptId:current.id,channelState:state});
  }
}
