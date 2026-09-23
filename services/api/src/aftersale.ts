import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import type pg from 'pg';
import type { Capability } from '@cisme/contracts';
import { DomainError } from '@cisme/domain';
import { transaction, type DbClient } from './db.js';
import { AuthorityService, requireActiveMemberWithClient } from './authority.js';
import { finishPage, pageLimit, pageScope, readPageCursor } from './keysetPage.js';
import type { RefundCommandService } from './refundCommand.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9._:-]{8,200}$/;
export const AFTERSALE_CAPABILITIES:Capability[]=['commerce.aftersale.review','commerce.return.receive','commerce.return.inspect'];
const actionCaps:Record<string,Capability>={request_info:'commerce.aftersale.review',reject:'commerce.aftersale.review',
  approve_return:'commerce.aftersale.review',request_refund:'commerce.aftersale.review',reopen_refund:'commerce.aftersale.review',
  receive_return:'commerce.return.receive',inspect_return:'commerce.return.inspect'};
function fail(code:string,message:string,status=409):never{throw new DomainError(code,message,status);}
function id(value:unknown):string{if(typeof value!=='string'||!UUID.test(value))fail('AFTERSALE_ID_INVALID','售后编号无效',422);return value;}
function key(value:unknown):string{if(typeof value!=='string'||!KEY.test(value))fail('IDEMPOTENCY_KEY_INVALID','请求键无效',400);return value;}
function note(value:unknown):string{if(typeof value!=='string'||Array.from(value.trim()).length<3||Array.from(value.trim()).length>500||/[\u0000-\u0008\u000b-\u001f]/.test(value))fail('AFTERSALE_NOTE_INVALID','请填写 3 至 500 字的说明',422);return value.trim();}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type CaseRow={id:string;order_id:string;member_id:string;kind:string;state:string;reason:string;lines:unknown[];
  amount_cents:string;version:number;request_hash:string;return_destination:unknown;return_carrier:string|null;
  return_tracking:string|null;quality_result:string|null;refund_request_id:string|null;created_at:Date;updated_at:Date};

/** A deployment-owned business record, never an HTTP input or invented default.
 * Merely supplying this file does not approve commerce or a privacy policy. */
export function approvedReturnDestination(path:string|undefined){
  if(!path)fail('RETURN_DESTINATION_UNAVAILABLE','退货收件信息待核准，请联系在线客服；暂勿寄出',503);
  try{
    if(!path.startsWith('/')||path.includes('\0'))throw Error();
    const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)throw Error();
    const doc=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>;
    if(doc.approved!==true||typeof doc.version!=='string'||!/^[A-Za-z0-9._-]{1,80}$/.test(doc.version)
      ||typeof doc.approvalReference!=='string'||doc.approvalReference.length<8||doc.approvalReference.length>300
      ||typeof doc.recipientName!=='string'||doc.recipientName.length<1||doc.recipientName.length>80
      ||typeof doc.phone!=='string'||!/^\+?[0-9-]{7,20}$/.test(doc.phone)
      ||typeof doc.address!=='string'||doc.address.length<8||doc.address.length>300)throw Error();
    return {version:doc.version,approvalReference:doc.approvalReference,recipientName:doc.recipientName,phone:doc.phone,address:doc.address};
  }catch{fail('RETURN_DESTINATION_UNAVAILABLE','退货收件信息待核准，请联系在线客服；暂勿寄出',503);}
}

/** Whole-order R0 case workflow. It records local facts only; provider dispatch,
 * refunds and inventory are never inferred from a review or a returned parcel. */
export class AftersaleService{
  constructor(private readonly pool:pg.Pool,private readonly authority:AuthorityService,
    private readonly returnDestinationFile?:string){}
  private async management(client:DbClient,memberId:string|undefined,cap?:Capability){
    if(cap){await this.authority.requireWithClient(client,memberId,cap);return;}
    // Lock the actual grant selected, including its post-wait expiry check.
    for(const capability of AFTERSALE_CAPABILITIES){
      try{await this.authority.requireWithClient(client,memberId,capability);return;}
      catch(error){if(!(error instanceof DomainError)||error.code!=='CAPABILITY_REQUIRED')throw error;}
    }
    fail('CAPABILITY_REQUIRED','当前账号没有售后处理权限',403);
  }
  private async view(client:DbClient,row:CaseRow){
    const refund=row.refund_request_id?(await client.query(`SELECT r.state,i.state AS refund_state,
      i.submission_state FROM commerce_refund_request r LEFT JOIN commission_refund_intent i ON i.request_id=r.id WHERE r.id=$1`,[row.refund_request_id])).rows[0]:null;
    return {id:row.id,orderId:row.order_id,kind:row.kind,state:row.state,reason:row.reason,lines:row.lines,
      amountCents:Number(row.amount_cents),version:row.version,returnDestination:row.return_destination?((d:any)=>({version:d.version,recipientName:d.recipientName,phone:d.phone,address:d.address}))(row.return_destination):null,
      returnCarrier:row.return_carrier,returnTracking:row.return_tracking,qualityResult:row.quality_result,
      refundRequestId:row.refund_request_id,refund:refund?{reviewState:refund.state,channelState:refund.refund_state??null,
        submissionState:refund.submission_state??null}:null,
      resolved:refund?.refund_state==='succeeded',inventoryStatus:'separate_ledger_required',
      createdAt:row.created_at,updatedAt:row.updated_at};
  }
  private async event(client:DbClient,row:CaseRow,actor:string,action:string,why:string,from:string|null,k:string,fingerprint:string){
    await client.query(`INSERT INTO commerce_aftersale_event(case_id,actor_member_id,action,note,from_state,to_state,case_version,idempotency_key,request_hash,refund_request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[row.id,actor,action,why,from,row.state,row.version,k,fingerprint,row.refund_request_id]);
    await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
      VALUES($1,$2,'commerce_aftersale_case',$3,$4,$5)`,[`member:${actor}`,`commerce.aftersale.${action}`,row.id,
      {state:row.state,version:row.version},`aftersale:${row.id}:${row.version}`]);
  }
  async request(memberId:string|undefined,orderInput:string,kInput:string,input:Record<string,unknown>){
    if(!memberId)fail('AUTH_REQUIRED','请先登录后继续',401);
    const orderId=id(orderInput),k=key(kInput),why=note(input.reason),kind=input.kind;
    if(kind!=='refund_only'&&kind!=='return_refund')fail('AFTERSALE_KIND_INVALID','请选择仅退款或退货退款',422);
    const fingerprint=hash({orderId,kind,why});
    return transaction(this.pool,async client=>{
      await requireActiveMemberWithClient(client,memberId);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`aftersale:${memberId}:${k}`]);
      const replay=(await client.query<CaseRow>('SELECT * FROM commerce_aftersale_case WHERE member_id=$1 AND idempotency_key=$2',[memberId,k])).rows[0];
      if(replay){if(replay.request_hash!==fingerprint)fail('IDEMPOTENCY_CONFLICT','请求键对应不同售后内容');return this.view(client,replay);}
      if((await client.query('SELECT 1 FROM commerce_aftersale_event WHERE actor_member_id=$1 AND idempotency_key=$2',[memberId,k])).rowCount)fail('IDEMPOTENCY_CONFLICT','请求键已用于其他售后操作');
      const order=(await client.query('SELECT * FROM commerce_order WHERE id=$1 AND member_id=$2 FOR UPDATE',[orderId,memberId])).rows[0];
      if(!order)fail('ORDER_NOT_FOUND','订单不存在',404);
      if(order.status!=='paid'||order.transaction_source_kind!=='verified_commerce'||!(await client.query("SELECT 1 FROM commission_payment_inbox WHERE order_id=$1 AND state='applied'",[orderId])).rowCount)
        fail('AFTERSALE_PAYMENT_REQUIRED','仅已核验支付的订单可申请售后');
      if((await client.query("SELECT 1 FROM commerce_aftersale_case WHERE order_id=$1 AND state NOT IN ('cancelled','rejected')",[orderId])).rowCount)
        fail('AFTERSALE_ACTIVE_CASE','本单已有售后案件，请在原案件中继续');
      if((await client.query(`SELECT 1 FROM commerce_refund_request r LEFT JOIN commission_refund_intent i ON i.request_id=r.id
        WHERE r.order_id=$1 AND (r.state='requested' OR r.state='approved' AND (i.id IS NULL OR i.state<>'closed'))`,[orderId])).rowCount)
        fail('AFTERSALE_EXISTING_REFUND','本单已有退款事实，请先核对原退款');
      const lines=(await client.query('SELECT id,product_name,sku_label,quantity,line_total_cents FROM commerce_order_line WHERE order_id=$1 ORDER BY id',[orderId])).rows;
      if(!lines.length)fail('AFTERSALE_LINES_MISSING','商品事实缺失，请联系在线客服');
      const row=(await client.query<CaseRow>(`INSERT INTO commerce_aftersale_case(order_id,member_id,kind,reason,lines,amount_cents,idempotency_key,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[orderId,memberId,kind,why,JSON.stringify(lines.map(l=>({lineId:l.id,productName:l.product_name,skuLabel:l.sku_label,quantity:l.quantity,amountCents:Number(l.line_total_cents)}))),order.total_cents,k,fingerprint])).rows[0]!;
      await this.event(client,row,memberId,'request',why,null,k,fingerprint);return this.view(client,row);
    },'SERIALIZABLE');
  }
  async list(memberId:string|undefined,query:{orderId?:string;limit?:string;cursor?:string}={},management=false){
    if(!memberId)fail('AUTH_REQUIRED','请先登录后继续',401);
    const orderId=query.orderId?id(query.orderId):null,limit=pageLimit(query.limit),scope=pageScope(['aftersale',memberId,String(management),orderId]),cursor=readPageCursor(query.cursor,scope);
    return transaction(this.pool,async client=>{
      if(management)await this.management(client,memberId);else await requireActiveMemberWithClient(client,memberId);
      const rows=(await client.query<CaseRow>(`SELECT * FROM commerce_aftersale_case WHERE ($1::boolean OR member_id=$2)
        AND ($3::uuid IS NULL OR order_id=$3) AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid))
        ORDER BY created_at DESC,id DESC LIMIT $6`,[management,memberId,orderId,cursor?.at??null,cursor?.id??null,limit+1])).rows;
      return finishPage(await Promise.all(rows.map(async row=>({...await this.view(client,row),cursorAt:row.created_at.toISOString()}))),limit,scope);
    },'REPEATABLE READ');
  }
  async detail(memberId:string|undefined,caseInput:string,management=false){
    if(!memberId)fail('AUTH_REQUIRED','请先登录后继续',401);
    const caseId=id(caseInput);
    return transaction(this.pool,async client=>{
      if(management)await this.management(client,memberId);else await requireActiveMemberWithClient(client,memberId);
      const row=(await client.query<CaseRow>('SELECT * FROM commerce_aftersale_case WHERE id=$1 AND ($2::boolean OR member_id=$3)',[caseId,management,memberId])).rows[0];
      if(!row)fail('AFTERSALE_NOT_FOUND','售后案件不存在',404);
      const events=(await client.query(`SELECT action,note,from_state AS "fromState",to_state AS "toState",case_version AS "version",refund_request_id AS "refundRequestId",created_at AS "createdAt"
        FROM commerce_aftersale_event WHERE case_id=$1 ORDER BY case_version DESC LIMIT 101`,[caseId])).rows;
      return {...await this.view(client,row),events:events.slice(0,100).reverse(),historyTruncated:events.length>100};
    },'REPEATABLE READ');
  }
  async act(memberId:string|undefined,caseInput:string,kInput:string,input:Record<string,unknown>,management=false,refund?:RefundCommandService){
    if(!memberId)fail('AUTH_REQUIRED','请先登录后继续',401);
    const caseId=id(caseInput),k=key(kInput),action=String(input.action??''),why=note(input.note),version=input.expectedVersion;
    if(!Number.isSafeInteger(version)||Number(version)<1)fail('VERSION_INVALID','请刷新案件后重试',422);
    if(management?!actionCaps[action]:!['cancel','provide_info','ship_return'].includes(action))fail('AFTERSALE_ACTION_INVALID','售后操作无效',422);
    const carrier=action==='ship_return'?input.carrier:null,tracking=action==='ship_return'?input.tracking:null;
    if(action==='ship_return'&&(typeof carrier!=='string'||carrier.trim().length<1||carrier.length>80||typeof tracking!=='string'||!/^[A-Za-z0-9-]{6,64}$/.test(tracking)))fail('RETURN_TRACKING_INVALID','请填写真实快递公司和 6 至 64 位运单号',422);
    const quality=action==='inspect_return'?input.qualityResult:null;
    if(action==='inspect_return'&&quality!=='sellable'&&quality!=='unsellable')fail('RETURN_QUALITY_INVALID','请选择质检结果',422);
    const fingerprint=hash({caseId,action,why,version,carrier,tracking,quality});
    return transaction(this.pool,async client=>{
      if(management)await this.management(client,memberId,actionCaps[action]);else await requireActiveMemberWithClient(client,memberId);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`aftersale:${memberId}:${k}`]);
      const pointer=(await client.query<CaseRow>('SELECT * FROM commerce_aftersale_case WHERE id=$1 AND ($2::boolean OR member_id=$3)',[caseId,management,memberId])).rows[0];
      if(!pointer)fail('AFTERSALE_NOT_FOUND','售后案件不存在',404);
      // Use the same order lock as dispatch/refund commands before the case lock.
      await client.query('SELECT id FROM commerce_order WHERE id=$1 FOR UPDATE',[pointer.order_id]);
      const row=(await client.query<CaseRow>('SELECT * FROM commerce_aftersale_case WHERE id=$1 FOR UPDATE',[caseId])).rows[0]!;
      const replay=(await client.query('SELECT case_id,request_hash FROM commerce_aftersale_event WHERE actor_member_id=$1 AND idempotency_key=$2',[memberId,k])).rows[0];
      if(replay){if(replay.case_id!==caseId||replay.request_hash!==fingerprint)fail('IDEMPOTENCY_CONFLICT','请求键对应不同操作');return this.view(client,row);}
      if(row.version!==version)fail('VERSION_CONFLICT','售后案件已更新，请刷新后核对');
      if(management&&row.member_id===memberId)fail('AFTERSALE_SELF_REVIEW_FORBIDDEN','不能处理自己的售后案件',403);
      let state:string|undefined,destination=row.return_destination,refundId=row.refund_request_id;
      if(action==='cancel'&&['requested','need_info','awaiting_return'].includes(row.state))state='cancelled';
      if(action==='provide_info'&&row.state==='need_info')state='requested';
      if(action==='request_info'&&row.state==='requested')state='need_info';
      if(action==='reject'&&['requested','need_info'].includes(row.state))state='rejected';
      if(action==='approve_return'&&row.state==='requested'&&row.kind==='return_refund'){
        destination=approvedReturnDestination(this.returnDestinationFile);state='awaiting_return';
      }
      if(action==='ship_return'&&row.state==='awaiting_return')state='return_in_transit';
      if(action==='receive_return'&&row.state==='return_in_transit')state='return_received';
      if(action==='inspect_return'&&row.state==='return_received')state='quality_checked';
      if(action==='request_refund'&&(row.kind==='refund_only'&&row.state==='requested'||row.kind==='return_refund'&&row.state==='quality_checked')){
        if(!refund)fail('REFUND_UNAVAILABLE','退款提交仍需经过正式交易授权',503);
        if(row.kind==='refund_only'&&(await client.query('SELECT 1 FROM commerce_shipment WHERE order_id=$1 UNION ALL SELECT 1 FROM commerce_shipping_sync WHERE order_id=$1',[row.order_id])).rowCount)
          fail('AFTERSALE_RETURN_REQUIRED','商品已发货，请核对退货流程后处理');
        const requested=await refund.requestWithClient(client,row.member_id,row.order_id,`aftersale-refund:${row.id}:${row.version}`,
          {amountCents:Number(row.amount_cents),reason:row.reason},row.id);
        refundId=requested.id;state='refund_pending';
      }
      if(action==='reopen_refund'&&row.state==='refund_pending'){
        const prior=(await client.query(`SELECT r.state,i.state AS channel_state FROM commerce_refund_request r
          LEFT JOIN commission_refund_intent i ON i.request_id=r.id WHERE r.id=$1`,[row.refund_request_id])).rows[0];
        if(prior?.state==='rejected'||prior?.channel_state==='closed'){
          state=row.kind==='return_refund'?'quality_checked':'requested';refundId=null;
        }
      }
      if(!state)fail('AFTERSALE_STATE_CONFLICT','当前案件状态不允许此操作，请刷新核对');
      const changed=(await client.query<CaseRow>(`UPDATE commerce_aftersale_case SET state=$2,version=version+1,updated_at=clock_timestamp(),
        return_destination=$3,return_carrier=COALESCE($4,return_carrier),return_tracking=COALESCE($5,return_tracking),
        quality_result=COALESCE($6,quality_result),refund_request_id=$7 WHERE id=$1 RETURNING *`,[caseId,state,destination,carrier,tracking,quality,refundId])).rows[0]!;
      await this.event(client,changed,memberId,action,why,row.state,k,fingerprint);return this.view(client,changed);
    },'SERIALIZABLE');
  }
}
