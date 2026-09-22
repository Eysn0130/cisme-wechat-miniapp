import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction } from "./db.js";
import { requireActiveMemberWithClient } from "./authority.js";
import { finishPage, pageLimit, pageScope, readPageCursor } from "./keysetPage.js";

// Local, bounded historical reads do not need a payment/transfer provider.
// Authentication, owner predicates and cursor scope still apply. No channel
// parameter, mutation service, authorization flag or credential enters this API.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function refundOrderId(value:string){if(!UUID.test(value))throw new DomainError("REFUND_ID_INVALID","退款编号无效",422);return value;}
export async function listMemberRefundRequests(pool:pg.Pool,memberId:string|undefined,query:{limit?:string;cursor?:string;orderId?:string}={}){
    if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    const orderId=query.orderId?refundOrderId(query.orderId):null;
    const limit=pageLimit(query.limit),scope=pageScope(["refund-mine",memberId,orderId]),cursor=readPageCursor(query.cursor,scope);
    return transaction(pool,async client=>{
    await requireActiveMemberWithClient(client,memberId);
    const count=(await client.query<{n:number}>(`SELECT count(*)::int AS n FROM commerce_refund_request
      WHERE requested_by_member_id=$1 AND ($2::uuid IS NULL OR order_id=$2)`,[memberId,orderId])).rows[0]?.n??0;
    const rows=(await client.query(`SELECT r.id,r.order_id,r.amount_cents,r.state,r.reason,
      r.created_at,i.state AS refund_state,i.payer_refund_cents,
      (SELECT COALESCE(sum(a.amount_cents),0)::text FROM commission_credit_refund_allocation a
        WHERE a.refund_intent_id=i.id) AS credit_refund_cents FROM commerce_refund_request r
      LEFT JOIN commission_refund_intent i ON i.request_id=r.id
      WHERE r.requested_by_member_id=$1 AND ($2::uuid IS NULL OR r.order_id=$2)
        AND ($3::timestamptz IS NULL OR (r.created_at,r.id)<($3::timestamptz,$4::uuid))
      ORDER BY r.created_at DESC,r.id DESC LIMIT $5`,[memberId,orderId,cursor?.at??null,cursor?.id??null,limit+1])).rows;
    const page=finishPage(rows.map(row=>({id:row.id,cursorAt:new Date(row.created_at).toISOString(),
      orderId:row.order_id,amountCents:Number(row.amount_cents),state:row.state,
      refundState:row.refund_state??null,reason:row.reason,createdAt:row.created_at,
      cashRefundCents:row.payer_refund_cents===null?null:Number(row.payer_refund_cents),
      creditReturnCents:row.payer_refund_cents===null?null:Number(row.credit_refund_cents)})),limit,scope);
    return {...page,totalCount:count};
    },"REPEATABLE READ");
}

export async function listMemberSettlements(pool:pg.Pool,memberId:string|undefined,query:{limit?:string;cursor?:string}={}){
  if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
  const limit=pageLimit(query.limit),scope=pageScope(["settlement-mine",memberId]),cursor=readPageCursor(query.cursor,scope);
  return transaction(pool,async client=>{
    await requireActiveMemberWithClient(client,memberId);
    const totalCount=(await client.query<{n:number}>(`SELECT count(*)::int AS n FROM commission_settlement_request
      WHERE member_id=$1`,[memberId])).rows[0]?.n??0;
    const rows=(await client.query(`SELECT id,member_id,amount_cents,cycle_id,gross_cents,withholding_cents,
      tax_policy_version,state,version,out_bill_no,channel_state,created_at
      FROM commission_settlement_request WHERE member_id=$1
      AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $4`,[memberId,cursor?.at??null,cursor?.id??null,limit+1])).rows;
    return {...finishPage(rows.map(row=>({id:row.id,memberId:row.member_id,amountCents:Number(row.amount_cents),
      cycleId:row.cycle_id??null,grossCents:row.gross_cents===null?null:Number(row.gross_cents),
      withholdingCents:row.withholding_cents===null?null:Number(row.withholding_cents),
      taxPolicyVersion:row.tax_policy_version??null,state:row.state,version:row.version,
      outBillNo:row.out_bill_no,channelState:row.channel_state??null,
      cursorAt:new Date(row.created_at).toISOString(),createdAt:row.created_at})),limit,scope),totalCount};
  },"REPEATABLE READ");
}
