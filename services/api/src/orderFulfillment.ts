import { fulfillmentWorkbook } from './fulfillmentWorkbook.js';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { DomainError } from '@cisme/domain';
import { AuthorityService, requireActiveMemberWithClient } from './authority.js';
import { transaction, type DbClient } from './db.js';
import { DeliveryAddressService } from './deliveryAddress.js';
import { ShippingSyncService } from './shippingSync.js';
import type { WechatLogisticsClient, LogisticsBinding } from './wechatLogistics.js';
import { validateShippingBinding } from './wechatOrderShipping.js';

type Dispatch = { carrierCode: string; carrierName: string; trackingNumber: string;
  shippedAt: string; evidenceReference: string; expectedOrderVersion: number };
type Shipment = { id: string; order_id: string; shipping_sync_id: string; carrier_name: string;
  logistics_state: 'shipped'|'delivered'|'exception'; version: number; shipped_at: Date;
  delivered_at: Date|null; receipt_confirmed_at: Date|null };
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const key=/^[A-Za-z0-9._:-]{8,100}$/;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code:string,status=409):never{throw new DomainError(code,'履约信息或状态需要核对，请刷新原订单后重试',status);}
function dispatchInput(raw: Record<string,unknown>): Dispatch {
  const allowed=['carrierCode','carrierName','trackingNumber','shippedAt','evidenceReference','expectedOrderVersion'];
  if(Object.keys(raw).some(k=>!allowed.includes(k)) || typeof raw.carrierCode!=='string'
    || !/^[A-Z0-9_]{2,32}$/.test(raw.carrierCode) || typeof raw.trackingNumber!=='string'
    || !/^[A-Za-z0-9-]{6,64}$/.test(raw.trackingNumber) || typeof raw.carrierName!=='string'
    || !raw.carrierName.trim() || Array.from(raw.carrierName).length>80
    || /[\u0000-\u001f\u007f]/.test(raw.carrierName) || typeof raw.evidenceReference!=='string'
    || !/^[A-Za-z0-9._:-]{8,120}$/.test(raw.evidenceReference)
    || !Number.isSafeInteger(raw.expectedOrderVersion) || Number(raw.expectedOrderVersion)<1
    || typeof raw.shippedAt!=='string' || !Number.isFinite(Date.parse(raw.shippedAt))
    || new Date(raw.shippedAt).toISOString()!==raw.shippedAt) fail('SHIPMENT_INPUT_INVALID',422);
  return {carrierCode:raw.carrierCode,carrierName:raw.carrierName.trim(),trackingNumber:raw.trackingNumber,
    shippedAt:raw.shippedAt,evidenceReference:raw.evidenceReference,expectedOrderVersion:Number(raw.expectedOrderVersion)};
}

/** Local physical facts first; WeChat synchronization is an independent durable
 * job. No network call occurs in these transactions. R0 ships all lines together. */
export class OrderFulfillmentService {
  constructor(private pool:pg.Pool,private authority:AuthorityService,private addresses:DeliveryAddressService,
    private sync:ShippingSyncService,private enabled:boolean,
    private logistics?:Pick<WechatLogisticsClient,'query'|'capabilities'>) {}
  private gate(){if(!this.enabled)fail('FULFILLMENT_NOT_ENABLED',503);}
  private async projection(client:DbClient,row:Shipment){
    const parcel=await this.sync.parcelWithClient(client,row.shipping_sync_id);
    const sync=(await client.query('SELECT state FROM commerce_shipping_sync WHERE id=$1',[row.shipping_sync_id])).rows[0];
    return {id:row.id,orderId:row.order_id,carrierCode:parcel.carrierCode,carrierName:row.carrier_name,
      trackingNumber:parcel.trackingNumber,logisticsState:row.logistics_state,version:row.version,
      shippedAt:row.shipped_at.toISOString(),deliveredAt:row.delivered_at?.toISOString()??null,
      receiptConfirmedAt:row.receipt_confirmed_at?.toISOString()??null,wechatSyncState:sync.state};
  }
  async reconcileShipping(actor:string|undefined,orderId:string,requestKey:string,raw:Record<string,unknown>){
    this.gate(); return this.sync.reconcile(actor,orderId,requestKey,raw);
  }
  async dispatch(actor:string|undefined,orderId:string,requestKey:string,raw:Record<string,unknown>){
    this.gate();await this.authority.require(actor,'commerce.fulfillment.manage');
    if(!uuid.test(orderId)||!key.test(requestKey))fail('SHIPMENT_ID_INVALID',422);
    const input=dispatchInput(raw),fingerprint=digest({orderId,input});
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actor,'commerce.fulfillment.manage');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`shipment:${actor}:${requestKey}`]);
      const replay=(await client.query(`SELECT request_hash,response_body FROM idempotency_operation
        WHERE principal_id=$1 AND operation='commerce.shipment.dispatch' AND idempotency_key=$2`,[`member:${actor}`,requestKey])).rows[0];
      if(replay){if(replay.request_hash!==fingerprint)fail('SHIPMENT_IDEMPOTENCY_CONFLICT');return replay.response_body;}
      const order=(await client.query(`SELECT id,member_id,status,version,transaction_source_kind,paid_at,clock_timestamp() AS server_time
        FROM commerce_order WHERE id=$1 FOR UPDATE`,[orderId])).rows[0];
      if(!order)fail('ORDER_NOT_FOUND',404);
      if(order.status!=='paid'||order.transaction_source_kind!=='verified_commerce')fail('SHIPMENT_PAID_ORDER_REQUIRED');
      if(order.version!==input.expectedOrderVersion)fail('VERSION_CONFLICT');
      // Refund commands lock this same order row. R0 cannot safely dispatch a
      // partly refunded or unresolved order; operator review must settle it first.
      const hold=(await client.query(`SELECT
        EXISTS(SELECT 1 FROM commission_refund_intent WHERE order_id=$1 AND state<>'closed') OR
        EXISTS(SELECT 1 FROM commerce_refund_request r LEFT JOIN commission_refund_intent i ON i.request_id=r.id
          WHERE r.order_id=$1 AND (r.state='requested' OR (r.state='approved' AND (i.id IS NULL OR i.state<>'closed')))) AS blocked`,[orderId])).rows[0].blocked;
      if(hold)fail('SHIPMENT_REFUND_REVIEW_REQUIRED');
      if((await client.query("SELECT 1 FROM commerce_aftersale_case WHERE order_id=$1 AND state NOT IN ('cancelled','rejected')",[orderId])).rowCount)
        fail('SHIPMENT_AFTERSALE_REVIEW_REQUIRED');

      if(Date.parse(input.shippedAt)<new Date(order.paid_at).getTime()||Date.parse(input.shippedAt)>new Date(order.server_time).getTime())fail('SHIPMENT_TIME_INVALID',422);
      if((await client.query('SELECT 1 FROM commerce_shipment WHERE order_id=$1',[orderId])).rowCount)fail('ORDER_ALREADY_SHIPPED');
      const lines=(await client.query('SELECT id,product_name,quantity FROM commerce_order_line WHERE order_id=$1 ORDER BY line_number',[orderId])).rows;
      if(!lines.length)fail('SHIPMENT_LINES_REQUIRED');
      const address=(await client.query('SELECT encrypted_payload,payload_hmac,key_version FROM commerce_order_address WHERE order_id=$1',[orderId])).rows[0];
      if(!address)fail('SHIPMENT_ADDRESS_REQUIRED');
      const opened=this.addresses.openOrderSnapshot(order.member_id,orderId,address.encrypted_payload,address.payload_hmac,address.key_version);
      const description=Array.from(lines.map(l=>`${l.product_name}×${l.quantity}`).join('；')).slice(0,120).join('');
      const proposal=await this.sync.prepareWithClient(client,actor,orderId,requestKey,{carrierCode:input.carrierCode,
        trackingNumber:input.trackingNumber,description,...(input.carrierCode==='SF'?{receiverContactMasked:`****${opened.phone.slice(-4)}`}:{})},input.evidenceReference);
      const row=(await client.query<Shipment>(`INSERT INTO commerce_shipment(order_id,shipping_sync_id,carrier_name,
        shipped_at,created_by_member_id) VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [orderId,proposal.id,input.carrierName,input.shippedAt,actor])).rows[0]!;
      await client.query(`INSERT INTO commerce_shipment_line(shipment_id,order_line_id,quantity)
        SELECT $1,id,quantity FROM commerce_order_line WHERE order_id=$2`,[row.id,orderId]);
      await client.query(`INSERT INTO commerce_shipment_event(shipment_id,event_key,event_type,actor_principal_id,evidence_reference,occurred_at)
        VALUES($1,$2,'shipped',$3,$4,$5)`,[row.id,`shipment:${row.id}`,`member:${actor}`,input.evidenceReference,input.shippedAt]);
      const result={id:row.id,orderId,version:1,logisticsState:'shipped',wechatSyncState:proposal.state};
      await client.query(`INSERT INTO idempotency_operation(principal_id,operation,idempotency_key,business_key,request_hash,response_status,response_body)
        VALUES($1,'commerce.shipment.dispatch',$2,$3,$4,200,$5)`,[`member:${actor}`,requestKey,`shipment:${row.id}`,fingerprint,result]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
        VALUES($1,'commerce.shipment.dispatch','commerce_shipment',$2,$3,$4)`,[`member:${actor}`,row.id,
          {orderId,lineCount:lines.length,quantity:lines.reduce((n,l)=>n+Number(l.quantity),0),wechatSyncState:proposal.state},`shipment:${row.id}`]);
      await this.authority.requireWithClient(client,actor,'commerce.fulfillment.manage');
      return result;
    },'SERIALIZABLE');
  }
  async detailMine(actor:string|undefined,orderId:string){
    this.gate();if(!uuid.test(orderId))fail('ORDER_NOT_FOUND',404);
    return transaction(this.pool,async client=>{
      const owner=await requireActiveMemberWithClient(client,actor);
      const order=(await client.query('SELECT status FROM commerce_order WHERE id=$1 AND member_id=$2',[orderId,owner])).rows[0];
      if(!order)fail('ORDER_NOT_FOUND',404);
      const row=(await client.query<Shipment>('SELECT * FROM commerce_shipment WHERE order_id=$1',[orderId])).rows[0];
      return row?this.projection(client,row):{orderId,logisticsState:order.status==='paid'?'awaiting_dispatch':'not_ready',shipment:null};
    });
  }
  async trackingMine(actor:string|undefined,orderId:string){
    this.gate();if(!uuid.test(orderId))fail('ORDER_NOT_FOUND',404);
    const source=await transaction(this.pool,async client=>{
      const owner=await requireActiveMemberWithClient(client,actor);
      const order=(await client.query('SELECT id,order_number FROM commerce_order WHERE id=$1 AND member_id=$2',[orderId,owner])).rows[0];
      if(!order)fail('ORDER_NOT_FOUND',404);
      const row=(await client.query<Shipment>('SELECT * FROM commerce_shipment WHERE order_id=$1',[orderId])).rows[0];
      if(!row)fail('SHIPMENT_NOT_FOUND',404);
      const payments=(await client.query(`SELECT p.app_id,p.merchant_id,p.payer_openid,p.out_trade_no,
        i.provider_transaction_id,i.payer_total_cents FROM commerce_payment_attempt p
        JOIN commission_payment_inbox i ON i.order_id=p.order_id AND i.app_id=p.app_id AND i.merchant_id=p.merchant_id
        WHERE p.order_id=$1 AND p.state='paid' AND i.state='applied' AND i.composition_status='full_cash'`,[orderId])).rows;
      if(payments.length!==1||payments[0].out_trade_no!==order.order_number)fail('LOGISTICS_PAYMENT_BINDING_REQUIRED');
      const paid=payments[0];
      const binding:LogisticsBinding={appId:paid.app_id,merchantId:paid.merchant_id,merchantOrderNumber:paid.out_trade_no,
        transactionId:paid.provider_transaction_id,payerOpenid:paid.payer_openid,payerTotalCents:Number(paid.payer_total_cents)};
      validateShippingBinding(binding);
      return {owner,shipmentId:row.id,binding,parcel:await this.sync.parcelWithClient(client,row.shipping_sync_id)};
    });
    if(!this.logistics)fail('LOGISTICS_NOT_ENABLED',503);
    // No transaction/authority lock is held over this provider call.
    const result=await this.logistics.query(source.binding,source.parcel.carrierCode,source.parcel.trackingNumber);
    return transaction(this.pool,async client=>{
      await requireActiveMemberWithClient(client,actor);
      if(!(await client.query('SELECT 1 FROM commerce_order WHERE id=$1 AND member_id=$2',[orderId,source.owner])).rowCount)fail('ORDER_NOT_FOUND',404);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
        VALUES($1,'commerce.shipment.tracking_read','commerce_shipment',$2,$3,$4)`,
        [`member:${source.owner}`,source.shipmentId,{source:'wechat_logistics',eventCount:result.events.length},`tracking:${source.shipmentId}`]);
      return {orderId,shipmentId:source.shipmentId,source:'wechat_logistics' as const,...result};
    });
  }
  async logisticsCapabilities(actor:string|undefined){
    this.gate();await this.authority.require(actor,'commerce.fulfillment.manage');
    if(!this.logistics)fail('LOGISTICS_NOT_ENABLED',503);
    const result=await this.logistics.capabilities();
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actor,'commerce.fulfillment.manage');
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
        VALUES($1,'commerce.logistics.capabilities_read','fulfillment_capabilities',gen_random_uuid(),$2,$3)`,
        [`member:${actor}`,{accountCount:result.accounts.length,carrierCount:result.carriers.length},`logistics-capabilities:${actor}`]);
      return result;
    });
  }
  async detailManagement(actor:string|undefined,orderId:string){
    this.gate();if(!uuid.test(orderId))fail('ORDER_NOT_FOUND',404);
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actor,'commerce.fulfillment.manage');
      const order=(await client.query('SELECT status FROM commerce_order WHERE id=$1',[orderId])).rows[0];
      if(!order)fail('ORDER_NOT_FOUND',404);
      const row=(await client.query<Shipment>('SELECT * FROM commerce_shipment WHERE order_id=$1',[orderId])).rows[0];
      return row?this.projection(client,row):{orderId,logisticsState:order.status==='paid'?'awaiting_dispatch':'not_ready',shipment:null};
    });
  }
  async managementList(actor:string|undefined,raw:Record<string,unknown>,exportPersonal=false){
    this.gate();
    const allowed=['state','orderNumber','limit','before'];
    if(Object.keys(raw).some(k=>!allowed.includes(k)))fail('SHIPMENT_FILTER_INVALID',422);
    const state=raw.state??'awaiting_dispatch',number=raw.orderNumber??'',limit=Number(raw.limit??50),before=raw.before??null;
    if(!['awaiting_dispatch','shipped','delivered','exception','all'].includes(String(state))
      ||typeof number!=='string'||number&&!/^[A-Za-z0-9_*-]{1,32}$/.test(number)
      ||!Number.isSafeInteger(limit)||limit<1||limit>(exportPersonal?500:100)
      ||before!==null&&(typeof before!=='string'||!uuid.test(before)))fail('SHIPMENT_FILTER_INVALID',422);
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actor,'commerce.fulfillment.manage');
      const rows=(await client.query(`SELECT o.id,o.order_number,o.member_id,o.version,o.paid_at,
        s.id AS shipment_id,s.logistics_state,s.carrier_name,s.receipt_confirmed_at,
        a.encrypted_payload,a.payload_hmac,a.key_version,
        (SELECT string_agg(l.product_name || ' × ' || l.quantity,'；' ORDER BY l.line_number) FROM commerce_order_line l WHERE l.order_id=o.id) AS items
        FROM commerce_order o LEFT JOIN commerce_shipment s ON s.order_id=o.id
        LEFT JOIN commerce_order_address a ON a.order_id=o.id
        WHERE o.status='paid' AND o.transaction_source_kind='verified_commerce'
        AND ($1='all' OR ($1='awaiting_dispatch' AND s.id IS NULL) OR s.logistics_state=$1)
        AND ($2='' OR o.order_number=$2) AND ($3::uuid IS NULL OR o.id<$3::uuid)
        ORDER BY o.id DESC LIMIT $4`,[state,number,before,limit+1])).rows;
      const hasMore=rows.length>limit,selected=rows.slice(0,limit);
      if(exportPersonal&&hasMore)fail('SHIPMENT_EXPORT_TOO_LARGE',422);
      const items=selected.map(r=>({id:r.id,orderNumber:r.order_number,version:r.version,paidAt:r.paid_at.toISOString(),
        items:r.items,logisticsState:r.logistics_state??'awaiting_dispatch',carrierName:r.carrier_name,
        receiptConfirmedAt:r.receipt_confirmed_at?.toISOString()??null}));
      if(!exportPersonal)return {items,nextCursor:hasMore?selected.at(-1)!.id:null};
      const cells=[['订单号','订单ID','订单版本','支付时间','商品','物流状态','收件人','手机号','省','市','区县','详细地址']];
      for(const r of selected){
        if(!r.encrypted_payload)fail('SHIPMENT_ADDRESS_REQUIRED');
        const a=this.addresses.openOrderSnapshot(r.member_id,r.id,r.encrypted_payload,r.payload_hmac,r.key_version);
        cells.push([r.order_number,r.id,String(r.version),r.paid_at.toISOString(),r.items,r.logistics_state??'awaiting_dispatch',a.recipientName,a.phone,a.province,a.city,a.district,a.detail]);
      }
      const workbook=fulfillmentWorkbook(cells);
      await this.authority.requireWithClient(client,actor,'commerce.fulfillment.manage');
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
        VALUES($1,'commerce.shipment.export','fulfillment_export',gen_random_uuid(),$2,$3)`,
        [`member:${actor}`,{filters:{state,orderNumber:number,limit,before},count:selected.length,format:'xlsx',sha256:createHash('sha256').update(workbook).digest('hex')},`shipment-export:${actor}`]);
      return {workbook}; // Memory only; response is sent only after audit COMMIT.
    });
  }
  async importRows(actor:string|undefined,batchKey:string,raw:unknown){
    this.gate();await this.authority.require(actor,'commerce.fulfillment.manage');
    if(!key.test(batchKey)||batchKey.length>50)fail('SHIPMENT_BATCH_INVALID',422);
    if(typeof raw!=='string'||Buffer.byteLength(raw)>16000||raw.includes('\0'))fail('SHIPMENT_IMPORT_INVALID',422);
    const lines=raw.trim().split(/\r?\n/);
    if(lines.length<1||lines.length>25)fail('SHIPMENT_IMPORT_INVALID',422);
    const seen=new Set<string>();
    const parsed=lines.map(line=>{
      const [orderNumber,carrierCode,carrierName,trackingNumber,shippedAt,...extra]=line.split('\t').map(v=>v.trim());
      if(extra.length||!orderNumber||!/^[A-Za-z0-9_*-]{1,32}$/.test(orderNumber)||seen.has(orderNumber))fail('SHIPMENT_IMPORT_DUPLICATE_OR_INVALID',422);
      seen.add(orderNumber);
      return {orderNumber,input:dispatchInput({carrierCode,carrierName,trackingNumber,shippedAt,expectedOrderVersion:1,evidenceReference:`batch:${batchKey}`})};
    });
    const fingerprint=digest(parsed);
    const plan=await transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actor,'commerce.fulfillment.manage');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`shipment-import:${actor}:${batchKey}`]);
      const prior=(await client.query(`SELECT request_hash,response_body FROM idempotency_operation
        WHERE principal_id=$1 AND operation='commerce.shipment.import_plan' AND idempotency_key=$2`,[`member:${actor}`,batchKey])).rows[0];
      if(prior){if(prior.request_hash!==fingerprint)fail('SHIPMENT_IMPORT_IDEMPOTENCY_CONFLICT');return prior.response_body as Array<{orderId:string;expectedOrderVersion:number}>;}
      const result:Array<{orderId:string;expectedOrderVersion:number}>=[];
      for(const row of parsed){
        const order=(await client.query('SELECT id,version FROM commerce_order WHERE order_number=$1',[row.orderNumber])).rows[0];
        if(!order)fail('SHIPMENT_IMPORT_ORDER_NOT_FOUND',422);
        result.push({orderId:order.id,expectedOrderVersion:order.version});
      }
      // Persist only IDs/versions, never the imported tracking/contact text.
      // A retry uses this original plan even after later order-version changes.
      await client.query(`INSERT INTO idempotency_operation(principal_id,operation,idempotency_key,business_key,request_hash,response_status,response_body)
        VALUES($1,'commerce.shipment.import_plan',$2,$3,$4,200,$5)`,[`member:${actor}`,batchKey,`shipment-import:${batchKey}`,fingerprint,JSON.stringify(result)]);
      return result;
    });
    const entries=plan.map((entry,index)=>({...parsed[index]!.input,...entry}));
    return this.dispatchBatch(actor,batchKey,entries);
  }
  async dispatchBatch(actor:string|undefined,batchKey:string,entries:unknown){
    this.gate();await this.authority.require(actor,'commerce.fulfillment.manage');
    if(!key.test(batchKey)||batchKey.length>50||!Array.isArray(entries)||entries.length<1||entries.length>25)fail('SHIPMENT_BATCH_INVALID',422);
    const seen=new Set<string>();
    const normalized=entries.map(entry=>{
      if(!entry||typeof entry!=='object'||Array.isArray(entry)||typeof entry.orderId!=='string'||!uuid.test(entry.orderId))fail('SHIPMENT_BATCH_INVALID',422);
      if(seen.has(entry.orderId))fail('SHIPMENT_BATCH_DUPLICATE_ORDER',422);
      seen.add(entry.orderId);
      const {orderId,...raw}=entry;
      return {orderId,input:dispatchInput(raw)};
    });
    // Every row has its own durable key and atomic local transaction. A partial
    // result must be shown per row, never labelled an all-or-nothing batch.
    const results=[];
    for(const entry of normalized){
      try{results.push({orderId:entry.orderId,status:'accepted',shipment:await this.dispatch(actor,entry.orderId,`${batchKey}:${entry.orderId}`,entry.input)});}
      catch(error){results.push({orderId:entry.orderId,status:'rejected',code:error instanceof DomainError?error.code:'SHIPMENT_REVIEW_REQUIRED'});}
    }
    return {results};
  }
  async confirmReceipt(actor:string|undefined,orderId:string,requestKey:string,expectedVersion:number){
    this.gate();if(!uuid.test(orderId)||!key.test(requestKey)||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)fail('SHIPMENT_CONFIRM_INPUT_INVALID',422);
    return transaction(this.pool,async client=>{
      const owner=await requireActiveMemberWithClient(client,actor);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`receipt:${owner}:${requestKey}`]);
      const fingerprint=digest({orderId,expectedVersion});
      const replay=(await client.query(`SELECT request_hash,response_body FROM idempotency_operation
        WHERE principal_id=$1 AND operation='commerce.shipment.receipt' AND idempotency_key=$2`,[`member:${owner}`,requestKey])).rows[0];
      if(replay){if(replay.request_hash!==fingerprint)fail('SHIPMENT_IDEMPOTENCY_CONFLICT');return replay.response_body;}
      const order=(await client.query('SELECT id FROM commerce_order WHERE id=$1 AND member_id=$2 FOR UPDATE',[orderId,owner])).rows[0];
      if(!order)fail('ORDER_NOT_FOUND',404);
      const row=(await client.query<Shipment>('SELECT * FROM commerce_shipment WHERE order_id=$1 FOR UPDATE',[orderId])).rows[0];
      if(!row)fail('SHIPMENT_REQUIRED');
      if(row.version!==expectedVersion)fail('VERSION_CONFLICT');
      if(row.receipt_confirmed_at)fail('RECEIPT_ALREADY_CONFIRMED');
      const updated=(await client.query<Shipment>(`UPDATE commerce_shipment SET receipt_confirmed_at=clock_timestamp(),version=version+1
        WHERE id=$1 RETURNING *`,[row.id])).rows[0]!;
      await client.query(`INSERT INTO commerce_shipment_event(shipment_id,event_key,event_type,actor_principal_id,evidence_reference,occurred_at)
        VALUES($1,$2,'receipt_confirmed',$3,$4,$5)`,[row.id,`receipt:${row.id}`,`member:${owner}`,`explicit-receipt:${row.id}`,updated.receipt_confirmed_at]);
      const result={id:row.id,orderId,version:updated.version,receiptConfirmedAt:updated.receipt_confirmed_at!.toISOString()};
      await client.query(`INSERT INTO idempotency_operation(principal_id,operation,idempotency_key,business_key,request_hash,response_status,response_body)
        VALUES($1,'commerce.shipment.receipt',$2,$3,$4,200,$5)`,[`member:${owner}`,requestKey,`receipt:${row.id}`,fingerprint,result]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
        VALUES($1,'commerce.shipment.receipt','commerce_shipment',$2,$3,$4)`,[`member:${owner}`,row.id,{version:updated.version},`receipt:${row.id}`]);
      return result; // No carrier delivery, refund, commission release or WeChat receipt is fabricated.
    },'SERIALIZABLE');
  }
}
