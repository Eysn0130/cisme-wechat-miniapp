import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Capability } from '@cisme/contracts';
import { DomainError } from '@cisme/domain';
import { transaction, type DbClient } from './db.js';
import { AuthorityService, requireActiveMemberWithClient } from './authority.js';
import { finishPage, pageLimit, pageScope, readPageCursor } from './keysetPage.js';
import type { RefundCommandService } from './refundCommand.js';
import { enqueue } from './outbox.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9._:-]{8,200}$/;
export const AFTERSALE_CAPABILITIES:Capability[]=['commerce.aftersale.review','commerce.return.receive','commerce.return.inspect'];
const actionCaps:Record<string,Capability>={request_info:'commerce.aftersale.review',reject:'commerce.aftersale.review',
  approve_return:'commerce.aftersale.review',send_return_instruction:'commerce.aftersale.review',
  approve_refund_without_return:'commerce.aftersale.review',request_refund:'commerce.aftersale.review',reopen_refund:'commerce.aftersale.review',
  receive_return:'commerce.return.receive',inspect_return:'commerce.return.inspect'};
function fail(code:string,message:string,status=409):never{throw new DomainError(code,message,status);}
function id(value:unknown):string{if(typeof value!=='string'||!UUID.test(value))fail('AFTERSALE_ID_INVALID','售后编号无效',422);return value;}
function key(value:unknown):string{if(typeof value!=='string'||!KEY.test(value))fail('IDEMPOTENCY_KEY_INVALID','请求键无效',400);return value;}
function note(value:unknown):string{if(typeof value!=='string'||Array.from(value.trim()).length<3||Array.from(value.trim()).length>500||/[\u0000-\u0008\u000b-\u001f]/.test(value))fail('AFTERSALE_NOTE_INVALID','请填写 3 至 500 字的说明',422);return value.trim();}
function requestReason(value:unknown,noReason:boolean):string{
  if(noReason&&(value===undefined||value===''))return '';
  if(noReason&&typeof value==='string'&&!value.trim())return '';
  return note(value);
}
export function returnInstruction(input:Record<string,unknown>){
  const field=(name:string,min:number,max:number)=>{
    const raw=input[name];if(typeof raw!=='string'||raw.trim().length<min||raw.trim().length>max||/[\u0000-\u001f]/.test(raw))
      fail('RETURN_INSTRUCTION_INVALID','请完整填写本案退货收件信息',422);
    return raw.trim();
  };
  const recipientName=field('recipientName',1,80),phone=field('phone',7,20),region=field('region',2,100),address=field('address',5,300);
  if(!/^\+?[0-9-]{7,20}$/.test(phone))fail('RETURN_INSTRUCTION_INVALID','请填写可联系的收件电话',422);
  const freightPayer=input.freightPayer;
  if(!['merchant','member'].includes(String(freightPayer)))fail('RETURN_INSTRUCTION_INVALID','请确认本案运费承担方',422);
  const instructions=input.instructions===undefined?'':field('instructions',0,500);
  return {recipientName,phone,region,address,freightPayer:String(freightPayer),instructions};
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type CaseRow={id:string;order_id:string;member_id:string;kind:string;state:string;reason:string;lines:unknown[];
  amount_cents:string;version:number;request_hash:string;claim_basis:string;support_conversation_id:string|null;return_destination:unknown;return_carrier:string|null;
  return_tracking:string|null;shipped_instruction_version:number|null;quality_result:string|null;refund_request_id:string|null;created_at:Date;updated_at:Date;
  exception_kind:string|null;exception_evidence_reference:string|null;exception_approved_by:string|null;exception_approved_at:Date|null};

/** Case workflow. It records local facts only; provider dispatch,
 * refunds and inventory are never inferred from a review or a returned parcel. */
export class AftersaleService{
  constructor(private readonly pool:pg.Pool,private readonly authority:AuthorityService){}
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
    return {id:row.id,orderId:row.order_id,kind:row.kind,state:row.state,reason:row.reason,claimBasis:row.claim_basis,
      supportConversationId:row.support_conversation_id,requestedAt:row.created_at,lines:row.lines,
      amountCents:Number(row.amount_cents),version:row.version,returnDestination:row.return_destination?((d:any)=>({version:d.version,recipientName:d.recipientName,phone:d.phone,region:d.region??'',address:d.address,freightPayer:d.freightPayer??'to_be_confirmed',instructions:d.instructions??''}))(row.return_destination):null,
      returnCarrier:row.return_carrier,returnTracking:row.return_tracking,
      shippedInstructionVersion:row.shipped_instruction_version,
      returnRouteReviewRequired:['awaiting_return','return_in_transit'].includes(row.state)&&row.shipped_instruction_version!==null&&
        row.shipped_instruction_version<Number((row.return_destination as {version?:number}|null)?.version??0),
      qualityResult:row.quality_result,
      exceptionResolution:row.exception_kind?{kind:row.exception_kind,evidenceReference:row.exception_evidence_reference,
        approvedAt:row.exception_approved_at}:null,
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
    const orderId=id(orderInput),k=key(kInput),kind=input.kind,claimBasis=input.claimBasis===undefined?'other':String(input.claimBasis);
    if(kind!=='refund_only'&&kind!=='return_refund')fail('AFTERSALE_KIND_INVALID','请选择仅退款或退货退款',422);
    if(!['other','no_reason','quality','wrong_item','missing_item','delivery_issue'].includes(claimBasis)
      ||claimBasis==='no_reason'&&kind!=='return_refund')fail('AFTERSALE_CLAIM_BASIS_INVALID','请选择适用的售后情形',422);
    const why=requestReason(input.reason,claimBasis==='no_reason');
    const fingerprint=hash({orderId,kind,why,claimBasis});
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
      // Dispatch takes the same order lock. A refund-only case created after
      // handoff cannot reach its refund command; direct the buyer to the
      // return path before recording a case that an operator cannot finish.
      if(kind==='refund_only'&&!['delivery_issue','missing_item'].includes(claimBasis)
        &&(await client.query(`SELECT 1 FROM commerce_shipment WHERE order_id=$1
        UNION ALL SELECT 1 FROM commerce_shipping_sync WHERE order_id=$1`,[orderId])).rowCount)
        fail('AFTERSALE_RETURN_REQUIRED','本单已登记交寄，请选择退货退款；未收到或漏发请选相应问题类型');
      const lines=(await client.query('SELECT id,product_name,sku_label,quantity,line_total_cents FROM commerce_order_line WHERE order_id=$1 ORDER BY id',[orderId])).rows;
      if(!lines.length)fail('AFTERSALE_LINES_MISSING','商品事实缺失，请联系在线客服');
      // The case, support association, message and durable notification event
      // commit together. A later delivery/transport failure cannot erase the case.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`support-member:${memberId}`]);
      let conversation=(await client.query<{id:string;status:string;next_sequence:string;version:number}>(
        'SELECT id,status,next_sequence,version FROM support_conversation WHERE member_id=$1 FOR UPDATE',[memberId])).rows[0];
      if(!conversation)conversation=(await client.query<{id:string;status:string;next_sequence:string;version:number}>(
        "INSERT INTO support_conversation(member_id,status) VALUES($1,'waiting_human') RETURNING id,status,next_sequence,version",[memberId])).rows[0]!;
      const row=(await client.query<CaseRow>(`INSERT INTO commerce_aftersale_case(order_id,member_id,kind,reason,lines,amount_cents,idempotency_key,request_hash,claim_basis,support_conversation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[orderId,memberId,kind,why,JSON.stringify(lines.map(l=>({lineId:l.id,productName:l.product_name,skuLabel:l.sku_label,quantity:l.quantity,amountCents:Number(l.line_total_cents)}))),order.total_cents,k,fingerprint,claimBasis,conversation.id])).rows[0]!;
      await this.event(client,row,memberId,'request',why||'七日无理由退货申请',null,k,fingerprint);
      const message=(await client.query<{id:string;created_at:Date}>(`INSERT INTO support_message
        (conversation_id,sequence,sender_type,sender_principal_id,body,content_type,client_message_id)
        VALUES($1,$2,'system','system:aftersale',$3,'system',$4) RETURNING id,created_at`,
        [conversation.id,conversation.next_sequence,`售后申请已收到 · 编号 ${row.id}。客服将按本案处理。`,`aftersale-request:${row.id}`])).rows[0]!;
      const support=(await client.query<{version:number}>(`UPDATE support_conversation SET next_sequence=next_sequence+1,
        team_unread_count=team_unread_count+1,status=CASE WHEN status IN ('resolved','ai_active') THEN 'waiting_human' ELSE status END,
        current_handler_principal_id=CASE WHEN status='resolved' THEN NULL ELSE current_handler_principal_id END,
        resolved_at=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING version`,[conversation.id])).rows[0]!;
      await enqueue(client,{eventType:'support.message.created.v1',aggregateType:'support_conversation',aggregateId:conversation.id,
        aggregateVersion:support.version,businessKey:`support-message:${message.id}`,
        payload:{conversationId:conversation.id,messageId:message.id,senderType:'system',sequence:Number(conversation.next_sequence)},occurredAt:message.created_at});
      return this.view(client,row);
    },'SERIALIZABLE');
  }
  async list(memberId:string|undefined,query:{orderId?:string;limit?:string;cursor?:string}={},management=false){
    if(!memberId)fail('AUTH_REQUIRED','请先登录后继续',401);
    const orderId=query.orderId?id(query.orderId):null,limit=pageLimit(query.limit),scope=pageScope(['aftersale',memberId,String(management),orderId]),cursor=readPageCursor(query.cursor,scope);
    return transaction(this.pool,async client=>{
      if(management)await this.management(client,memberId);else await requireActiveMemberWithClient(client,memberId);
      const rows=(await client.query<CaseRow & {cursor_at:string}>(`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM commerce_aftersale_case WHERE ($1::boolean OR member_id=$2)
        AND ($3::uuid IS NULL OR order_id=$3) AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid))
        ORDER BY created_at DESC,id DESC LIMIT $6`,[management,memberId,orderId,cursor?.at??null,cursor?.id??null,limit+1])).rows;
      return finishPage(await Promise.all(rows.map(async row=>({...await this.view(client,row),cursorAt:row.cursor_at}))),limit,scope);
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
      const instructions=(await client.query<{version:number;recipient_name:string;phone:string;region:string;address:string;freight_payer:string;instructions:string;issued_at:Date}>(
        `SELECT version,recipient_name,phone,region,address,freight_payer,instructions,issued_at
         FROM commerce_aftersale_return_instruction WHERE case_id=$1 ORDER BY version DESC`,[caseId])).rows;
      return {...await this.view(client,row),events:events.slice(0,100).reverse(),historyTruncated:events.length>100,
        returnInstructionHistory:instructions.map(item=>({version:item.version,recipientName:item.recipient_name,
          phone:item.phone,region:item.region,address:item.address,freightPayer:item.freight_payer,
          instructions:item.instructions,issuedAt:item.issued_at}))};
    },'REPEATABLE READ');
  }
  async forConversation(memberId:string|undefined,conversationInput:string){
    if(!memberId)fail('AUTH_REQUIRED','请先登录后继续',401);
    const conversationId=id(conversationInput);
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,memberId,'support.read');
      await this.authority.requireWithClient(client,memberId,'commerce.aftersale.review');
      const rows=(await client.query<CaseRow>(`SELECT c.* FROM commerce_aftersale_case c
        JOIN support_conversation s ON s.member_id=c.member_id
        WHERE s.id=$1 AND (c.support_conversation_id=s.id OR c.support_conversation_id IS NULL)
        ORDER BY c.created_at DESC,c.id DESC LIMIT 20`,[conversationId])).rows;
      return {items:await Promise.all(rows.map(row=>this.view(client,row)))};
    },'REPEATABLE READ');
  }
  async act(memberId:string|undefined,caseInput:string,kInput:string,input:Record<string,unknown>,management=false,refund?:RefundCommandService,
    context?:{conversationId:string;principalId:string|undefined}){
    if(!memberId)fail('AUTH_REQUIRED','请先登录后继续',401);
    const caseId=id(caseInput),k=key(kInput),action=String(input.action??''),why=note(input.note),version=input.expectedVersion;
    if(!Number.isSafeInteger(version)||Number(version)<1)fail('VERSION_INVALID','请刷新案件后重试',422);
    if(management?!Object.hasOwn(actionCaps,action):!['cancel','provide_info','report_old_route','ship_return'].includes(action))fail('AFTERSALE_ACTION_INVALID','售后操作无效',422);
    const carrier=action==='ship_return'?input.carrier:null,tracking=action==='ship_return'?input.tracking:null;
    if(action==='ship_return'&&(typeof carrier!=='string'||carrier.trim().length<1||carrier.length>80||typeof tracking!=='string'||!/^[A-Za-z0-9-]{6,64}$/.test(tracking)))fail('RETURN_TRACKING_INVALID','请填写真实快递公司和 6 至 64 位运单号',422);
    const quality=action==='inspect_return'?input.qualityResult:null;
    if(action==='inspect_return'&&quality!=='sellable'&&quality!=='unsellable')fail('RETURN_QUALITY_INVALID','请选择质检结果',422);
    const exceptionKind=action==='approve_refund_without_return'?input.exceptionKind:null;
    const evidenceReference=action==='approve_refund_without_return'?input.evidenceReference:null;
    if(action==='approve_refund_without_return'&&(
      !['lost_in_transit','item_missing','carrier_intercepted','return_impracticable'].includes(String(exceptionKind))
      ||typeof evidenceReference!=='string'||!/^[A-Za-z0-9._:/-]{8,200}$/.test(evidenceReference)))
      fail('AFTERSALE_EXCEPTION_EVIDENCE_REQUIRED','请核对无需寄回的情形和依据编号',422);
    const instruction=action==='send_return_instruction'?returnInstruction(input):null;
    const instructionVersion=['ship_return','report_old_route'].includes(action)?input.instructionVersion:null;
    if(instructionVersion!==null&&instructionVersion!==undefined&&(!Number.isSafeInteger(instructionVersion)||Number(instructionVersion)<1))
      fail('RETURN_INSTRUCTION_VERSION_INVALID','请选择实际使用的退货指引版本',422);
    const fingerprint=hash({caseId,action,why,version,carrier,tracking,quality,instruction,instructionVersion,exceptionKind,evidenceReference});
    return transaction(this.pool,async client=>{
      if(management)await this.management(client,memberId,actionCaps[action]);else await requireActiveMemberWithClient(client,memberId);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`aftersale:${memberId}:${k}`]);
      const pointer=(await client.query<CaseRow>('SELECT * FROM commerce_aftersale_case WHERE id=$1 AND ($2::boolean OR member_id=$3)',[caseId,management,memberId])).rows[0];
      if(!pointer)fail('AFTERSALE_NOT_FOUND','售后案件不存在',404);
      // Use the same order lock as dispatch/refund commands before the case lock.
      await client.query('SELECT id FROM commerce_order WHERE id=$1 FOR UPDATE',[pointer.order_id]);
      const row=(await client.query<CaseRow>('SELECT * FROM commerce_aftersale_case WHERE id=$1 FOR UPDATE',[caseId])).rows[0]!;
      if(context){
        const linked=(await client.query<{status:string;current_handler_principal_id:string|null}>(
          'SELECT status,current_handler_principal_id FROM support_conversation WHERE id=$1 AND member_id=$2 FOR UPDATE',
          [context.conversationId,row.member_id])).rows[0];
        if(row.support_conversation_id!==null&&row.support_conversation_id!==context.conversationId||linked?.status!=='human_active'
          ||!context.principalId||linked.current_handler_principal_id!==context.principalId)
          fail('AFTERSALE_CHAT_ASSIGNMENT_REQUIRED','请在本案对应的已接管会话中处理',403);
      }
      const replay=(await client.query('SELECT case_id,request_hash FROM commerce_aftersale_event WHERE actor_member_id=$1 AND idempotency_key=$2',[memberId,k])).rows[0];
      if(replay){if(replay.case_id!==caseId||replay.request_hash!==fingerprint)fail('IDEMPOTENCY_CONFLICT','请求键对应不同操作');return this.view(client,row);}
      if(row.version!==version)fail('VERSION_CONFLICT','售后案件已更新，请刷新后核对');
      if(management&&row.member_id===memberId)fail('AFTERSALE_SELF_REVIEW_FORBIDDEN','不能处理自己的售后案件',403);
      let state:string|undefined,destination=row.return_destination,refundId=row.refund_request_id;
      if(action==='cancel'&&['requested','need_info','awaiting_instruction','awaiting_return'].includes(row.state)
        &&row.shipped_instruction_version===null)state='cancelled';
      if(action==='provide_info'&&row.state==='need_info')state='requested';
      if(action==='request_info'&&row.state==='requested')state='need_info';
      if(action==='reject'&&['requested','need_info'].includes(row.state))state='rejected';
      if(action==='approve_return'&&row.state==='requested'&&row.kind==='return_refund'){
        state='awaiting_instruction';
      }
      if(action==='send_return_instruction'&&instruction&&row.kind==='return_refund'
        &&['awaiting_instruction','awaiting_return'].includes(row.state)&&!row.return_tracking&&row.shipped_instruction_version===null){
        const latest=(await client.query<{version:number}>(`SELECT version FROM commerce_aftersale_return_instruction
          WHERE case_id=$1 ORDER BY version DESC LIMIT 1`,[caseId])).rows[0];
        destination={version:(latest?.version??0)+1,...instruction};state='awaiting_return';
      }
      if(action==='approve_refund_without_return'&&
        ['requested','need_info','awaiting_instruction','awaiting_return','return_in_transit'].includes(row.state)
        &&row.exception_kind===null){
        if(row.kind==='refund_only'&&!['delivery_issue','missing_item'].includes(row.claim_basis)
          &&!(await client.query('SELECT 1 FROM commerce_shipment WHERE order_id=$1 UNION ALL SELECT 1 FROM commerce_shipping_sync WHERE order_id=$1',[row.order_id])).rowCount)
          fail('AFTERSALE_EXCEPTION_NOT_APPLICABLE','本案尚无免寄回例外依据');
        state='refund_exception_approved';
      }
      if(action==='ship_return'&&row.state==='awaiting_return')state='return_in_transit';
      if(action==='report_old_route'&&row.state==='awaiting_return'&&row.kind==='return_refund'
        &&row.shipped_instruction_version===null)state='awaiting_return';
      let shippedInstructionVersion:number|null=null;
      if((action==='ship_return'||action==='report_old_route')&&state){
        shippedInstructionVersion=instructionVersion===undefined?
          row.shipped_instruction_version??Number((row.return_destination as {version?:number}|null)?.version):Number(instructionVersion);
        if(!Number.isSafeInteger(shippedInstructionVersion)||shippedInstructionVersion<1||
          !(await client.query(`SELECT 1 FROM commerce_aftersale_return_instruction WHERE case_id=$1 AND version=$2`,
            [caseId,shippedInstructionVersion])).rowCount)
          fail('RETURN_INSTRUCTION_VERSION_INVALID','所选退货指引不属于本案，请刷新核对',422);
        if(row.shipped_instruction_version!==null&&row.shipped_instruction_version!==shippedInstructionVersion)
          fail('RETURN_INSTRUCTION_VERSION_CHANGED','原寄件依据已记录，请按同一版本补充物流',409);
        if(action==='report_old_route'&&shippedInstructionVersion>=Number((row.return_destination as {version?:number}|null)?.version))
          fail('AFTERSALE_OLD_ROUTE_REQUIRED','请选择实际已使用的旧版退货指引',422);
      }
      if(action==='receive_return'&&row.state==='return_in_transit')state='return_received';
      if(action==='inspect_return'&&row.state==='return_received')state='quality_checked';
      if(action==='request_refund'&&(row.state==='refund_exception_approved'
        ||row.kind==='refund_only'&&row.state==='requested'||row.kind==='return_refund'&&row.state==='quality_checked')){
        if(!refund)fail('REFUND_UNAVAILABLE','退款提交仍需经过正式交易授权',503);
        if(row.kind==='refund_only'&&row.state!=='refund_exception_approved'
          &&(await client.query('SELECT 1 FROM commerce_shipment WHERE order_id=$1 UNION ALL SELECT 1 FROM commerce_shipping_sync WHERE order_id=$1',[row.order_id])).rowCount)
          fail('AFTERSALE_RETURN_REQUIRED','商品已发货，请核对退货流程后处理');
        const requested=await refund.requestWithClient(client,row.member_id,row.order_id,`aftersale-refund:${row.id}:${row.version}`,
          {amountCents:Number(row.amount_cents),reason:row.claim_basis==='no_reason'?'七日无理由退货申请':row.reason},row.id);
        refundId=requested.id;state='refund_pending';
      }
      if(action==='reopen_refund'&&row.state==='refund_pending'){
        const prior=(await client.query(`SELECT r.state,i.state AS channel_state FROM commerce_refund_request r
          LEFT JOIN commission_refund_intent i ON i.request_id=r.id WHERE r.id=$1`,[row.refund_request_id])).rows[0];
        if(prior?.state==='rejected'||prior?.channel_state==='closed'){
          state=row.exception_kind?'refund_exception_approved':row.kind==='return_refund'?'quality_checked':'requested';refundId=null;
        }
      }
      if(!state)fail('AFTERSALE_STATE_CONFLICT','当前案件状态不允许此操作，请刷新核对');
      let supportConversationId=row.support_conversation_id??context?.conversationId??null;
      if(!supportConversationId&&action==='send_return_instruction'){
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`support-member:${row.member_id}`]);
        supportConversationId=(await client.query<{id:string}>(
          'SELECT id FROM support_conversation WHERE member_id=$1',[row.member_id])).rows[0]?.id??null;
        if(!supportConversationId)supportConversationId=(await client.query<{id:string}>(
          "INSERT INTO support_conversation(member_id,status) VALUES($1,'waiting_human') RETURNING id",[row.member_id])).rows[0]!.id;
      }
      const changed=(await client.query<CaseRow>(`UPDATE commerce_aftersale_case SET state=$2,version=version+1,updated_at=clock_timestamp(),
        return_destination=$3,return_carrier=COALESCE($4,return_carrier),return_tracking=COALESCE($5,return_tracking),
        quality_result=COALESCE($6,quality_result),refund_request_id=$7,support_conversation_id=$8,
        exception_kind=COALESCE($9,exception_kind),exception_evidence_reference=COALESCE($10,exception_evidence_reference),
        exception_approved_by=CASE WHEN $9::text IS NOT NULL THEN $11::uuid ELSE exception_approved_by END,
        exception_approved_at=CASE WHEN $9::text IS NOT NULL THEN clock_timestamp() ELSE exception_approved_at END,
        shipped_instruction_version=COALESCE($12,shipped_instruction_version)
        WHERE id=$1 RETURNING *`,
        [caseId,state,destination,carrier,tracking,quality,refundId,supportConversationId,exceptionKind,evidenceReference,memberId,shippedInstructionVersion])).rows[0]!;
      if(action==='send_return_instruction'&&instruction){
        if(!supportConversationId)fail('AFTERSALE_SUPPORT_LINK_REQUIRED','请先关联原客服会话后发送退货指引');
        const snapshot=destination as typeof instruction&{version:number};
        await client.query(`INSERT INTO commerce_aftersale_return_instruction
          (case_id,version,recipient_name,phone,region,address,freight_payer,instructions,issued_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [caseId,snapshot.version,instruction.recipientName,instruction.phone,instruction.region,instruction.address,
            instruction.freightPayer,instruction.instructions,memberId]);
        const conversation=(await client.query<{id:string;next_sequence:string;version:number}>(
          'SELECT id,next_sequence,version FROM support_conversation WHERE id=$1 FOR UPDATE',[supportConversationId])).rows[0];
        if(!conversation)fail('AFTERSALE_SUPPORT_LINK_REQUIRED','原客服会话不可用，请刷新核对');
        const message=(await client.query<{id:string;created_at:Date}>(`INSERT INTO support_message
          (conversation_id,sequence,sender_type,sender_principal_id,body,content_type,linked_case_id,return_instruction_snapshot,client_message_id)
          VALUES($1,$2,'system','system:aftersale',$3,'return_instruction',$4,$5,$6) RETURNING id,created_at`,
          [conversation.id,conversation.next_sequence,`本案退货指引已发送 · 第 ${snapshot.version} 版`,caseId,JSON.stringify(snapshot),
            `aftersale-return:${caseId}:v${snapshot.version}`])).rows[0]!;
        const updated=(await client.query<{version:number}>(`UPDATE support_conversation SET next_sequence=next_sequence+1,
          member_unread_count=member_unread_count+1,version=version+1,updated_at=clock_timestamp()
          WHERE id=$1 RETURNING version`,[conversation.id])).rows[0]!;
        await enqueue(client,{eventType:'support.message.created.v1',aggregateType:'support_conversation',aggregateId:conversation.id,
          aggregateVersion:updated.version,businessKey:`support-message:${message.id}`,
          payload:{conversationId:conversation.id,messageId:message.id,senderType:'system',sequence:Number(conversation.next_sequence)},occurredAt:message.created_at});
      }
      if(['ship_return','report_old_route'].includes(action)&&row.shipped_instruction_version===null&&shippedInstructionVersion!==null&&
        shippedInstructionVersion<Number((row.return_destination as {version?:number}|null)?.version)){
        if(!supportConversationId)fail('AFTERSALE_SUPPORT_LINK_REQUIRED','原客服会话不可用，请刷新核对');
        const conversation=(await client.query<{id:string;next_sequence:string;version:number}>(
          'SELECT id,next_sequence,version FROM support_conversation WHERE id=$1 FOR UPDATE',[supportConversationId])).rows[0];
        if(!conversation)fail('AFTERSALE_SUPPORT_LINK_REQUIRED','原客服会话不可用，请刷新核对');
        const message=(await client.query<{id:string;created_at:Date}>(`INSERT INTO support_message
          (conversation_id,sequence,sender_type,sender_principal_id,body,content_type,client_message_id)
          VALUES($1,$2,'system','system:aftersale',$3,'system',$4) RETURNING id,created_at`,
          [conversation.id,conversation.next_sequence,`用户已按第 ${shippedInstructionVersion} 版退货指引寄出；当前为第 ${(row.return_destination as {version:number}).version} 版。请核对旧地址物流并主动协助。`,
            `aftersale-old-route:${caseId}`])).rows[0]!;
        const updated=(await client.query<{version:number}>(`UPDATE support_conversation SET next_sequence=next_sequence+1,
          team_unread_count=team_unread_count+1,version=version+1,updated_at=clock_timestamp()
          WHERE id=$1 RETURNING version`,[conversation.id])).rows[0]!;
        await enqueue(client,{eventType:'support.message.created.v1',aggregateType:'support_conversation',aggregateId:conversation.id,
          aggregateVersion:updated.version,businessKey:`support-message:${message.id}`,
          payload:{conversationId:conversation.id,messageId:message.id,senderType:'system',sequence:Number(conversation.next_sequence)},occurredAt:message.created_at});
      }
      await this.event(client,changed,memberId,action,why,row.state,k,fingerprint);return this.view(client,changed);
    },'SERIALIZABLE');
  }
}
