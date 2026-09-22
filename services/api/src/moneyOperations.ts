import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction } from "./db.js";
import { AuthorityService } from "./authority.js";
import { finishPage, pageLimit, pageScope, readPageCursor } from "./keysetPage.js";
import { redriveQuarantinedMoneyInbox, type MoneyInboxKind } from "./moneyInboxRetry.js";
import { VerifiedPaymentInbox } from "./verifiedPaymentInbox.js";
import { VerifiedRefundInbox } from "./verifiedRefundInbox.js";
import { WechatPayV3Client } from "./wechatPayV3.js";
import { SettlementCommandService } from "./settlementCommand.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function id(value:string){if(!UUID.test(value))throw new DomainError("MONEY_OBJECT_ID_INVALID","资金对象编号无效",422);return value;}
function reason(value:unknown){const s=String(value??"").trim();if(Array.from(s).length<8||Array.from(s).length>300)
  throw new DomainError("MONEY_OPERATION_REASON_INVALID","请填写 8 至 300 字的核对依据",422);return s;}

/** Operational projection only; no editable balance or success override. */
export class MoneyOperationsService{
  constructor(private readonly pool:pg.Pool,private readonly authority:AuthorityService,
    private readonly channel:WechatPayV3Client,private readonly payment:VerifiedPaymentInbox,
    private readonly refund:VerifiedRefundInbox,private readonly settlement:SettlementCommandService|null){}

  async issues(actorId:string|undefined,query:{limit?:string;cursor?:string}={}){
    await this.authority.require(actorId,"commerce.money.reconcile");
    const limit=pageLimit(query.limit),scope=pageScope(["money-issues"]),cursor=readPageCursor(query.cursor,scope);
    const union=`SELECT id,'payment_inbox' AS kind,order_id AS related_id,
        exception_code AS code,attempt_count AS attempts,received_at AS created_at,
        quarantined_at IS NOT NULL AS can_redrive FROM commission_payment_inbox WHERE state='exception'
      UNION ALL SELECT id,'refund_inbox',refund_intent_id,exception_code,attempt_count,received_at,
        quarantined_at IS NOT NULL
        FROM commission_refund_inbox WHERE state='exception'
      UNION ALL SELECT id,'refund_submission',id,submission_last_error_code,submission_attempt_count,created_at,
        state='prepared'
        FROM commission_refund_intent WHERE submission_quarantined_at IS NOT NULL
      UNION ALL SELECT id,'transfer',id,last_error_code,attempt_count,created_at,
        quarantined_at IS NOT NULL
        FROM commission_settlement_request WHERE quarantined_at IS NOT NULL
      UNION ALL SELECT id,'transfer_callback',request_id,exception_code,attempts,received_at,
        false
        FROM commission_transfer_callback_inbox WHERE state='exception'
      UNION ALL SELECT r.id,'trade_bill',r.related_id,r.exception_code,0,b.imported_at,false
        FROM commerce_trade_bill_row r JOIN commerce_trade_bill_batch b ON b.id=r.batch_id
        WHERE r.status='exception'
      UNION ALL SELECT id,'payment_composition',order_id,'PAYMENT_COMPOSITION_CONFLICT',0,observed_at,false
        FROM commission_payment_composition_observation`;
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actorId,"commerce.money.reconcile");
      const totalCount=(await client.query<{n:number}>(`SELECT count(*)::int AS n FROM (${union}) issue`)).rows[0]?.n??0;
      const rows=(await client.query(`SELECT * FROM (${union}) issue
        WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::uuid))
        ORDER BY created_at DESC,id DESC LIMIT $3`,[cursor?.at??null,cursor?.id??null,limit+1])).rows;
      return {...finishPage(rows.map(row=>({id:row.id,cursorAt:new Date(row.created_at).toISOString(),
        kind:row.kind,relatedId:row.related_id,code:row.code??"NEEDS_REVIEW",
        attempts:Number(row.attempts),canRedrive:Boolean(row.can_redrive),
        createdAt:row.created_at})),limit,scope),totalCount};
    },"REPEATABLE READ");
  }

  async redriveInbox(actorId:string|undefined,kindInput:string,inboxId:string,input:Record<string,unknown>){
    await this.authority.require(actorId,"commerce.money.reconcile");
    const kind=kindInput as MoneyInboxKind;
    if(kind!=="payment"&&kind!=="refund")throw new DomainError("MONEY_INBOX_KIND_INVALID","资金事实类型无效",422);
    return redriveQuarantinedMoneyInbox(this.pool,kind,id(inboxId),`member:${actorId}`,
      reason(input.reason),client=>this.authority.requireWithClient(client,actorId,"commerce.money.reconcile").then(()=>{}));
  }

  async recheck(actorId:string|undefined,kind:string,objectId:string){
    await this.authority.require(actorId,"commerce.money.reconcile");
    const target=id(objectId);
    if(kind!=="payment"&&kind!=="refund"&&!(kind==="transfer"&&this.settlement))
      throw new DomainError("MONEY_RECHECK_KIND_INVALID","资金查单类型无效或未启用",422);
    const orderNumber=await transaction(this.pool,async client=>{
      const actor=await this.authority.requireWithClient(client,actorId,"commerce.money.reconcile");
      let number:string|undefined;
      if(kind==="payment"){
        const row=(await client.query<{order_number:string}>(`SELECT o.order_number FROM commerce_order o
          JOIN commerce_payment_attempt a ON a.order_id=o.id WHERE o.id=$1`,[target])).rows[0];
        if(!row)throw new DomainError("PAYMENT_ATTEMPT_NOT_FOUND","原支付意图不存在",404);
        number=row.order_number;
      }else{
        const query=kind==="refund"?"SELECT id FROM commission_refund_intent WHERE id=$1":
          "SELECT id FROM commission_settlement_request WHERE id=$1";
        if(!(await client.query(query,[target])).rowCount)
          throw new DomainError("MONEY_RECHECK_TARGET_NOT_FOUND","原资金意图不存在",404);
      }
      // Admission commits while current member/grant locks are held. A later
      // withdrawal cannot undo this admitted query; no success is asserted.
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
        VALUES($1,'commerce.money.recheck_admitted',$2,$3,'SIGNED_ORIGINAL_QUERY',
          jsonb_build_object('kind',$4::text),gen_random_uuid()::text)`,
        [`member:${actor}`,kind==="payment"?'commerce_order':kind==="refund"?'commission_refund_intent':'commission_settlement_request',target,kind]);
      return number;
    });
    // Never perform channel I/O inside the automatically retried transaction.
    // Existing inboxes still verify bindings and own all durable money facts.
    if(kind==="payment")return this.payment.receiveQueried(this.channel,orderNumber!);
    if(kind==="refund")return this.refund.receiveQueried(this.channel,target);
    return this.settlement!.confirmCallback(target);
  }
}
