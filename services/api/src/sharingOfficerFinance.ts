import type {DbClient} from './db.js';
import {transaction} from './db.js';
import {requireActiveMemberWithClient} from './authority.js';
import {SharingOfficerService,sharingOrderProjection,sharingOrderView,currentSharingPolicySql,officerPolicyView,officerView} from './sharingOfficer.js';
import {sharingFail as fail,sharingId as id,sharingInt as int,sharingText as text,sharingMonth,sharingTax,csvCell} from './sharingOfficerPolicy.js';
import {pageLimit,pageScope,readPageCursor,finishPage} from './keysetPage.js';
type Row=Record<string,any>;

function lineView(r:Row){return {id:r.id,batchId:r.batch_id,period:r.period,state:r.state,version:r.version,
 grossCents:Number(r.gross_cents),taxCents:r.tax_cents===null?null:Number(r.tax_cents),netCents:r.net_cents===null?null:Number(r.net_cents),
 taxNote:r.tax_note,reviewedAt:r.reviewed_at,paidAt:r.paid_at,paymentReference:r.payment_reference,createdAt:r.created_at};}

export class SharingOfficerFinance {
 constructor(private service:SharingOfficerService){}
 async settlements(actorId:string|undefined,query:{cursor?:unknown;limit?:unknown;id?:string}={}){
  return transaction(this.service.pool,async client=>{
   const actor=await requireActiveMemberWithClient(client,actorId),limit=pageLimit(query.limit),scope=pageScope(['officer-settlements',actor,query.id??'']),cursor=readPageCursor(query.cursor,scope);
   const rows=(await client.query(`SELECT l.*,l.created_at::text AS cursor_at,b.period FROM sharing_settlement_line l
    JOIN sharing_settlement_batch b ON b.id=l.batch_id WHERE l.member_id=$1 AND ($2::uuid IS NULL OR l.id=$2)
    AND ($3::timestamptz IS NULL OR (l.created_at,l.id)<($3,$4::uuid)) ORDER BY l.created_at DESC,l.id DESC LIMIT $5`,
    [actor,query.id?id(query.id):null,cursor?.at??null,cursor?.id??null,limit+1])).rows;
   const page=finishPage(rows.map(r=>({...lineView(r),cursorAt:r.cursor_at})),limit,scope);
   return {...page,items:page.items.map(({cursorAt:_,...r})=>r)};
  },'REPEATABLE READ');
 }
 async management(actorId:string|undefined,query:{section?:string;cursor?:unknown;limit?:unknown;filter?:string;batchId?:string;lineId?:string;memberId?:string}={}){
  return transaction(this.service.pool,async client=>{
   const actor=await requireActiveMemberWithClient(client,actorId),capabilities=await this.service.authority.projection(actor);
   const canManage=capabilities.capabilities.includes('member.manage'),canConfigure=capabilities.capabilities.includes('commission.rate.manage'),
    canRead=capabilities.capabilities.includes('commission.read'),canFinance=capabilities.capabilities.includes('commission.settlement.approve');
   if(!canManage&&!canConfigure&&!canRead&&!canFinance)fail('CAPABILITY_REQUIRED','没有分享官管理权限',403);
   const section=query.section??'officers',limit=pageLimit(query.limit),scope=pageScope(['sharing-admin',actor,section,query.filter??'',query.batchId??'',query.lineId??'',query.memberId??'']),cursor=readPageCursor(query.cursor,scope);
   const target=query.memberId?id(query.memberId):null;
   const p=(await client.query(currentSharingPolicySql)).rows[0],result={memberId:actor,scope:{manage:canManage,configure:canConfigure,read:canRead,finance:canFinance},policy:officerPolicyView(p)};
   if(section==='officers'){
    if(!canManage&&!canRead)fail('CAPABILITY_REQUIRED','没有分享官资料查看权限',403);
    const filter=query.filter??'all';if(!['all','pending','active','rejected','suspended','terminated'].includes(filter))fail('SHARING_FILTER_INVALID','分类无效',422);
    const rows=(await client.query(`SELECT o.*,o.member_id AS id,o.created_at::text AS cursor_at,m.display_name,
     EXISTS(SELECT 1 FROM sharing_payee p WHERE p.member_id=o.member_id) AS payee_ready
     FROM sharing_officer o JOIN member m ON m.id=o.member_id WHERE ($1='all' OR o.state=$1) AND ($5::uuid IS NULL OR o.member_id=$5)
     AND ($2::timestamptz IS NULL OR (o.created_at,o.member_id)<($2,$3::uuid)) ORDER BY o.created_at DESC,o.member_id DESC LIMIT $4`,
     [filter,cursor?.at??null,cursor?.id??null,limit+1,target])).rows;
    const page=finishPage(rows.map(r=>({id:r.id,cursorAt:r.cursor_at,memberId:r.member_id,displayName:r.display_name,payeeReady:r.payee_ready,...officerView(r)})),limit,scope);
    return {...result,...page,items:page.items.map(({cursorAt:_,...r})=>r)};
   }
   if(section==='policy'){
    if(!canConfigure)fail('CAPABILITY_REQUIRED','没有分享官规则管理权限',403);return result;
   }
   if(section==='orders'){
    if(!canRead&&!canFinance)fail('CAPABILITY_REQUIRED','没有佣金订单查看权限',403);
    const rows=(await client.query(`${sharingOrderProjection} WHERE s.program='sharing_officer'
     AND ($1::timestamptz IS NULL OR (s.created_at,s.order_id)<($1,$2::uuid))
     AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM sharing_settlement_allocation a WHERE a.line_id=$4 AND a.order_id=s.order_id)) AND ($5::uuid IS NULL OR s.referrer_member_id=$5)
     ORDER BY s.created_at DESC,s.order_id DESC LIMIT $3`,
     [cursor?.at??null,cursor?.id??null,limit+1,query.lineId?id(query.lineId):null,target])).rows;
    const page=finishPage(rows.map(r=>({...sharingOrderView(r),cursorAt:r.created_at.toISOString()})),limit,scope);
    return {...result,...page,items:page.items.map(({cursorAt:_,...r})=>r)};
   }
   if(section==='batches'){
    if(!canFinance)fail('CAPABILITY_REQUIRED','没有财务管理权限',403);
    const rows=(await client.query(`SELECT b.*,b.created_at::text AS cursor_at,
     (SELECT count(*)::int FROM sharing_settlement_line l WHERE l.batch_id=b.id AND l.state<>'voided') AS line_count
     FROM sharing_settlement_batch b WHERE ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM sharing_settlement_line l WHERE l.batch_id=b.id AND l.member_id=$4)) AND ($1::timestamptz IS NULL OR (b.created_at,b.id)<($1,$2::uuid))
     ORDER BY b.created_at DESC,b.id DESC LIMIT $3`,[cursor?.at??null,cursor?.id??null,limit+1,target])).rows;
    const page=finishPage(rows.map(r=>({id:r.id,cursorAt:r.cursor_at,period:r.period,lineCount:r.line_count,cutoffAt:r.cutoff_at})),limit,scope);
    return {...result,...page,items:page.items.map(({cursorAt:_,...r})=>r)};
   }
   if(section==='lines'){
    if(!canFinance)fail('CAPABILITY_REQUIRED','没有财务管理权限',403);
    const batchId=id(query.batchId),rows=(await client.query(`SELECT l.*,l.created_at::text AS cursor_at,b.period,o.referral_code,m.display_name
     FROM sharing_settlement_line l JOIN sharing_settlement_batch b ON b.id=l.batch_id JOIN sharing_officer o ON o.member_id=l.member_id
     JOIN member m ON m.id=l.member_id WHERE l.batch_id=$1 AND ($5::uuid IS NULL OR l.member_id=$5) AND ($6::uuid IS NULL OR l.id=$6) AND ($2::timestamptz IS NULL OR (l.created_at,l.id)<($2,$3::uuid))
     ORDER BY l.created_at DESC,l.id DESC LIMIT $4`,[batchId,cursor?.at??null,cursor?.id??null,limit+1,target,query.lineId?id(query.lineId):null])).rows;
    const page=finishPage(rows.map(r=>({...lineView(r),memberId:r.member_id,displayName:r.display_name,referralCode:r.referral_code,cursorAt:r.cursor_at})),limit,scope);
    return {...result,...page,items:page.items.map(({cursorAt:_,...r})=>r)};
   }
   fail('SHARING_SECTION_INVALID','分类无效',422);
  },'REPEATABLE READ');
 }
 async orderDetail(actorId:string|undefined,orderInput:string,management=false,query:{cursor?:unknown;limit?:unknown}={}){
  return transaction(this.service.pool,async client=>{
   const actor=await requireActiveMemberWithClient(client,actorId),orderId=id(orderInput);
   if(management){const allowed=await this.service.authority.has(actor,'commission.read')||await this.service.authority.has(actor,'commission.settlement.approve');if(!allowed)fail('CAPABILITY_REQUIRED','没有佣金订单查看权限',403);}
   const raw=(await client.query(`${sharingOrderProjection} WHERE s.order_id=$1 AND s.program='sharing_officer'
    AND ($2::boolean OR s.referrer_member_id=$3)`,[orderId,management,actor])).rows[0];
   if(!raw)fail('SHARING_ORDER_NOT_FOUND','推广订单不存在',404);
   const scope=pageScope(['sharing-movements',actor,orderId,management]),limit=pageLimit(query.limit),cursor=readPageCursor(query.cursor,scope);
   const records=(await client.query(`WITH records AS (
    SELECT e.id,e.occurred_at AS at,jsonb_build_object('kind',e.kind,'amountCents',e.amount_cents,'sourceFactId',e.source_fact_id) AS payload
     FROM commission_ledger_entry e WHERE e.order_id=$1
    UNION ALL SELECT i.id,i.created_at,jsonb_build_object('kind','refund_record','state',i.state,'merchandiseCents',i.eligible_merchandise_refund_cents,'reference',i.out_refund_no)
     FROM commission_refund_intent i WHERE i.order_id=$1
    UNION ALL SELECT l.id,l.created_at,jsonb_build_object('kind','payment_record','state',l.state,'period',b.period,'orderGrossCents',a.amount_cents,
     'settlementGrossCents',l.gross_cents,'settlementTaxCents',l.tax_cents,'settlementNetCents',l.net_cents,'paidAt',l.paid_at,'reference',l.payment_reference)
     FROM sharing_settlement_allocation a JOIN sharing_settlement_line l ON l.id=a.line_id JOIN sharing_settlement_batch b ON b.id=l.batch_id WHERE a.order_id=$1
    UNION ALL SELECT r.id,r.recorded_at,jsonb_build_object('kind','recovery_record','amountCents',r.amount_cents,'receivedCents',r.received_cents,
     'taxAdjustmentCents',r.tax_adjustment_cents,'note',r.note,'reference',r.reference) FROM sharing_recovery r WHERE r.order_id=$1
   ) SELECT id,at,at::text AS cursor_at,payload FROM records
    WHERE ($2::timestamptz IS NULL OR (at,id)<($2,$3::uuid)) ORDER BY at DESC,id DESC LIMIT $4`,[orderId,cursor?.at??null,cursor?.id??null,limit+1])).rows;
   const page=finishPage(records.map(r=>({id:r.id,cursorAt:r.cursor_at,at:r.at,...r.payload})),limit,scope);
   return {order:sharingOrderView(raw),...page,items:page.items.map(({cursorAt:_,...r})=>r)};
  },'REPEATABLE READ');
 }
 async command(actorId:string|undefined,key:string,action:string,input:Row){
  if(!['prepare_month','review_line','void_line','record_payment','record_recovery'].includes(action))return this.service.adminCommand(actorId,key,action,input);
  return this.service.command(actorId,key,action,input,async(client,actor)=>{
   await this.service.require(client,actor,'commission.settlement.approve');
   await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sharing-finance',0))");
   if(action==='prepare_month')return this.prepare(client,actor,input);
   if(action==='record_recovery')return this.recovery(client,actor,input);
   const lineId=id(input.lineId),expected=int(input.expectedVersion,'结算版本',1,2_000_000_000);
   // Lock orders before financial sources, matching payment/refund lock order.
   const ids=(await client.query('SELECT order_id FROM sharing_settlement_allocation WHERE line_id=$1 ORDER BY order_id',[lineId])).rows;
   for(const r of ids)await client.query('SELECT id FROM commerce_order WHERE id=$1 FOR UPDATE',[r.order_id]);
   const line=(await client.query('SELECT * FROM sharing_settlement_line WHERE id=$1 FOR UPDATE',[lineId])).rows[0];
   if(!line||line.version!==expected)fail('VERSION_CONFLICT','结算记录已更新，请重新加载');
   if(line.member_id===actor)fail('SHARING_BENEFICIARY_REVIEW_FORBIDDEN','不能审核或登记自己的付款',403);
   if(action==='void_line'){
    if(!['prepared','reviewed'].includes(line.state))fail('SHARING_LINE_FINAL','该结算记录不能撤销');
    const reason=text(input.reason,'撤销依据',2,300);
    const updated=(await client.query("UPDATE sharing_settlement_line SET state='voided',payment_note=$2,version=version+1 WHERE id=$1 RETURNING *",[lineId,reason])).rows[0];return lineView(updated);
   }
   if(!['prepared','reviewed'].includes(line.state))fail('SHARING_LINE_FINAL','该结算记录不能再次处理');
   await this.validateLine(client,line);
   if(action==='review_line'){
    const tax=sharingTax(Number(line.gross_cents),input.taxCents,input.taxNote);
    const payee=(await client.query('SELECT * FROM sharing_payee WHERE member_id=$1 FOR SHARE',[line.member_id])).rows[0];
    if(!payee)fail('SHARING_PAYEE_MISSING','会员尚未提交收款资料');
    const updated=(await client.query(`UPDATE sharing_settlement_line SET state='reviewed',tax_cents=$2,tax_note=$3,
     reviewed_by=$4,reviewed_at=clock_timestamp(),payee_version=$5,payee_snapshot=$6,version=version+1 WHERE id=$1 RETURNING *`,[lineId,tax.taxCents,tax.taxNote,actor,payee.version,payee.encrypted_payload])).rows[0];return lineView(updated);
   }
   if(line.state!=='reviewed'||input.paidConfirmed!==true)fail('SHARING_PAYMENT_CONFIRM_REQUIRED','请完成财务审核并确认实际付款结果');
   const reference=text(input.paymentReference,'付款流水号',4,160),note=text(input.paymentNote,'付款记录',1,500);
   const paidAt=new Date(text(input.paidAt,'付款时间',10,40)),now=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at as Date;
   if(!Number.isFinite(paidAt.getTime())||paidAt>now||paidAt<new Date(line.reviewed_at))fail('SHARING_PAYMENT_TIME_INVALID','付款时间须在审核之后且不能晚于当前时间',422);
   const payee=(await client.query('SELECT version FROM sharing_payee WHERE member_id=$1 FOR SHARE',[line.member_id])).rows[0];
   if(!payee||payee.version!==line.payee_version)fail('SHARING_PAYEE_CHANGED','收款资料已变化，请重新审核后付款');
   if((await client.query('SELECT 1 FROM sharing_settlement_line WHERE payment_reference=$1',[reference])).rowCount)fail('SHARING_PAYMENT_REFERENCE_DUPLICATE','该付款流水号已登记');
   const updated=(await client.query(`UPDATE sharing_settlement_line SET state='paid',paid_by=$2,paid_at=$3,
    payment_reference=$4,payment_note=$5,version=version+1 WHERE id=$1 RETURNING *`,[lineId,actor,paidAt,reference,note])).rows[0];
   const sources=(await client.query('SELECT * FROM sharing_settlement_allocation WHERE line_id=$1 ORDER BY order_id',[lineId])).rows;
   for(const source of sources)await client.query(`INSERT INTO commission_ledger_entry(order_id,referrer_member_id,event_key,kind,amount_cents,source_fact_id,actor_principal_id)
    VALUES($1,$2,$3,'settlement',$4,$5,$6)`,[source.order_id,line.member_id,`sharing-payment:${lineId}:${source.order_id}`,source.amount_cents,lineId,`member:${actor}`]);
   return lineView(updated);
  });
 }
 private async validateLine(client:DbClient,line:Row){
  const sources=(await client.query(`${sharingOrderProjection} JOIN sharing_settlement_allocation a ON a.order_id=s.order_id
   WHERE a.line_id=$1 AND s.program='sharing_officer'`,[line.id])).rows;
  if(!sources.length)fail('SHARING_ALLOCATION_MISSING','结算来源缺失');
  for(const source of sources){const view=sharingOrderView(source);
   if(view.disputed||view.orderStatus!=='paid'||view.reservedRecoveryCents>0||view.outstandingRecoveryCents>0)
    fail('SHARING_SETTLEMENT_SOURCE_CHANGED','来源订单出现退款或售后，请撤销该明细后重新生成');}
  const recovery=(await client.query(`${sharingOrderProjection} WHERE s.referrer_member_id=$1 AND s.program='sharing_officer'`,[line.member_id])).rows.map(sharingOrderView).some(r=>r.outstandingRecoveryCents>0);
  if(recovery)fail('SHARING_RECOVERY_REQUIRED','存在已付款佣金冲回，请先核对回收记录');
 }
 private async prepare(client:DbClient,actor:string,input:Row){
  const now=(await client.query('SELECT clock_timestamp() AS at')).rows[0].at as Date,{period,cutoff}=sharingMonth(input.period,now);
  const batch=(await client.query(`INSERT INTO sharing_settlement_batch(period,cutoff_at,created_by) VALUES($1,$2,$3)
   ON CONFLICT(period) DO UPDATE SET period=EXCLUDED.period RETURNING *`,[period,cutoff,actor])).rows[0];
  // Work in bounded officer pages. Repeating prepare only picks unprepared officers.
  const owners=(await client.query(`SELECT DISTINCT s.referrer_member_id AS member_id FROM commission_order_snapshot s
   WHERE s.program='sharing_officer' AND s.source_kind='verified_commerce' AND s.created_at<$2
    AND NOT EXISTS(SELECT 1 FROM sharing_settlement_line l WHERE l.batch_id=$1 AND l.member_id=s.referrer_member_id AND l.state<>'voided')
    AND EXISTS(SELECT 1 FROM commission_ledger_entry e WHERE e.order_id=s.order_id AND e.kind='release' AND e.occurred_at<$2)
    AND ($3::uuid IS NULL OR s.referrer_member_id>$3::uuid)
   ORDER BY s.referrer_member_id LIMIT 11`,[batch.id,cutoff,input.afterMemberId?id(input.afterMemberId):null])).rows;
  let created=0;const skipped:string[]=[];
  for(const owner of owners.slice(0,10)){
   const orderIds=(await client.query(`SELECT s.order_id FROM commission_order_snapshot s WHERE s.program='sharing_officer'
    AND s.referrer_member_id=$1 AND s.source_kind='verified_commerce' AND s.created_at<$2 ORDER BY s.order_id`,[owner.member_id,cutoff])).rows;
   for(const row of orderIds)await client.query('SELECT id FROM commerce_order WHERE id=$1 FOR UPDATE',[row.order_id]);
   const views=(await client.query(`${sharingOrderProjection} WHERE s.program='sharing_officer' AND s.referrer_member_id=$1
    AND s.source_kind='verified_commerce' AND s.created_at<$2`,[owner.member_id,cutoff])).rows.map(sharingOrderView);
   if(views.some(r=>r.outstandingRecoveryCents>0)){skipped.push(owner.member_id);continue;}
   const allocations:Array<{orderId:string;amount:number}>=[];
   for(const row of views){
    if(row.disputed||row.orderStatus!=='paid'||row.availableCents<=0)continue;
    const release=(await client.query("SELECT 1 FROM commission_ledger_entry WHERE order_id=$1 AND kind='release' AND occurred_at<$2",[row.id,cutoff])).rowCount;
    if(release)allocations.push({orderId:row.id,amount:row.availableCents});
   }
   const gross=allocations.reduce((sum,r)=>sum+r.amount,0);if(!gross)continue;
   if(!Number.isSafeInteger(gross)||gross>9_900_000_000)fail('SHARING_AMOUNT_INVALID','结算金额超出范围');
   const line=(await client.query(`INSERT INTO sharing_settlement_line(batch_id,member_id,gross_cents) VALUES($1,$2,$3) RETURNING id`,[batch.id,owner.member_id,gross])).rows[0];
   for(const a of allocations)await client.query('INSERT INTO sharing_settlement_allocation(line_id,order_id,amount_cents) VALUES($1,$2,$3)',[line.id,a.orderId,a.amount]);created++;
  }
  return {batchId:batch.id,period,created,hasMore:owners.length>10,afterMemberId:owners.length>10?owners[9]!.member_id:null,skippedRecoveryMembers:skipped};
 }
 private async recovery(client:DbClient,actor:string,input:Row){
  const orderId=id(input.orderId);await client.query('SELECT id FROM commerce_order WHERE id=$1 FOR UPDATE',[orderId]);
  const row=(await client.query(`${sharingOrderProjection} WHERE s.order_id=$1 AND s.program='sharing_officer'`,[orderId])).rows[0];
  if(!row)fail('SHARING_ORDER_NOT_FOUND','推广订单不存在',404);
  const view=sharingOrderView(row),snapshot=(await client.query('SELECT referrer_member_id FROM commission_order_snapshot WHERE order_id=$1',[orderId])).rows[0];
  if(snapshot.referrer_member_id===actor)fail('SHARING_BENEFICIARY_REVIEW_FORBIDDEN','不能登记自己的佣金回收',403);
  if(input.receivedConfirmed!==true)fail('SHARING_RECOVERY_CONFIRM_REQUIRED','请确认公司已实际收回款项');
  const amount=int(input.amountCents,'核对冲回税前佣金',1,view.outstandingRecoveryCents),received=int(input.receivedCents,'实际收回金额',0),tax=int(input.taxAdjustmentCents,'财务审核的税务调整',-9_900_000_000,9_900_000_000),reference=text(input.reference,'回收流水号',4,160),note=text(input.note,'财务核对记录',2,500);
  if(received+tax!==amount)fail('SHARING_RECOVERY_COMPOSITION_INVALID','实际收回与税务调整合计须等于本次核对冲回的税前佣金',422);
  if((await client.query('SELECT 1 FROM sharing_recovery WHERE reference=$1',[reference])).rowCount)fail('SHARING_RECOVERY_DUPLICATE','该回收流水号已登记');
  const result=(await client.query(`INSERT INTO sharing_recovery(order_id,amount_cents,received_cents,tax_adjustment_cents,note,reference,actor_id)
   VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,recorded_at`,[orderId,amount,received,tax,note,reference,actor])).rows[0];return {id:result.id,recordedAt:result.recorded_at,amountCents:amount,receivedCents:received,taxAdjustmentCents:tax};
 }
 async exportBatch(actorId:string|undefined,batchIdInput:string,query:{cursor?:unknown;limit?:unknown}={}){
  const batchId=id(batchIdInput),page=await this.management(actorId,{...query,section:'lines',batchId,limit:query.limit??50});
  const items='items' in page?page.items as Row[]:[];
  const headings=['结算明细编号','月份','分享官编号','税前佣金（元）','扣税（元）','实际到账（元）','状态','付款时间','付款流水号'];
  const csv='\uFEFF'+[headings,...items.map(r=>[r.id,r.period,r.referralCode,(r.grossCents/100).toFixed(2),r.taxCents===null?'':(r.taxCents/100).toFixed(2),r.state==='paid'?(r.netCents/100).toFixed(2):'',r.state,r.paidAt??'',r.paymentReference??''])].map(row=>row.map(csvCell).join(',')).join('\r\n');
  await this.service.pool.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
   VALUES($1,'sharing.settlement_export','sharing_settlement_batch',$2,$3,$4)`,[`member:${actorId}`,batchId,{rows:items.length},`sharing-export:${batchId}`]);
  return {csv,nextCursor:'nextCursor' in page?page.nextCursor:null,hasMore:'hasMore' in page?page.hasMore:false};
 }
}
