import { createHash } from "node:crypto";
import type pg from "pg";
import type { AppEnvironment } from "@cisme/config";
import { DomainError } from "@cisme/domain";
import { transaction, type DbClient } from "./db.js";
import { finishPage, pageLimit, pageScope, readPageCursor } from "./keysetPage.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9._:-]{8,200}$/;
const TAX_FIXTURE="isolated-synthetic-zero-withholding-v1";
const MAX=9_900_000_000;
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Conversion={id:string;member_id:string;request_hash:string;gross_cents:string;credit_cents:string;
  tax_policy_version:string;state:"available"|"cancelled";cancel_key:string|null;cancel_hash:string|null;
  created_at:Date;cancelled_at:Date|null;available_cents?:string;other_entry_count?:number};
type Source={id:string;order_id:string;amount_cents:string};
function cents(value:unknown){const n=Number(value);if(!Number.isSafeInteger(n)||n<1||n>MAX)
  throw new DomainError("CREDIT_AMOUNT_INVALID","购物权益转换金额须为正整数分",422);return n;}
function key(value:unknown){if(typeof value!=="string"||!KEY.test(value))
  throw new DomainError("IDEMPOTENCY_KEY_INVALID","转换请求键无效",400);return value;}
function id(value:string){if(!UUID.test(value))throw new DomainError("CREDIT_CONVERSION_ID_INVALID","转换编号无效",422);return value;}

/** Called in the same transaction as a signed refund reversal, with its source
 * order locked. Historical credit is never deleted or silently reclaimed:
 * at-risk unused lots get immutable negative freeze entries, while an amount
 * no longer available for freezing is an explicit recovery exposure. */
export async function freezeCreditExposureForRefund(client:DbClient,orderId:string,refundFactId:string){
  const ledger=(await client.query<{kind:string;amount_cents:string}>(`SELECT kind,amount_cents
    FROM commission_ledger_entry WHERE order_id=$1`,[orderId])).rows;
  const sum=(...kinds:string[])=>ledger.filter(row=>kinds.includes(row.kind))
    .reduce((total,row)=>total+Number(row.amount_cents),0);
  const net=sum("accrual","refund_reversal"),paid=sum("settlement"),
    converted=sum("credit_conversion","credit_conversion_reversal");
  if(![net,paid,converted].every(Number.isSafeInteger)||net<0||paid<0||converted<0)
    throw new DomainError("CREDIT_REFUND_LEDGER_INVALID","退款来源权益账本需核对",409);
  const sources=(await client.query<{id:string;amount_cents:string;balance:string;frozen:string}>(`
    SELECT s.id,s.amount_cents,COALESCE(sum(e.amount_cents),0)::text AS balance,
      COALESCE(-sum(e.amount_cents) FILTER(WHERE e.kind='freeze'),0)::text AS frozen
    FROM commission_credit_source s JOIN commission_credit_conversion c ON c.id=s.conversion_id
    LEFT JOIN commission_credit_entry e ON e.source_id=s.id
    WHERE s.order_id=$1 AND c.state='available'
    GROUP BY s.id ORDER BY s.id DESC`,[orderId])).rows;
  const active=sources.reduce((total,row)=>total+Number(row.amount_cents),0);
  if(active!==converted||sources.some(row=>![row.amount_cents,row.balance,row.frozen]
    .every(value=>Number.isSafeInteger(Number(value))&&Number(value)>=0)))
    throw new DomainError("CREDIT_REFUND_SOURCE_DRIFT","购物权益来源与现金账本不一致",409);
  const target=Math.min(converted,Math.max(0,paid+converted-net));
  let remaining=Math.max(0,target-sources.reduce((total,row)=>total+Number(row.frozen),0));
  const initiallyRequired=remaining;
  for(const source of sources){
    const take=Math.min(remaining,Number(source.balance));
    if(!take)continue;
    await client.query(`INSERT INTO commission_credit_entry
      (source_id,event_key,kind,amount_cents,actor_principal_id)
      VALUES($1,$2,'freeze',$3,'worker:refund-inbox')`,
      [source.id,`credit-refund-freeze:${refundFactId}:${source.id}`,-take]);
    remaining-=take;
  }
  if(remaining)await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,
    reason_code,after_state,trace_id) VALUES('worker:refund-inbox','commission.credit_recovery_exposure',
    'commerce_order',$1,'CREDIT_EXPOSURE_UNCOVERED',$2,$3)`,
    [orderId,{uncoveredCents:remaining,targetFrozenCents:target},`credit-refund:${refundFactId}`]);
  return {targetFrozenCents:target,newlyFrozenCents:initiallyRequired-remaining,uncoveredCents:remaining};
}

type CheckoutAllocation={source_id:string;order_id:string;amount_cents:string;
  origin_order_id:string;reserved:string;released:string;spent:string};
async function lockOriginsForPurchase(client:DbClient,orderId:string){
  const origins=(await client.query<{order_id:string}>(`SELECT DISTINCT s.order_id
    FROM commission_credit_checkout_allocation a JOIN commission_credit_source s ON s.id=a.source_id
    WHERE a.order_id=$1 ORDER BY s.order_id`,[orderId])).rows;
  for(const origin of origins)await client.query("SELECT id FROM commerce_order WHERE id=$1 FOR UPDATE",[origin.order_id]);
}
async function allocationsForPurchase(client:DbClient,orderId:string){
  return (await client.query<CheckoutAllocation>(`SELECT a.source_id,a.order_id,a.amount_cents,
    s.order_id AS origin_order_id,
    COALESCE(-sum(e.amount_cents) FILTER(WHERE e.kind='reserve'),0)::text AS reserved,
    COALESCE(sum(e.amount_cents) FILTER(WHERE e.kind='reserve_release'),0)::text AS released,
    COALESCE(-sum(e.amount_cents) FILTER(WHERE e.kind='spend'),0)::text AS spent
    FROM commission_credit_checkout_allocation a JOIN commission_credit_source s ON s.id=a.source_id
    JOIN commission_credit_entry e ON e.source_id=a.source_id AND e.purchase_order_id=a.order_id
    WHERE a.order_id=$1 GROUP BY a.source_id,a.order_id,a.amount_cents,s.order_id
    ORDER BY a.source_id`,[orderId])).rows;
}

async function assertOriginPurchasable(client:DbClient,orderId:string){
  const disputed=(await client.query<{n:number;net:string;paid:string;converted:string}>(`SELECT
    (SELECT count(*)::int FROM commission_payment_composition_observation WHERE order_id=$1)+
    (SELECT count(*)::int FROM commerce_refund_request r LEFT JOIN commission_refund_intent i
     ON i.request_id=r.id WHERE r.order_id=$1 AND
     (r.state='requested' OR r.state='approved' AND (i.id IS NULL OR i.state IN ('prepared','abnormal')))) AS n,
    COALESCE((SELECT sum(amount_cents) FROM commission_ledger_entry WHERE order_id=$1
      AND kind IN ('accrual','refund_reversal')),0)::text AS net,
    COALESCE((SELECT sum(amount_cents) FROM commission_ledger_entry WHERE order_id=$1
      AND kind='settlement'),0)::text AS paid,
    COALESCE((SELECT sum(amount_cents) FROM commission_ledger_entry WHERE order_id=$1
      AND kind IN ('credit_conversion','credit_conversion_reversal')),0)::text AS converted`,
    [orderId])).rows[0];
  if(!disputed||disputed.n||Number(disputed.net)<Number(disputed.paid)+Number(disputed.converted))
    throw new DomainError("CREDIT_CHECKOUT_ORIGIN_DISPUTED","权益来源发生未决退款或追偿，请更换支付组成",409);
}

/** Source lots are locked against a concurrent verified refund; all other
 * conversion and checkout writers use the same member advisory lock. */
export async function reserveCreditForCheckout(client:DbClient,memberId:string,orderId:string,amount:number){
  if(amount===0)return;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`settlement-member:${memberId}`]);
  const originOrders=(await client.query<{order_id:string}>(`SELECT s.order_id FROM commission_credit_source s
    JOIN commission_credit_conversion c ON c.id=s.conversion_id
    JOIN commission_credit_entry e ON e.source_id=s.id
    WHERE c.member_id=$1 AND c.state='available'
    GROUP BY s.order_id HAVING sum(e.amount_cents)>0 ORDER BY s.order_id`,[memberId])).rows;
  if(!originOrders.length)
    throw new DomainError("CREDIT_CHECKOUT_INSUFFICIENT","购物权益可用来源不足，请重新报价",409);
  const purchasableOrigins:string[]=[];
  for(const row of originOrders){
    await client.query("SELECT id FROM commerce_order WHERE id=$1 FOR UPDATE",[row.order_id]);
    try{await assertOriginPurchasable(client,row.order_id);purchasableOrigins.push(row.order_id);}
    catch(error){if(!(error instanceof DomainError&&error.code==="CREDIT_CHECKOUT_ORIGIN_DISPUTED"))throw error;}
  }
  if(!purchasableOrigins.length)
    throw new DomainError("CREDIT_CHECKOUT_ORIGIN_DISPUTED","权益来源发生未决退款或追偿，请更换支付组成",409);
  const lots=(await client.query<{id:string;balance:string}>(`SELECT s.id,
    COALESCE(sum(e.amount_cents),0)::text AS balance FROM commission_credit_source s
    JOIN commission_credit_conversion c ON c.id=s.conversion_id
    JOIN commission_credit_entry e ON e.source_id=s.id
    WHERE c.member_id=$1 AND c.state='available' AND s.order_id=ANY($2::uuid[])
    GROUP BY s.id,c.created_at ORDER BY c.created_at,s.id`,[memberId,purchasableOrigins])).rows;
  if(lots.some(lot=>!Number.isSafeInteger(Number(lot.balance))||Number(lot.balance)<0))
    throw new DomainError("CREDIT_CHECKOUT_SOURCE_DRIFT","购物权益来源账本需核对",409);
  let remaining=amount;
  for(const lot of lots){
    if(remaining===0)break;
    const take=Math.min(remaining,Number(lot.balance));
    if(!take)continue;
    const reserved=(await client.query<{id:string}>(`INSERT INTO commission_credit_entry
      (source_id,event_key,kind,amount_cents,purchase_order_id,actor_principal_id)
      VALUES($1,$2,'reserve',$3,$4,$5) RETURNING id`,[lot.id,
        `credit-order-reserve:${orderId}:${lot.id}`,-take,orderId,`member:${memberId}`])).rows[0]!;
    await client.query(`INSERT INTO commission_credit_checkout_allocation
      (source_id,order_id,amount_cents,reserve_entry_id) VALUES($1,$2,$3,$4)`,
      [lot.id,orderId,take,reserved.id]);
    remaining-=take;
  }
  if(remaining)throw new DomainError("CREDIT_CHECKOUT_INSUFFICIENT","购物权益可用来源不足，请重新报价",409);
}

export async function consumeReservedCreditForCheckout(client:DbClient,orderId:string,expected:number){
  await lockOriginsForPurchase(client,orderId);
  const lots=await allocationsForPurchase(client,orderId);
  if(lots.reduce((n,lot)=>n+Number(lot.amount_cents),0)!==expected)
    throw new DomainError("CREDIT_CHECKOUT_ALLOCATION_DRIFT","支付组成与权益预占不一致",409);
  for(const lot of lots){
    const amount=Number(lot.amount_cents);
    if(Number(lot.reserved)!==amount||Number(lot.released)!==0||Number(lot.spent)!==0)
      throw new DomainError("CREDIT_CHECKOUT_RESERVATION_DRIFT","权益预占状态需核对",409);
    // Once the channel has signed a cash success, a later dispute on an
    // already-reserved origin cannot strand the paid purchase indefinitely.
    // The refund worker freezes unused origin credit and records any uncovered
    // exposure; no *new* checkout may reserve the disputed source.
    let originDisputed=false;
    try{await assertOriginPurchasable(client,lot.origin_order_id);}
    catch(error){
      if(!(error instanceof DomainError&&error.code==="CREDIT_CHECKOUT_ORIGIN_DISPUTED"))throw error;
      originDisputed=true;
    }
    if(originDisputed)await client.query(`INSERT INTO audit_log(principal_id,action,object_type,
      object_id,reason_code,after_state,trace_id) VALUES('worker:payment-inbox',
      'commission.credit_reserved_origin_disputed','commerce_order',$1,
      'RESERVED_CREDIT_SOURCE_REQUIRES_RECOVERY_REVIEW',$2,$3)`,[orderId,
        {originOrderId:lot.origin_order_id,sourceId:lot.source_id,amountCents:amount},
        `credit-order-origin-risk:${orderId}:${lot.source_id}`]);
    await client.query(`INSERT INTO commission_credit_entry
      (source_id,event_key,kind,amount_cents,purchase_order_id,actor_principal_id)
      VALUES($1,$2,'reserve_release',$3,$4,'worker:payment-inbox')`,[lot.source_id,
        `credit-order-consume-release:${orderId}:${lot.source_id}`,amount,orderId]);
    await client.query(`INSERT INTO commission_credit_entry
      (source_id,event_key,kind,amount_cents,purchase_order_id,actor_principal_id)
      VALUES($1,$2,'spend',$3,$4,'worker:payment-inbox')`,[lot.source_id,
        `credit-order-spend:${orderId}:${lot.source_id}`,-amount,orderId]);
  }
}

export async function releaseReservedCreditForCheckout(client:DbClient,orderId:string,expected:number,actor:string){
  await lockOriginsForPurchase(client,orderId);
  const lots=await allocationsForPurchase(client,orderId);
  if(lots.reduce((n,lot)=>n+Number(lot.amount_cents),0)!==expected)
    throw new DomainError("CREDIT_CHECKOUT_ALLOCATION_DRIFT","订单权益预占不完整",409);
  for(const lot of lots){
    const amount=Number(lot.amount_cents);
    if(Number(lot.reserved)!==amount||Number(lot.released)!==0||Number(lot.spent)!==0)
      throw new DomainError("CREDIT_CHECKOUT_RESERVATION_DRIFT","权益预占状态需核对",409);
    await client.query(`INSERT INTO commission_credit_entry
      (source_id,event_key,kind,amount_cents,purchase_order_id,actor_principal_id)
      VALUES($1,$2,'reserve_release',$3,$4,$5)`,[lot.source_id,
        `credit-order-release:${orderId}:${lot.source_id}`,amount,orderId,actor]);
  }
  for(const origin of [...new Set(lots.map(lot=>lot.origin_order_id))].sort()){
    await freezeCreditExposureForRefund(client,origin,`release-${orderId}`);
  }
}

/** No top-up, transfer or production path. This commits a 1:1 source-linked
 * cash-commission debit and credit issue atomically. Tax=0 is a *synthetic*
 * fixture, never an exemption determination or a live conversion policy. */
export class ShoppingCreditService{
  constructor(private readonly pool:pg.Pool,private readonly environment:AppEnvironment){}
  private gate(){if(this.environment!=="test")throw new DomainError("SHOPPING_CREDIT_LIVE_DISABLED",
    "购物权益真实转换与税务规则尚未批准",503);}
  private view(row:Conversion){return {id:row.id,amountCents:Number(row.credit_cents),grossCents:Number(row.gross_cents),
    withholdingCents:0,taxPolicyVersion:row.tax_policy_version,state:row.state,
    availableCents:row.state==="cancelled"?0:Number(row.available_cents??row.credit_cents),
    cancellable:row.state==="available"&&(row.other_entry_count??0)===0,
    createdAt:row.created_at,cancelledAt:row.cancelled_at};}

  async listMine(memberId:string|undefined,query:{limit?:string;cursor?:string}={}){
    if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    const limit=pageLimit(query.limit),scope=pageScope(["credit-conversion",memberId]),
      cursor=readPageCursor(query.cursor,scope);
    return transaction(this.pool,async client=>{
    const count=(await client.query<{n:number}>(`SELECT count(*)::int AS n
      FROM commission_credit_conversion WHERE member_id=$1`,[memberId])).rows[0]?.n??0;
    const rows=(await client.query<Conversion>(`SELECT c.*,
      COALESCE((SELECT sum(e.amount_cents) FROM commission_credit_source s
        JOIN commission_credit_entry e ON e.source_id=s.id WHERE s.conversion_id=c.id),0)::text AS available_cents,
      (SELECT count(*)::int FROM commission_credit_source s
        JOIN commission_credit_entry e ON e.source_id=s.id WHERE s.conversion_id=c.id
          AND e.kind<>'issue') AS other_entry_count
      FROM commission_credit_conversion c
      WHERE c.member_id=$1 AND ($2::timestamptz IS NULL OR (c.created_at,c.id)<($2::timestamptz,$3::uuid))
      ORDER BY c.created_at DESC,c.id DESC LIMIT $4`,[memberId,cursor?.at??null,cursor?.id??null,limit+1])).rows;
    const available=(await client.query<{amount_cents:string;checkout_cents:string}>(`WITH balance AS (
      SELECT s.order_id,sum(e.amount_cents) AS amount_cents
      FROM commission_credit_source s JOIN commission_credit_conversion c ON c.id=s.conversion_id
      JOIN commission_credit_entry e ON e.source_id=s.id
      WHERE c.member_id=$1 AND c.state='available' GROUP BY s.order_id
    ), eligible AS (
      SELECT b.*,
        NOT EXISTS(SELECT 1 FROM commission_payment_composition_observation x WHERE x.order_id=b.order_id)
        AND NOT EXISTS(SELECT 1 FROM commerce_refund_request r LEFT JOIN commission_refund_intent i
          ON i.request_id=r.id WHERE r.order_id=b.order_id AND
          (r.state='requested' OR r.state='approved' AND
            (i.id IS NULL OR i.state IN ('prepared','abnormal'))))
        AND COALESCE((SELECT sum(amount_cents) FROM commission_ledger_entry e WHERE e.order_id=b.order_id
          AND e.kind IN ('accrual','refund_reversal')),0)>=
          COALESCE((SELECT sum(amount_cents) FROM commission_ledger_entry e WHERE e.order_id=b.order_id
            AND e.kind IN ('settlement','credit_conversion','credit_conversion_reversal')),0)
        AS can_checkout FROM balance b
    ) SELECT COALESCE(sum(amount_cents),0)::text AS amount_cents,
      COALESCE(sum(amount_cents) FILTER (WHERE can_checkout AND amount_cents>0),0)::text AS checkout_cents
      FROM eligible`,[memberId])).rows[0]!;
    return {...finishPage(rows.map(row=>({...this.view(row),cancellable:this.environment==="test"&&this.view(row).cancellable,cursorAt:row.created_at.toISOString()})),limit,scope),
      totalCount:count,availableCents:Number(available.amount_cents),
      checkoutAvailableCents:this.environment==="test"?Number(available.checkout_cents):0,spendable:this.environment==="test"&&Number(available.checkout_cents)>0,
      redemptionStatus:"ISOLATED_TEST_ONLY" as const};
    },"REPEATABLE READ");
  }

  async convert(memberId:string|undefined,requestKeyInput:string,input:Record<string,unknown>){
    this.gate();if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    if(Object.keys(input).some(field=>!["amountCents","confirmed","taxPolicyVersion"].includes(field))||
      input.confirmed!==true||input.taxPolicyVersion!==TAX_FIXTURE)
      throw new DomainError("CREDIT_CONSENT_AND_TAX_FIXTURE_REQUIRED","请主动确认隔离测试转换及其合成税务口径",422);
    const requestKey=key(requestKeyInput),requested=cents(input.amountCents),
      fingerprint=hash({memberId,requested,confirmed:true,taxPolicyVersion:TAX_FIXTURE});
    return transaction(this.pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`settlement-member:${memberId}`]);
      const existing=(await client.query<Conversion>(`SELECT c.*,
        COALESCE((SELECT sum(e.amount_cents) FROM commission_credit_source s
          JOIN commission_credit_entry e ON e.source_id=s.id WHERE s.conversion_id=c.id),0)::text AS available_cents,
        (SELECT count(*)::int FROM commission_credit_source s JOIN commission_credit_entry e
          ON e.source_id=s.id WHERE s.conversion_id=c.id AND e.kind<>'issue') AS other_entry_count
        FROM commission_credit_conversion c WHERE c.member_id=$1 AND c.idempotency_key=$2`,
        [memberId,requestKey])).rows[0];
      if(existing){if(existing.request_hash!==fingerprint)throw new DomainError("IDEMPOTENCY_CONFLICT",
        "同一请求键不能转换不同金额",409);return this.view(existing);}
      const orders=(await client.query<{order_id:string}>(`SELECT order_id FROM commission_order_snapshot
        WHERE referrer_member_id=$1 AND source_kind='verified_commerce' ORDER BY created_at,order_id`,[memberId])).rows;
      for(const {order_id} of orders)await client.query(`SELECT id FROM commerce_order WHERE id=$1 FOR UPDATE`,[order_id]);
      const ledger=(await client.query<{order_id:string;kind:string;amount_cents:string}>(`SELECT order_id,kind,amount_cents
        FROM commission_ledger_entry WHERE referrer_member_id=$1`,[memberId])).rows;
      const held=(await client.query<{order_id:string;amount_cents:string}>(`SELECT a.order_id,
        sum(a.amount_cents)::text AS amount_cents FROM commission_settlement_allocation a
        JOIN commission_settlement_request r ON r.id=a.request_id
        WHERE r.member_id=$1 AND r.state IN ('reserved','unknown','processing') GROUP BY a.order_id`,[memberId])).rows;
      const holds=new Map(held.map(row=>[row.order_id,Number(row.amount_cents)]));
      const allocations:{orderId:string;amount:number}[]=[];let remaining=requested;
      for(const {order_id} of orders){
        if(remaining===0)break;
        const disputed=(await client.query<{n:number}>(`SELECT
          (SELECT count(*)::int FROM commission_payment_composition_observation c WHERE c.order_id=$1)+
          (SELECT count(*)::int FROM commerce_refund_request r LEFT JOIN commission_refund_intent i
            ON i.request_id=r.id WHERE r.order_id=$1 AND
            (r.state='requested' OR r.state='approved' AND (i.id IS NULL OR i.state IN ('prepared','abnormal')))) AS n`,
          [order_id])).rows[0]?.n??0;
        if(disputed)continue;
        const facts=ledger.filter(fact=>fact.order_id===order_id),sum=(kind:string)=>facts
          .filter(fact=>fact.kind===kind).reduce((n,fact)=>n+Number(fact.amount_cents),0);
        const accrued=sum("accrual"),net=accrued+sum("refund_reversal"),released=sum("release"),
          paid=sum("settlement"),converted=sum("credit_conversion")+sum("credit_conversion_reversal"),
          hold=holds.get(order_id)??0;
        if(![accrued,net,released,paid,converted,hold].every(Number.isSafeInteger)||net<0||
          released>accrued||converted<0||paid+converted+hold>released)
          throw new DomainError("COMMISSION_LEDGER_INVARIANT","来源佣金账本需要人工核对",409);
        const take=Math.min(remaining,Math.max(0,Math.min(net,released)-paid-converted-hold));
        if(take){allocations.push({orderId:order_id,amount:take});remaining-=take;}
      }
      if(remaining)throw new DomainError("CREDIT_SOURCE_INSUFFICIENT","来源已释放佣金不足或仍在预占/争议",409);
      const conversion=(await client.query<Conversion>(`INSERT INTO commission_credit_conversion
        (member_id,idempotency_key,request_hash,gross_cents,credit_cents,tax_policy_version)
        VALUES($1,$2,$3,$4,$4,$5) RETURNING *`,[memberId,requestKey,fingerprint,requested,TAX_FIXTURE])).rows[0]!;
      for(const allocation of allocations){
        const movement=(await client.query<{id:string}>(`INSERT INTO commission_ledger_entry
          (order_id,referrer_member_id,event_key,kind,amount_cents,source_fact_id,actor_principal_id)
          VALUES($1,$2,$3,'credit_conversion',$4,$5,$6) RETURNING id`,[allocation.orderId,memberId,
            `credit-convert:${conversion.id}:${allocation.orderId}`,allocation.amount,conversion.id,`member:${memberId}`])).rows[0]!;
        const source=(await client.query<{id:string}>(`INSERT INTO commission_credit_source
          (conversion_id,order_id,amount_cents,ledger_entry_id) VALUES($1,$2,$3,$4) RETURNING id`,
          [conversion.id,allocation.orderId,allocation.amount,movement.id])).rows[0]!;
        await client.query(`INSERT INTO commission_credit_entry
          (source_id,event_key,kind,amount_cents,actor_principal_id)
          VALUES($1,$2,'issue',$3,$4)`,[source.id,`credit-issue:${source.id}`,allocation.amount,`member:${memberId}`]);
      }
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        after_state,trace_id) VALUES($1,'commission.credit_conversion','commission_credit_conversion',
        $2,'ISOLATED_SYNTHETIC_TAX_ONLY',$3,$4)`,[`member:${memberId}`,conversion.id,
          {grossCents:requested,withholdingCents:0,creditCents:requested,sourceCount:allocations.length},
          `credit-convert:${conversion.id}`]);
      return this.view(conversion);
    },"SERIALIZABLE");
  }

  async cancel(memberId:string|undefined,conversionIdInput:string,cancelKeyInput:string){
    this.gate();if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    const conversionId=id(conversionIdInput),cancelKey=key(cancelKeyInput),fingerprint=hash({memberId,conversionId});
    return transaction(this.pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`settlement-member:${memberId}`]);
      const row=(await client.query<Conversion>(`SELECT * FROM commission_credit_conversion
        WHERE id=$1 AND member_id=$2 FOR UPDATE`,[conversionId,memberId])).rows[0];
      if(!row)throw new DomainError("CREDIT_CONVERSION_NOT_FOUND","转换记录不存在",404);
      const prior=(await client.query<{id:string}>(`SELECT id FROM commission_credit_conversion
        WHERE member_id=$1 AND cancel_key=$2`,[memberId,cancelKey])).rows[0];
      if(prior&&prior.id!==conversionId)throw new DomainError("IDEMPOTENCY_CONFLICT",
        "撤销请求键已用于其他转换",409);
      if(row.state==="cancelled"){
        if(row.cancel_key===cancelKey&&row.cancel_hash===fingerprint)return this.view(row);
        throw new DomainError("CREDIT_CONVERSION_ALREADY_CANCELLED","转换已撤销，不能再次写入",409);
      }
      const sources=(await client.query<Source>(`SELECT id,order_id,amount_cents FROM commission_credit_source
        WHERE conversion_id=$1 ORDER BY order_id`,[conversionId])).rows;
      if(!sources.length||sources.reduce((n,source)=>n+Number(source.amount_cents),0)!==Number(row.credit_cents))
        throw new DomainError("CREDIT_SOURCE_INVARIANT","权益来源分配需先人工核对",409);
      for(const source of sources){
        await client.query(`SELECT id FROM commerce_order WHERE id=$1 FOR UPDATE`,[source.order_id]);
        const entries=(await client.query<{total:string;other_count:number}>(`SELECT
          COALESCE(sum(amount_cents),0)::text AS total,
          count(*) FILTER (WHERE kind<>'issue')::int AS other_count
          FROM commission_credit_entry WHERE source_id=$1`,[source.id])).rows[0]!;
        if(Number(entries.total)!==Number(source.amount_cents)||entries.other_count!==0)
          throw new DomainError("CREDIT_ALREADY_USED_OR_FROZEN","购物权益已使用、冻结或发生退回，不能直接撤销",409);
        const disputed=(await client.query<{n:number}>(`SELECT
          (SELECT count(*)::int FROM commission_payment_composition_observation WHERE order_id=$1)+
          (SELECT count(*)::int FROM commerce_refund_request r LEFT JOIN commission_refund_intent i
            ON i.request_id=r.id WHERE r.order_id=$1 AND
            (r.state='requested' OR r.state='approved' AND (i.id IS NULL OR i.state IN ('prepared','abnormal')))) AS n`,
          [source.order_id])).rows[0]?.n??0;
        if(disputed)throw new DomainError("CREDIT_SOURCE_DISPUTED","原销售有未决事实，暂停撤销",409);
      }
      for(const source of sources){
        await client.query(`INSERT INTO commission_credit_entry
          (source_id,event_key,kind,amount_cents,actor_principal_id)
          VALUES($1,$2,'cancel',$3,$4)`,[source.id,`credit-cancel:${source.id}`,-Number(source.amount_cents),`member:${memberId}`]);
        await client.query(`INSERT INTO commission_ledger_entry
          (order_id,referrer_member_id,event_key,kind,amount_cents,source_fact_id,actor_principal_id)
          VALUES($1,$2,$3,'credit_conversion_reversal',$4,$5,$6)`,[source.order_id,memberId,
            `credit-restore:${source.id}`,-Number(source.amount_cents),conversionId,`member:${memberId}`]);
      }
      const updated=(await client.query<Conversion>(`UPDATE commission_credit_conversion SET state='cancelled',
        cancelled_at=clock_timestamp(),cancel_key=$2,cancel_hash=$3 WHERE id=$1 RETURNING *`,
        [conversionId,cancelKey,fingerprint])).rows[0]!;
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,
        after_state,trace_id) VALUES($1,'commission.credit_conversion_cancelled','commission_credit_conversion',
        $2,'UNUSED_UNFROZEN_ONLY',$3,$4)`,[`member:${memberId}`,conversionId,
          {grossCents:Number(row.gross_cents),sourceCount:sources.length},`credit-cancel:${conversionId}`]);
      return this.view(updated);
    },"SERIALIZABLE");
  }
}
