import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction } from "./db.js";
import { CommerceOrderService } from "./commerceOrders.js";
import { VerifiedPaymentInbox } from "./verifiedPaymentInbox.js";
import { WechatPayV3Client } from "./wechatPayV3.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Attempt={id:string;order_id:string;out_trade_no:string;member_id:string;payer_openid:string;
  app_id:string;merchant_id:string;amount_cents:string;currency:string;expires_at:Date;
  state:"prepared"|"prepay_ready"|"unknown"|"closed"|"paid";prepay_id:string|null;
  request_lease_until:Date|null;order_status:string;order_version:number;product_name:string|null};

/** Test-environment orchestration over the same signed WeChat APIv3 wire
 * contract. No route can instantiate this without an isolated loopback channel. */
export class PaymentAttemptService{
  constructor(private readonly pool:pg.Pool,private readonly orders:CommerceOrderService,
    private readonly inbox:VerifiedPaymentInbox,private readonly channel:WechatPayV3Client,
    private readonly options:{appId:string;merchantId:string;notifyUrl:string}){}

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
      simulation:true,expiresAt:row.expires_at.toISOString(),
      requestPayment:this.channel.miniProgramPaymentParams(row.app_id,row.prepay_id)};
  }

  async prepare(memberId:string|undefined,orderId:string){
    if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    const current=await this.attempt(orderId,memberId);
    if(current.app_id!==this.options.appId||current.merchant_id!==this.options.merchantId)
      throw new DomainError("PAYMENT_ATTEMPT_CONFIG_MISMATCH","支付意图配置不一致",409);
    if(current.order_status!=="pending_payment"||current.state==="paid"||current.state==="closed")
      throw new DomainError("PAYMENT_ORDER_NOT_PENDING","订单已不在待支付状态",409);
    if(current.expires_at<=new Date())throw new DomainError("PAYMENT_ORDER_EXPIRED","订单支付时间已结束",409);
    if(current.state==="prepay_ready")return this.ready(current);
    const claimed=(await this.pool.query<Attempt>(`UPDATE commerce_payment_attempt SET state='unknown',
      request_lease_until=clock_timestamp()+interval '20 seconds',updated_at=clock_timestamp()
      WHERE id=$1 AND state IN ('prepared','unknown')
        AND (request_lease_until IS NULL OR request_lease_until<clock_timestamp()) RETURNING *`,[current.id])).rows[0];
    if(!claimed)throw new DomainError("PAYMENT_ATTEMPT_IN_PROGRESS","支付意图正在处理，请稍后刷新",409);
    try{
      // A crashed or timed-out prepay call must be queried by the original
      // merchant number. A missing channel order may be retried with that same
      // number; an unknown query cannot trigger a new order number.
      if(current.state==="unknown"){
        let queried;
        try{queried=await this.channel.queryByMerchantOrderNumber(current.out_trade_no);}
        catch(error){
          if(!(error instanceof DomainError&&error.code==="WECHAT_PAY_ORDER_NOT_FOUND"))throw error;
        }
        if(queried){
          if(queried.trade_state==="SUCCESS"){
            await this.inbox.receiveQueried(this.channel,current.out_trade_no);
            return {orderId,state:"verified_pending" as const,simulation:true};
          }
          if(queried.trade_state==="CLOSED"){
            await this.pool.query(`UPDATE commerce_payment_attempt SET state='closed',request_lease_until=NULL,
              updated_at=clock_timestamp() WHERE id=$1 AND state='unknown'`,[current.id]);
            throw new DomainError("PAYMENT_CHANNEL_CLOSED","渠道订单已关闭",409);
          }
          if(queried.trade_state!=="NOTPAY")
            throw new DomainError("PAYMENT_CHANNEL_UNRESOLVED","渠道支付状态待确认，请稍后重查",409);
        }
      }
      const prepay=await this.channel.createJsapiPrepay({appId:claimed.app_id,outTradeNo:claimed.out_trade_no,
        payerOpenid:claimed.payer_openid,totalCents:Number(claimed.amount_cents),
        description:(claimed.product_name??"CISME 商品").slice(0,127),notifyUrl:this.options.notifyUrl,
        expiresAt:claimed.expires_at});
      const saved=(await this.pool.query<Attempt>(`UPDATE commerce_payment_attempt SET state='prepay_ready',
        prepay_id=$2,request_lease_until=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND state='unknown' RETURNING *`,[claimed.id,prepay.prepayId])).rows[0];
      if(!saved)throw new DomainError("PAYMENT_ATTEMPT_CONFLICT","支付意图状态已变化，请刷新",409);
      return this.ready({...saved,order_version:current.order_version});
    }catch(error){
      await this.pool.query(`UPDATE commerce_payment_attempt SET request_lease_until=NULL,
        updated_at=clock_timestamp() WHERE id=$1 AND state='unknown'`,[claimed.id]);
      throw error;
    }
  }

  async refresh(memberId:string|undefined,orderId:string){
    if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    const current=await this.attempt(orderId,memberId);
    if(current.order_status==="paid")return {orderId,state:"paid" as const,simulation:true};
    if(current.order_status!=="pending_payment")return {orderId,state:current.order_status,simulation:true};
    const queried=await this.channel.queryByMerchantOrderNumber(current.out_trade_no);
    if(queried.trade_state==="SUCCESS"){
      const persisted=await this.inbox.receiveQueried(this.channel,current.out_trade_no);
      return {orderId,state:"verified_pending" as const,inboxId:persisted.inboxId,simulation:true};
    }
    return {orderId,state:String(queried.trade_state??"unknown").toLowerCase(),simulation:true};
  }

  async cancel(memberId:string|undefined,principalId:string|undefined,orderId:string,
    key:string,input:Record<string,unknown>,traceId:string){
    if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    const current=await this.attempt(orderId,memberId);
    if(current.order_status!=="pending_payment")
      throw new DomainError("ORDER_NOT_CANCELLABLE","当前订单状态不可取消",409);
    let state:string;
    try{state=String((await this.channel.queryByMerchantOrderNumber(current.out_trade_no)).trade_state);}
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
      state=String((await this.channel.queryByMerchantOrderNumber(current.out_trade_no)).trade_state);
    }
    if(state!=="CLOSED"&&state!=="ORDER_NOT_EXIST")
      throw new DomainError("PAYMENT_CHANNEL_UNRESOLVED","渠道支付状态待确认，不释放库存",409);
    // Keep the local close and inventory release in one database transaction.
    // A failed version check leaves the channel CLOSED and the attempt retryable.
    return this.orders.cancel(memberId,principalId,orderId,key,input,traceId,undefined,current.id);
  }
}
