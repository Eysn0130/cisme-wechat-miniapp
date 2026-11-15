import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction } from "./db.js";
import { requireHistoricalMemberWithClient } from "./authority.js";
import { finishPage, pageLimit, pageScope, readPageCursor } from "./keysetPage.js";

// Local, bounded historical reads do not need a payment/transfer provider.
// Authentication, owner predicates and cursor scope still apply. No channel
// parameter, mutation service, authorization flag or credential enters this API.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function refundOrderId(value:string){if(!UUID.test(value))throw new DomainError("REFUND_ID_INVALID","退款编号无效",422);return value;}
export async function listMemberRefundRequests(pool:pg.Pool,memberId:string|undefined,query:{limit?:string;cursor?:string;orderId?:string}={},closedRights=false){
    if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
    const orderId=query.orderId?refundOrderId(query.orderId):null;
    const limit=pageLimit(query.limit),scope=pageScope(["refund-mine",memberId,orderId]),cursor=readPageCursor(query.cursor,scope);
    return transaction(pool,async client=>{
    await requireHistoricalMemberWithClient(client,memberId,closedRights);
    const history=`SELECT r.id,r.order_id,r.amount_cents,r.state,r.reason,r.created_at,
      i.state AS refund_state,i.payer_refund_cents,
      (SELECT COALESCE(sum(a.amount_cents),0)::text FROM commission_credit_refund_allocation a
        WHERE a.refund_intent_id=i.id) AS credit_refund_cents FROM commerce_refund_request r
      JOIN commerce_order o ON o.id=r.order_id
      LEFT JOIN commission_refund_intent i ON i.request_id=r.id
      WHERE o.member_id=$1 AND ($2::uuid IS NULL OR r.order_id=$2)
      UNION ALL SELECT i.id,i.order_id,i.payer_refund_cents,i.state,'微信平台退款',i.created_at,
        i.state,i.payer_refund_cents,'0'::text FROM commission_refund_intent i
      JOIN commerce_order o ON o.id=i.order_id
      WHERE o.member_id=$1 AND ($2::uuid IS NULL OR i.order_id=$2) AND i.request_id IS NULL
        AND i.allocation_policy_version='wechat-external-full-cash-v1' AND i.execution_kind='wechat'`;
    const count=(await client.query<{n:number}>(`SELECT count(*)::int AS n FROM (${history}) h`,[memberId,orderId])).rows[0]?.n??0;
    const rows=(await client.query(`SELECT h.*,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM (${history}) h WHERE ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $5`,[memberId,orderId,cursor?.at??null,cursor?.id??null,limit+1])).rows;
    const page=finishPage(rows.map(row=>({id:row.id,cursorAt:row.cursor_at,
      orderId:row.order_id,amountCents:Number(row.amount_cents),state:row.state,
      refundState:row.refund_state??null,reason:row.reason,createdAt:row.created_at,
      cashRefundCents:row.payer_refund_cents===null?null:Number(row.payer_refund_cents),
      creditReturnCents:row.payer_refund_cents===null?null:Number(row.credit_refund_cents)})),limit,scope);
    return {...page,totalCount:count};
    },"REPEATABLE READ");
}

export async function listMemberSettlements(pool:pg.Pool,memberId:string|undefined,query:{limit?:string;cursor?:string}={},closedRights=false){
  if(!memberId)throw new DomainError("AUTH_REQUIRED","请先登录后继续",401);
  const limit=pageLimit(query.limit),scope=pageScope(["settlement-mine",memberId]),cursor=readPageCursor(query.cursor,scope);
  return transaction(pool,async client=>{
    await requireHistoricalMemberWithClient(client,memberId,closedRights);
    const totalCount=(await client.query<{n:number}>(`SELECT count(*)::int AS n FROM commission_settlement_request
      WHERE member_id=$1`,[memberId])).rows[0]?.n??0;
    const rows=(await client.query(`SELECT id,member_id,amount_cents,cycle_id,gross_cents,withholding_cents,
      tax_policy_version,state,version,out_bill_no,channel_state,created_at,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM commission_settlement_request WHERE member_id=$1
      AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $4`,[memberId,cursor?.at??null,cursor?.id??null,limit+1])).rows;
    return {...finishPage(rows.map(row=>({id:row.id,memberId:row.member_id,amountCents:Number(row.amount_cents),
      cycleId:row.cycle_id??null,grossCents:row.gross_cents===null?null:Number(row.gross_cents),
      withholdingCents:row.withholding_cents===null?null:Number(row.withholding_cents),
      taxPolicyVersion:row.tax_policy_version??null,state:row.state,version:row.version,
      outBillNo:row.out_bill_no,channelState:row.channel_state??null,
      cursorAt:row.cursor_at,createdAt:row.created_at})),limit,scope),totalCount};
  },"REPEATABLE READ");
}
