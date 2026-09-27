import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction } from "./db.js";
import { AuthorityService } from "./authority.js";
import { WechatPayV3Client } from "./wechatPayV3.js";
import { finishPage, pageLimit, pageScope, readPageCursor } from "./keysetPage.js";

type BillType="SUCCESS"|"REFUND";
type BillRow={rowNumber:number;outTradeNo:string;outRefundNo:string|null;providerNo:string;
  amountCents:number;cashRefundCents:number|null;merchantId:string;appId:string;
  payerOpenid:string;currency:string;couponCents:number;refundRequestedAt:string|null};
type Checked=BillRow&{status:"matched"|"exception";exceptionCode:string|null;relatedId:string|null};
const columns={trade:"商户订单号",refund:"商户退款单号",merchant:"商户号",provider:"微信订单号",
  providerRefund:"微信退款单号",amount:"订单金额",refundAmount:"申请退款金额",
  cashRefund:"退款金额",refundRequestedAt:"退款申请时间",currency:"货币种类",app:"公众账号ID",payer:"用户标识",coupon:"代金券金额"};
function invalid(message:string):never{throw new DomainError("TRADE_BILL_INVALID",message,422);}
function cents(raw:string){
  if(!/^\d{1,8}\.\d{2}$/.test(raw))invalid("账单金额必须是两位小数的人民币元");
  const [yuan,fen]=raw.split(".");return Number(yuan)*100+Number(fen);
}
function clean(value:string){return value.trim().replace(/^`/,"");}
/** CSV quote handling is strict because imported bill columns carry identifiers and money. */
function csv(raw:string){
  if(raw.length>10_000_000||raw.includes("\0"))invalid("交易账单文件过大或格式无效");
  const rows:string[][]=[];let row:string[]=[],field="",quoted=false,closedQuote=false;
  for(let i=0;i<raw.length;i++){
    const char=raw[i]!;
    if(closedQuote&&char!==","&&char!=="\n"&&char!=="\r")invalid("交易账单结束引号后存在多余内容");
    if(char==='"'){
      if(quoted&&raw[i+1]==='"'){field+='"';i++;}
      else if(!quoted&&field.length===0)quoted=true;
      else if(quoted){quoted=false;closedQuote=true;}
      else invalid("交易账单引号格式无效");
    }else if(char===","&&!quoted){row.push(clean(field));field="";closedQuote=false;}
    else if((char==="\n"||char==="\r")&&!quoted){
      if(char==="\r"&&raw[i+1]==="\n")i++;
      row.push(clean(field));if(row.some(Boolean))rows.push(row);row=[];field="";closedQuote=false;
    }else field+=char;
  }
  if(quoted)invalid("交易账单引号未闭合");
  row.push(clean(field));if(row.some(Boolean))rows.push(row);
  return rows;
}
export function parseTradeBill(bytes:Uint8Array,type:BillType):BillRow[]{
  if(bytes.byteLength>10_000_000)invalid("交易账单文件过大");
  let decoded:string;
  try{decoded=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}
  catch{invalid("交易账单字符编码无效");}
  const all=csv(decoded.replace(/^\uFEFF/,""));
  const headerIndex=all.findIndex(row=>row.includes("商户订单号")&&row.includes("商户号"));
  if(headerIndex<0)invalid("交易账单缺少明细表头");
  const header=all[headerIndex]!;
  if(new Set(header).size!==header.length)invalid("交易账单存在重复字段");
  const required=[columns.trade,columns.merchant,columns.currency,
    ...(type==="SUCCESS"?[columns.provider,columns.amount,columns.app,columns.payer]:
      [columns.refund,columns.providerRefund,columns.refundAmount,columns.cashRefund,columns.refundRequestedAt])];
  for(const name of required)if(!header.includes(name))invalid(`交易账单缺少字段：${name}`);
  const value=(row:string[],name:string)=>row[header.indexOf(name)]??"";
  const items:BillRow[]=[];
  for(const row of all.slice(headerIndex+1)){
    if(row[0]?.includes("总交易单数")||row[0]?.includes("总退款单数"))break;
    if(row.length!==header.length)invalid("交易账单明细列数不一致");
    const trade=value(row,columns.trade),refund=type==="REFUND"?value(row,columns.refund):null,
      provider=value(row,type==="SUCCESS"?columns.provider:columns.providerRefund),
      amount=cents(value(row,type==="SUCCESS"?columns.amount:columns.refundAmount));
    if(!/^[A-Za-z0-9_-]{6,64}$/.test(trade)||
      (refund!==null&&!/^[A-Za-z0-9_-]{8,64}$/.test(refund))||
      !/^[A-Za-z0-9_-]{8,200}$/.test(provider)||amount<1||amount>9_900_000_000)
      invalid("交易账单商户单号、渠道单号或金额无效");
    const requested=type==="REFUND"?value(row,columns.refundRequestedAt):null;
    if(type==="REFUND"){
      const utc=/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(requested!)
        ?Date.parse(`${requested!.replace(" ","T")}+08:00`):NaN;
      if(!Number.isFinite(utc)||new Date(utc+8*3_600_000).toISOString().slice(0,19)
        .replace("T"," ")!==requested)invalid("退款账单缺少有效的渠道受理时间");
    }
    items.push({rowNumber:items.length+1,outTradeNo:trade,outRefundNo:refund,providerNo:provider,
      amountCents:amount,cashRefundCents:type==="REFUND"?cents(value(row,columns.cashRefund)):null,
      merchantId:value(row,columns.merchant),appId:value(row,columns.app),payerOpenid:value(row,columns.payer),
      currency:value(row,columns.currency),refundRequestedAt:requested,
      couponCents:header.includes(columns.coupon)?cents(value(row,columns.coupon)):0});
    if(items.length>10000)invalid("交易账单超过单次可核对行数");
  }
  return items;
}

/** Immutable import of signed-application, hash-checked trade bill evidence.
 * A bill line cannot create a payment, finalize a refund, or edit commission. */
export class TradeBillReconciliationService{
  constructor(private readonly pool:pg.Pool,private readonly authority:AuthorityService,
    private readonly channel:WechatPayV3Client,private readonly merchantId:string){}
  async list(actorId:string|undefined,query:{limit?:string;cursor?:string}={}){
    await this.authority.require(actorId,"commerce.money.reconcile");
    const limit=pageLimit(query.limit),scope=pageScope(["trade-bills",this.merchantId]),
      cursor=readPageCursor(query.cursor,scope);
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actorId,"commerce.money.reconcile");
      const totalCount=(await client.query<{n:number}>(`SELECT count(*)::int AS n
        FROM commerce_trade_bill_batch WHERE merchant_id=$1`,[this.merchantId])).rows[0]?.n??0;
      const rows=(await client.query(`SELECT id,bill_date::text AS bill_date,bill_type,row_count,matched_count,
        exception_count,imported_at,to_char(imported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM commerce_trade_bill_batch WHERE merchant_id=$1
        AND ($2::timestamptz IS NULL OR (imported_at,id)<($2::timestamptz,$3::uuid))
        ORDER BY imported_at DESC,id DESC LIMIT $4`,[this.merchantId,cursor?.at??null,cursor?.id??null,
          limit+1])).rows;
      return {...finishPage(rows.map(row=>({id:row.id,cursorAt:row.cursor_at,
        billDate:row.bill_date,billType:row.bill_type,rowCount:row.row_count,
        matchedCount:row.matched_count,exceptionCount:row.exception_count,
        createdAt:row.imported_at})),limit,scope),totalCount};
    },"REPEATABLE READ");
  }
  async import(actorId:string|undefined,date:string,type:BillType){
    await this.authority.require(actorId,"commerce.money.reconcile");
    if(type!=="SUCCESS"&&type!=="REFUND")invalid("交易账单类型无效");
    const source=await this.channel.downloadTradeBill(date,type);
    const rows=parseTradeBill(source.bytes,type);
    const known=new Set<string>();
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,actorId,"commerce.money.reconcile");
      // A row lock cannot serialize the first import when no batch exists.
      // Scope the lock to the same merchant/date/type as the unique batch key.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['trade-bill',this.merchantId,date,type])]);
      const existing=(await client.query(`SELECT id,source_sha256,row_count,matched_count,exception_count
        FROM commerce_trade_bill_batch WHERE bill_date=$1 AND bill_type=$2 AND merchant_id=$3 FOR UPDATE`,
        [date,type,this.merchantId])).rows[0];
      if(existing){
        if(existing.source_sha256!==source.sourceSha256)throw new DomainError("TRADE_BILL_CHANGED",
          "同一日期与类型的渠道账单摘要发生变化，需要人工核实",409);
        return {id:existing.id,billDate:date,billType:type,rowCount:existing.row_count,
          matchedCount:existing.matched_count,exceptionCount:existing.exception_count,replayed:true};
      }
      const tradeNos=[...new Set(rows.map(row=>row.outTradeNo))];
      const refundNos=[...new Set(rows.map(row=>row.outRefundNo).filter((no):no is string=>Boolean(no)))];
      const paymentRows=(await client.query(`SELECT DISTINCT ON (a.out_trade_no) a.order_id AS id,
        a.out_trade_no,a.merchant_id,a.app_id,a.payer_openid,a.amount_cents,o.status,
        p.provider_transaction_id,p.state AS inbox_state,
        EXISTS(SELECT 1 FROM commission_payment_composition_observation c
          WHERE c.order_id=a.order_id) AS composition_conflict
        FROM commerce_payment_attempt a JOIN commerce_order o ON o.id=a.order_id
        LEFT JOIN commission_payment_inbox p ON p.order_id=a.order_id
        WHERE a.out_trade_no=ANY($1::text[]) ORDER BY a.out_trade_no,p.applied_at DESC NULLS LAST`,[tradeNos])).rows;
      const refundRows=refundNos.length?(await client.query(`SELECT i.id,i.out_refund_no,i.refund_cents,
        i.payer_refund_cents,o.order_number,ob.provider_refund_id,ob.accepted_local,
        ob.conflicting AS acceptance_conflict
        FROM commission_refund_intent i JOIN commerce_order o ON o.id=i.order_id
        LEFT JOIN LATERAL (SELECT min(provider_refund_id) AS provider_refund_id,
          to_char(min(accepted_at) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') AS accepted_local,
          count(DISTINCT (provider_refund_id,accepted_at))>1 AS conflicting
          FROM commission_refund_channel_observation WHERE refund_intent_id=i.id) ob ON true
        WHERE i.out_refund_no=ANY($1::text[])`,[refundNos])).rows:[];
      const payments=new Map(paymentRows.map(row=>[row.out_trade_no,row]));
      const refunds=new Map(refundRows.map(row=>[row.out_refund_no,row]));
      const checked:Checked[]=rows.map(row=>{
        const key=type==="SUCCESS"?row.outTradeNo:`${row.outTradeNo}:${row.outRefundNo}`;
        let code:string|null=null,relatedId:string|null=null;
        if(known.has(key))code="DUPLICATE_BILL_ROW";else known.add(key);
        if(!code&&row.merchantId!==this.merchantId)code="MERCHANT_MISMATCH";
        if(!code&&row.currency!=="CNY")code="CURRENCY_MISMATCH";
        if(!code&&row.couponCents!==0)code="UNSUPPORTED_COUPON";
        if(type==="SUCCESS"){
          const found=payments.get(row.outTradeNo);relatedId=found?.id??null;
          if(!code&&!found)code="PAYMENT_MISSING_INTERNAL";
          if(!code&&(found.merchant_id!==row.merchantId||found.app_id!==row.appId||
            found.payer_openid!==row.payerOpenid||Number(found.amount_cents)!==row.amountCents||
            found.provider_transaction_id!==row.providerNo))code="PAYMENT_FACT_MISMATCH";
          if(!code&&found.composition_conflict)code="PAYMENT_COMPOSITION_CONFLICT";
          if(!code&&(found.status!=="paid"||found.inbox_state!=="applied"))code="PAYMENT_NOT_APPLIED";
        }else{
          const found=refunds.get(row.outRefundNo!);relatedId=found?.id??null;
          if(!code&&!found)code="REFUND_MISSING_INTERNAL";
          if(!code&&found.acceptance_conflict)code="REFUND_ACCEPTANCE_CONFLICT";
          if(!code&&!found.accepted_local)code="REFUND_ACCEPTANCE_UNVERIFIED";
          if(!code&&(found.order_number!==row.outTradeNo||
            Number(found.refund_cents)!==row.amountCents||
            Number(found.payer_refund_cents)!==row.cashRefundCents||
            found.provider_refund_id!==row.providerNo))code="REFUND_FACT_MISMATCH";
          if(!code&&(found.accepted_local!==row.refundRequestedAt||row.refundRequestedAt?.slice(0,10)!==date))
            code="REFUND_ACCEPTANCE_TIME_MISMATCH";
        }
        return {...row,status:code?"exception":"matched",exceptionCode:code,relatedId};
      });
      if(type==="SUCCESS"){
        // A provider-only comparison can falsely clear an empty signed bill.
        // Include *every authenticated* payment fact, including quarantined
        // coupon/unknown-composition and late-closed payments. Otherwise an
        // empty channel bill could falsely clear a real but unposted receipt.
        const internal=(await client.query<{order_id:string;out_trade_no:string;provider_transaction_id:string;
          app_id:string;payer_openid:string;amount_cents:string}>(`SELECT p.order_id,a.out_trade_no,p.provider_transaction_id,
          a.app_id,a.payer_openid,p.amount_cents FROM commission_payment_inbox p
          JOIN commerce_payment_attempt a ON a.order_id=p.order_id
          WHERE p.merchant_id=$1
            AND (p.verified_paid_at AT TIME ZONE 'Asia/Shanghai')::date=$2::date`,
          [this.merchantId,date])).rows;
        const present=new Set(rows.map(row=>row.outTradeNo));
        for(const fact of internal){
          if(present.has(fact.out_trade_no))continue;
          if(checked.length>=10000)invalid("待核对的渠道及内部支付事实超过单批上限");
          checked.push({rowNumber:checked.length+1,outTradeNo:fact.out_trade_no,outRefundNo:null,
            providerNo:fact.provider_transaction_id,amountCents:Number(fact.amount_cents),cashRefundCents:null,
            merchantId:this.merchantId,appId:fact.app_id,payerOpenid:fact.payer_openid,currency:"CNY",
            couponCents:0,refundRequestedAt:null,status:"exception",exceptionCode:"PAYMENT_MISSING_PROVIDER_BILL",relatedId:fact.order_id});
        }
      }else{
        // The REFUND trade bill is dated by merchant refund acceptance, NOT
        // by final SUCCESS/arrival to the payer. Only signed channel responses
        // with an unambiguous create_time can support the reverse direction.
        const internal=(await client.query<{id:string;out_refund_no:string;order_number:string;
          provider_refund_id:string;refund_cents:string;payer_refund_cents:string}>(`SELECT
          i.id,i.out_refund_no,o.order_number,min(ob.provider_refund_id) AS provider_refund_id,
          i.refund_cents,i.payer_refund_cents
          FROM commission_refund_intent i JOIN commerce_order o ON o.id=i.order_id
          JOIN commission_payment_inbox p ON p.id=i.payment_inbox_id AND p.merchant_id=$1
          JOIN commission_refund_channel_observation ob ON ob.refund_intent_id=i.id
          WHERE (ob.accepted_at AT TIME ZONE 'Asia/Shanghai')::date=$2::date
          GROUP BY i.id,o.order_number,i.out_refund_no,i.refund_cents,i.payer_refund_cents
          HAVING count(DISTINCT (ob.provider_refund_id,ob.accepted_at))=1`,
          [this.merchantId,date])).rows;
        const present=new Set(rows.map(row=>row.outRefundNo));
        for(const fact of internal){
          if(present.has(fact.out_refund_no))continue;
          if(checked.length>=10000)invalid("待核对的渠道及内部退款事实超过单批上限");
          checked.push({rowNumber:checked.length+1,outTradeNo:fact.order_number,
            outRefundNo:fact.out_refund_no,providerNo:fact.provider_refund_id,
            amountCents:Number(fact.refund_cents),cashRefundCents:Number(fact.payer_refund_cents),
            merchantId:this.merchantId,appId:"",payerOpenid:"",currency:"CNY",couponCents:0,
            refundRequestedAt:null,status:"exception",exceptionCode:"REFUND_MISSING_PROVIDER_BILL",relatedId:fact.id});
        }
      }
      const matched=checked.filter(row=>row.status==="matched").length;
      const batch=(await client.query(`INSERT INTO commerce_trade_bill_batch
        (bill_date,bill_type,merchant_id,source_sha1,source_sha256,row_count,matched_count,exception_count,imported_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [date,type,this.merchantId,source.sourceSha1,source.sourceSha256,checked.length,matched,
          checked.length-matched,actorId])).rows[0];
      if(checked.length)await client.query(`INSERT INTO commerce_trade_bill_row
        (batch_id,row_number,out_trade_no,out_refund_no,provider_no,amount_cents,status,exception_code,related_id)
        SELECT $1,x.row_number,x.out_trade_no,x.out_refund_no,x.provider_no,x.amount_cents,
          x.status,x.exception_code,x.related_id FROM jsonb_to_recordset($2::jsonb) AS x(
          row_number int,out_trade_no text,out_refund_no text,provider_no text,amount_cents bigint,
          status text,exception_code text,related_id uuid)`,[batch.id,JSON.stringify(checked.map(row=>({
            row_number:row.rowNumber,out_trade_no:row.outTradeNo,out_refund_no:row.outRefundNo,
            provider_no:row.providerNo,amount_cents:row.amountCents,status:row.status,
            exception_code:row.exceptionCode,related_id:row.relatedId})))]);
      return {id:batch.id,billDate:date,billType:type,rowCount:checked.length,
        matchedCount:matched,exceptionCount:checked.length-matched,replayed:false};
    });
  }
}
