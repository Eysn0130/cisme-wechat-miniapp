import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {DomainError} from '@cisme/domain';
import {transaction,type DbClient} from './db.js';
import {AuthorityService} from './authority.js';
import {DeliveryAddressService} from './deliveryAddress.js';
import {enqueue} from './outbox.js';
import {launchFulfillmentPolicy} from './fulfillmentPolicy.js';
import {activePointPolicy,pointPolicyByVersion,lockPointWallet,sweepMemberPoints,pointTransaction,pointEntry,offsetPointDebt,returnSpentMemberLot} from './pointsLedger.js';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function fail(code:string,title:string,status=422):never{throw new DomainError(code,title,status);}
function id(v:unknown){if(typeof v!=='string'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)))fail('POINTS_GIFT_ID_INVALID','兑换编号无效');return v;}
function int(v:unknown,min=1,max=10000000){if(!Number.isSafeInteger(v)||Number(v)<min||Number(v)>max)fail('POINTS_GIFT_INPUT_INVALID','请核对兑换数量、积分或版本');return Number(v);}
function key(v:string){if(!/^[A-Za-z0-9._:-]{8,200}$/.test(v))fail('IDEMPOTENCY_KEY_INVALID','操作编号无效');return v;}
function body(v:unknown,allowed:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k)))fail('POINTS_GIFT_INPUT_INVALID','请核对兑换内容');return v as Record<string,unknown>;}
function owner(v:string|undefined){return v||fail('MEMBER_REQUIRED','请先登录',401);}
type Lot={id:string;grant_id:string;available_amount:number;expires_at:Date|null;used_amount:number};
export class PointsGiftService{
 constructor(private pool:pg.Pool,private authority:AuthorityService,private addresses:DeliveryAddressService,private environment:string){}
 private view(r:any){return {id:r.id,skuId:r.sku_id,quantity:r.quantity,pointsCost:r.points_cost,item:r.item_snapshot,state:r.state,version:r.version,
   carrierName:r.carrier_name,trackingNumber:r.tracking_number,createdAt:r.created_at,updatedAt:r.updated_at};}
 async offers(memberId:string|undefined,now=new Date(),management=false){
  const member=owner(memberId);if(management)await this.authority.require(member,'commerce.product.manage');return transaction(this.pool,async c=>{await lockPointWallet(c,member,true);const policy=await activePointPolicy(c,now);
   const rows=(await c.query(`SELECT s.id AS sku_id,p.id AS product_id,p.version AS product_version,p.shopping_points_multiplier,p.publication_status,p.qualification_status,p.name,p.image_path,s.label,pr.version,pr.amount_cents AS unit_price_cents,
    GREATEST(0,i.stock_on_hand-i.reserved_quantity)::int AS available_quantity
    FROM catalog_sku s JOIN catalog_product p ON p.id=s.product_id JOIN catalog_price pr ON pr.sku_id=s.id
    JOIN catalog_inventory_level i ON i.sku_id=s.id WHERE ($2::boolean OR p.qualification_status='eligible' AND p.publication_status='published' AND s.active)
     AND ($1::boolean OR p.source_kind='admin') ORDER BY p.created_at DESC,p.id,s.sort_order,s.id`,[this.environment==='test'||management,management])).rows;
   return {enabled:Boolean(policy),items:policy?rows.map(r=>({publicationStatus:r.publication_status,qualificationStatus:r.qualification_status,productId:r.product_id,productVersion:r.product_version,shoppingPointsMultiplier:r.shopping_points_multiplier,skuId:r.sku_id,name:r.name,label:r.label,image:r.image_path,
    points:this.unitPoints(r.unit_price_cents,policy.rules.pointsPerYuan),version:r.version,policyVersion:policy.version,availableQuantity:r.available_quantity})):[]};
  });
 }
 private unitPoints(cents:unknown,ratio:number){const n=Number(cents);if(!Number.isSafeInteger(n)||n<1)fail('POINTS_PRICE_INVALID','商品价格需重新核对',409);
  return int(Number((BigInt(n)*BigInt(ratio)+99n)/100n),1,2147483647);}
 async managementOffers(memberId:string|undefined){await this.authority.require(memberId,'commerce.product.manage');return this.offers(memberId,new Date(),true);}
 async configureMultiplier(memberId:string|undefined,productId:string,input:unknown){
  const b=body(input,['expectedVersion','multiplier','reason']),version=int(b.expectedVersion);if(![1,3].includes(Number(b.multiplier))||typeof b.multiplier!=='number')fail('POINTS_MULTIPLIER_INVALID','请选择普通1倍或已公示的商品3倍');
  const reason=typeof b.reason==='string'?b.reason.trim():'';if(reason.length<4||reason.length>500)fail('POINTS_MULTIPLIER_REASON_REQUIRED','请填写至少4字的商品积分公示依据');
  return transaction(this.pool,async c=>{const actor=await this.authority.requireWithClient(c,memberId,'commerce.product.manage');
   const previous=(await c.query('SELECT * FROM catalog_product WHERE id=$1 FOR UPDATE',[id(productId)])).rows[0];if(!previous)fail('CATALOG_PRODUCT_NOT_FOUND','商品不存在',404);
   if(previous.version!==version)fail('CATALOG_VERSION_CONFLICT','商品已有更新，请重新核对',409);
   if(previous.shopping_points_multiplier===b.multiplier)return {productId,version,multiplier:b.multiplier,replayed:true};
   const updated=(await c.query('UPDATE catalog_product SET shopping_points_multiplier=$2,version=version+1,updated_by=$3,updated_at=now() WHERE id=$1 RETURNING version',[productId,b.multiplier,`member:${actor}`])).rows[0];
   await c.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id) VALUES($1,'points.product_multiplier_changed','catalog_product',$2,'EXPLICIT_PRODUCT_PROMOTION',$3,$4,$5)`,[`member:${actor}`,productId,{version,multiplier:previous.shopping_points_multiplier},{version:updated.version,multiplier:b.multiplier,reason},randomUUID()]);
   await enqueue(c,{eventType:'catalog.product.changed.v1',aggregateType:'catalog_product',aggregateId:productId,aggregateVersion:updated.version,businessKey:`catalog-product:${productId}:v${updated.version}`,payload:{productId,action:'points_multiplier_updated'},occurredAt:new Date()});
   return {productId,version:updated.version,multiplier:b.multiplier,replayed:false};
  });
 }
 async redeem(memberId:string|undefined,keyInput:string,input:unknown,now=new Date()){
  const member=owner(memberId),operation=key(keyInput),b=body(input,['skuId','offerVersion','policyVersion','expectedPoints','quantity','addressId','addressVersion']);
  const args={skuId:id(b.skuId),offerVersion:int(b.offerVersion),policyVersion:typeof b.policyVersion==='string'?b.policyVersion:fail('POINTS_POLICY_INVALID','请重新确认积分规则'),expectedPoints:int(b.expectedPoints,1,2147483647),quantity:int(b.quantity,1,99),addressId:id(b.addressId),addressVersion:int(b.addressVersion)},fingerprint=hash(args);
  return transaction(this.pool,async c=>{
   await lockPointWallet(c,member,true);const old=(await c.query('SELECT * FROM member_points_redemption WHERE member_id=$1 AND operation_id=$2',[member,operation])).rows[0];
   if(old){if(old.request_sha256!==fingerprint)fail('IDEMPOTENCY_CONFLICT','同一操作编号不能兑换不同内容',409);return {...this.view(old),replayed:true};}
   const priorCommand=(await c.query('SELECT action FROM member_points_command WHERE member_id=$1 AND operation_id=$2',[member,operation])).rows[0];
   if(priorCommand)fail(priorCommand.action==='abandoned'?'POINTS_COMMAND_ABANDONED':'IDEMPOTENCY_CONFLICT',priorCommand.action==='abandoned'?'该待确认兑换已取消，请重新核对后再兑换':'该操作编号已用于其他业务',409);
   const policy=await activePointPolicy(c,now);if(!policy)fail('POINTS_POLICY_UNAVAILABLE','积分兑换当前未开放',503);
   await sweepMemberPoints(c,member,now);
   const offer=(await c.query(`SELECT pr.version,pr.amount_cents AS unit_price_cents,p.name,p.image_path,p.source_kind,p.publication_status,p.qualification_status,s.label,s.active
    FROM catalog_sku s JOIN catalog_product p ON p.id=s.product_id JOIN catalog_price pr ON pr.sku_id=s.id
    WHERE s.id=$1 FOR SHARE OF pr,p,s`,[args.skuId])).rows[0];
   if(!offer||!offer.active||offer.publication_status!=='published'||offer.qualification_status!=='eligible'||this.environment!=='test'&&offer.source_kind!=='admin')fail('POINTS_GIFT_UNAVAILABLE','商品当前不可兑换',409);
   const unitPoints=this.unitPoints(offer.unit_price_cents,policy.rules.pointsPerYuan);
   if(offer.version!==args.offerVersion||policy.version!==args.policyVersion||unitPoints!==args.expectedPoints)fail('POINTS_OFFER_CHANGED','商品价格或积分规则已有更新，请重新确认',409);
   const cost=int(unitPoints*args.quantity,1,2147483647),wallet=await lockPointWallet(c,member,true);
   if(wallet.debt||wallet.available<cost)fail('POINTS_INSUFFICIENT','可用积分不足或存在待冲抵欠分',409);
   const address=await this.addresses.checkoutSnapshot(c,member,args.addressId,args.addressVersion);const fulfillment=launchFulfillmentPolicy(address.payload);
   const stock=await c.query(`UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand-$2,version=version+1,updated_by=$3,updated_at=$4
    WHERE sku_id=$1 AND stock_on_hand-reserved_quantity>=$2 RETURNING sku_id`,[args.skuId,args.quantity,`member:${member}`,now]);
   if(!stock.rowCount)fail('POINTS_GIFT_SOLD_OUT','礼品库存不足，请重新选择',409);
   const redemptionId=randomUUID(),sealed=this.addresses.sealOrderSnapshot(member,redemptionId,address.payload);
   const row=(await c.query(`INSERT INTO member_points_redemption(id,member_id,sku_id,policy_version,offer_version,quantity,points_cost,item_snapshot,
    encrypted_address,address_hmac,key_version,operation_id,request_sha256,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *`,[redemptionId,member,args.skuId,policy.version,offer.version,args.quantity,cost,
    {name:offer.name,label:offer.label,image:offer.image_path,unitPoints,cashPriceCents:Number(offer.unit_price_cents),pointsPerYuan:policy.rules.pointsPerYuan,fulfillmentPolicy:fulfillment},sealed.encryptedPayload,sealed.payloadHmac,sealed.keyVersion,operation,fingerprint,now])).rows[0];
   const tx=(await pointTransaction(c,member,`gift-spend:${redemptionId}`,'spend',now,'纯积分礼品兑换',policy.version))!;
   const lots=(await c.query<Lot>(`SELECT l.* FROM points_lot l JOIN points_grant g ON g.id=l.grant_id WHERE g.member_id=$1 AND l.available_amount>0 AND NOT g.blocked_for_use
    ORDER BY l.expires_at NULLS LAST,l.id FOR UPDATE OF l`,[member])).rows;let remaining=cost;
   for(const lot of lots){const take=Math.min(remaining,lot.available_amount);if(!take)break;
    await c.query('UPDATE points_lot SET available_amount=available_amount-$2,used_amount=used_amount+$2 WHERE id=$1',[lot.id,take]);
    await c.query('INSERT INTO member_points_gift_allocation(redemption_id,lot_id,amount) VALUES($1,$2,$3)',[redemptionId,lot.id,take]);
    await pointEntry(c,member,tx,'spend',`${tx}:${lot.id}`,now,{available:-take,used:take},lot,{amount:take,redemptionId});remaining-=take;
   }
   if(remaining)throw new Error('POINTS_GIFT_LOTS_DRIFT');
   await c.query(`INSERT INTO member_points_redemption_event(redemption_id,action,operation_id,actor_member_id,request_sha256,reason,occurred_at)
    VALUES($1,'redeem',$2,$3,$4,'会员主动兑换',$5)`,[redemptionId,`redeem:${redemptionId}`,member,fingerprint,now]);
   await c.query(`INSERT INTO member_points_command(member_id,operation_id,action,source_id,request_sha256,created_at) VALUES($1,$2,'gift',$3,$4,$5)`,[member,operation,redemptionId,fingerprint,now]);
   return {...this.view(row),replayed:false};
  });
 }
 async commandReceipt(memberId:string|undefined,operationId:string,abandon=false,now=new Date()){
  const member=owner(memberId),operation=key(operationId);return transaction(this.pool,async c=>{
   await lockPointWallet(c,member,true);
   const r=(await c.query('SELECT * FROM member_points_redemption WHERE member_id=$1 AND operation_id=$2',[member,operation])).rows[0];
   if(r)return {status:'found',record:this.view(r)};
   const command=(await c.query('SELECT action FROM member_points_command WHERE member_id=$1 AND operation_id=$2',[member,operation])).rows[0];
   if(command?.action==='abandoned')return {status:'abandoned'};
   if(command)fail('IDEMPOTENCY_CONFLICT','该操作编号属于其他业务，请核对',409);
   if(!abandon)return {status:'not_found'};
   await c.query(`INSERT INTO member_points_command(member_id,operation_id,action,source_id,request_sha256,created_at)
    VALUES($1,$2,'abandoned',$3,$4,$5)`,[member,operation,randomUUID(),hash(['abandoned',operation]),now]);
   return {status:'abandoned'};
  });
 }
 async list(memberId:string|undefined,management=false,query:{cursor?:string;state?:string}={}){
  const member=owner(memberId);if(management)await this.authority.require(member,'commerce.fulfillment.manage');
  const state=query.state??'all';if(!['all','placed','shipped','received','cancelled','return_requested','returned'].includes(state))fail('POINTS_GIFT_FILTER_INVALID','兑换状态筛选无效');
  let cursor:{at:string;id:string}|null=null;
  if(query.cursor){try{const v=JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8'));if(query.cursor.length>600||typeof v.at!=='string'||!Number.isFinite(Date.parse(v.at)))throw Error();cursor={at:v.at,id:id(v.id)};}catch{fail('POINTS_GIFT_CURSOR_INVALID','兑换分页无效');}}
  const rows=(await this.pool.query(`SELECT *,created_at::text AS cursor_at FROM member_points_redemption
    WHERE ($1::uuid IS NULL OR member_id=$1) AND ($2='all' OR state=$2) AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4::uuid))
    ORDER BY created_at DESC,id DESC LIMIT 26`,[management?null:member,state,cursor?.at??null,cursor?.id??null])).rows;
  const page=rows.slice(0,25),last=rows.length>25?page[page.length-1]:null;
  return {items:page.map(r=>({...this.view(r),...(management?{address:this.addresses.openOrderSnapshot(r.member_id,r.id,r.encrypted_address,r.address_hmac,r.key_version)}:{})})),
    nextCursor:last?Buffer.from(JSON.stringify({at:last.cursor_at,id:last.id})).toString('base64url'):null};
 }
 async operate(memberId:string|undefined,redemptionId:string,keyInput:string,action:string,input:unknown,now=new Date()){
  const actor=owner(memberId),operation=key(keyInput),b=body(input,['expectedVersion','carrierName','trackingNumber','reason']),version=int(b.expectedVersion);
  if(!['cancel','ship','receive','request_return','return_received'].includes(action))fail('POINTS_GIFT_ACTION_INVALID','兑换操作无效');
  const reason=typeof b.reason==='string'?b.reason.trim():'';if(reason.length<4||reason.length>500)fail('POINTS_GIFT_REASON_REQUIRED','请填写至少4字的操作说明');
  const fingerprint=hash({redemptionId,action,...b});
  return transaction(this.pool,async c=>{
   const base=(await c.query('SELECT member_id FROM member_points_redemption WHERE id=$1',[id(redemptionId)])).rows[0];if(!base)fail('POINTS_GIFT_NOT_FOUND','兑换记录不存在',404);
   const isManagement=['ship','return_received'].includes(action);
   if(isManagement)await this.authority.requireWithClient(c,actor,'commerce.fulfillment.manage');else if(base.member_id!==actor)fail('POINTS_GIFT_NOT_FOUND','兑换记录不存在',404);
   await lockPointWallet(c,base.member_id);
   const old=(await c.query('SELECT * FROM member_points_redemption_event WHERE operation_id=$1',[operation])).rows[0];
   const r=(await c.query('SELECT * FROM member_points_redemption WHERE id=$1 FOR UPDATE',[redemptionId])).rows[0];
   if(old){if(old.redemption_id!==redemptionId||old.actor_member_id!==actor||old.request_sha256!==fingerprint)fail('IDEMPOTENCY_CONFLICT','操作编号已用于其他内容',409);return this.view(r);}
   if(r.version!==version)fail('POINTS_GIFT_CHANGED','兑换状态已有更新，请重新核对',409);
   const next:Record<string,[string,string]>={cancel:['placed','cancelled'],ship:['placed','shipped'],receive:['shipped','received'],request_return:[r.state==='shipped'?'shipped':'received','return_requested'],return_received:['return_requested','returned']};
   if(r.state!==next[action]![0])fail('POINTS_GIFT_STATE_INVALID','当前状态不能执行此操作',409);
   const carrier=typeof b.carrierName==='string'?b.carrierName.trim():null,tracking=typeof b.trackingNumber==='string'?b.trackingNumber.trim():null;
   if(action==='ship'&&(!carrier||carrier.length>50||!tracking||!/^[A-Za-z0-9-]{6,80}$/.test(tracking)))fail('POINTS_GIFT_TRACKING_REQUIRED','请填写真实承运商与运单号');
   if(action==='cancel'||action==='return_received')await this.refund(c,r,now,action==='cancel');
   const updated=(await c.query(`UPDATE member_points_redemption SET state=$2,version=version+1,updated_at=$3,
    carrier_name=COALESCE($4,carrier_name),tracking_number=COALESCE($5,tracking_number) WHERE id=$1 RETURNING *`,[redemptionId,next[action]![1],now,action==='ship'?carrier:null,action==='ship'?tracking:null])).rows[0];
   await c.query(`INSERT INTO member_points_redemption_event(redemption_id,action,operation_id,actor_member_id,request_sha256,reason,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[redemptionId,action,operation,actor,fingerprint,reason,now]);return this.view(updated);
  });
 }
 private async refund(c:DbClient,r:any,now:Date,restock:boolean){
  const policy=await pointPolicyByVersion(c,r.policy_version),tx=(await pointTransaction(c,r.member_id,`gift-return:${r.id}`,'refund_return',now,'礼品取消或退回原积分',r.policy_version))!;
  if(!tx)return;
  const rows=(await c.query(`SELECT * FROM member_points_gift_allocation WHERE redemption_id=$1 AND NOT returned ORDER BY lot_id FOR UPDATE`,[r.id])).rows;
  if(rows.reduce((n,a)=>n+a.amount,0)!==r.points_cost)throw new Error('POINTS_GIFT_REFUND_DRIFT');
  await sweepMemberPoints(c,r.member_id,now);
  for(const a of rows){
   await returnSpentMemberLot(c,r.member_id,a.lot_id,a.amount,tx,now,policy?.rules.refundGraceDays??30,{redemptionId:r.id});
   await c.query('UPDATE member_points_gift_allocation SET returned=true WHERE redemption_id=$1 AND lot_id=$2',[r.id,a.lot_id]);
  }
  if(restock)await c.query(`UPDATE catalog_inventory_level SET stock_on_hand=stock_on_hand+$2,version=version+1,updated_by='points:gift-return',updated_at=$3 WHERE sku_id=$1`,[r.sku_id,r.quantity,now]);
  // Returned parcels are not presumed resellable. Stock is restored only for
  // cancellation before dispatch; inspected returns use existing stock controls.
  await offsetPointDebt(c,r.member_id,tx,now);
 }
}
