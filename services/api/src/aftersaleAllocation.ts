import { DomainError } from '@cisme/domain';

type OrderLine={id:string;quantity:number;line_total_cents:string|number;credit_tender_cents:string|number};
type Selection={lineId:string;quantity:number};
export type AllocatedClaimLine={lineId:string;quantity:number;amountCents:number;cashRefundCents:number;
  creditRefundCents:number;eligibleCashRefundCents:number;otherCashRefundCents:number;
  allocationPolicyVersion:'quantity-net-components-v1'};

function integer(value:unknown,field:string){const number=Number(value);
  if(!Number.isSafeInteger(number)||number<0)throw new DomainError('AFTERSALE_COMPONENT_INVALID',`${field}金额无效`,409);
  return number;
}
function prefix(amount:number,count:number,quantity:number){return Number(BigInt(amount)*BigInt(count)/BigInt(quantity));}
function roundRatio(amount:number,numerator:number,denominator:number){
  return Number((BigInt(amount)*BigInt(numerator)+BigInt(Math.floor(denominator/2)))/BigInt(denominator));
}

/** The paid per-line net amount already includes item and order discounts.
 * Each selected quantity receives its cumulative integer-cent slice; freight
 * is allocated by the cumulative selected merchandise value. All remaining
 * quantities together recover exactly the original paid components. */
export function allocateAftersaleClaim(input:{lines:OrderLine[];shippingCents:number;eligibleCashCents:number;
  prior:Selection[];selected:Selection[]|null}){
  const shipping=integer(input.shippingCents,'运费'),eligibleTotal=integer(input.eligibleCashCents,'计佣');
  if(!input.lines.length||new Set(input.lines.map(line=>line.id)).size!==input.lines.length)
    throw new DomainError('AFTERSALE_LINES_MISSING','商品事实缺失',409);
  const prior=new Map<string,number>();
  for(const item of input.prior){if(!Number.isSafeInteger(item.quantity)||item.quantity<1)
    throw new DomainError('AFTERSALE_PRIOR_QUANTITY_INVALID','历史售后数量无效',409);
    prior.set(item.lineId,(prior.get(item.lineId)??0)+item.quantity);}
  if(input.selected&&(!input.selected.length||new Set(input.selected.map(item=>item.lineId)).size!==input.selected.length))
    throw new DomainError('AFTERSALE_SELECTION_INVALID','请选择商品及数量',422);
  const wanted=new Map((input.selected??[]).map(item=>[item.lineId,item.quantity]));
  const known=new Set(input.lines.map(line=>line.id));
  if([...prior.keys(),...wanted.keys()].some(id=>!known.has(id)))
    throw new DomainError('AFTERSALE_SELECTION_INVALID','售后商品与原订单不一致',422);
  let remainingEligible=eligibleTotal,merchandiseTotal=0,priorMerchandise=0,selectedMerchandise=0;
  let priorUnits=0,selectedUnits=0,totalUnits=0;
  const lines:AllocatedClaimLine[]=[];
  for(const line of input.lines){
    const quantity=integer(line.quantity,'数量'),gross=integer(line.line_total_cents,'商品'),credit=integer(line.credit_tender_cents,'权益');
    if(quantity<1||credit>gross)throw new DomainError('AFTERSALE_COMPONENT_INVALID','商品支付组成无效',409);
    const already=prior.get(line.id)??0,take=input.selected?wanted.get(line.id)??0:quantity-already;
    if(!Number.isSafeInteger(take)||take<0||already+take>quantity||input.selected&&take===0&&wanted.has(line.id))
      throw new DomainError('AFTERSALE_QUANTITY_EXCEEDS_REMAINING','申请数量超过本单尚可申请的数量',409);
    const lineCash=gross-credit,lineEligible=Math.min(lineCash,remainingEligible);
    remainingEligible-=lineEligible;merchandiseTotal+=gross;totalUnits+=quantity;
    const priorGross=prefix(gross,already,quantity),afterGross=prefix(gross,already+take,quantity);
    const priorCredit=prefix(credit,already,quantity),afterCredit=prefix(credit,already+take,quantity);
    const priorCash=priorGross-priorCredit,cash=(afterGross-afterCredit)-priorCash;
    const eligible=lineCash?prefix(lineEligible,priorCash+cash,lineCash)-prefix(lineEligible,priorCash,lineCash):0;
    priorMerchandise+=priorGross;priorUnits+=already;
    selectedMerchandise+=afterGross-priorGross;selectedUnits+=take;
    if(take)lines.push({lineId:line.id,quantity:take,amountCents:afterGross-priorGross,
      cashRefundCents:cash,creditRefundCents:afterCredit-priorCredit,
      eligibleCashRefundCents:eligible,otherCashRefundCents:cash-eligible,
      allocationPolicyVersion:'quantity-net-components-v1'});
  }
  if(remainingEligible||!lines.length)throw new DomainError('AFTERSALE_SELECTION_INVALID','本单已无可申请商品',409);
  const denominator=merchandiseTotal||totalUnits;
  const before=merchandiseTotal?priorMerchandise:priorUnits;
  const after=merchandiseTotal?priorMerchandise+selectedMerchandise:priorUnits+selectedUnits;
  const shippingRefundCents=roundRatio(shipping,after,denominator)-roundRatio(shipping,before,denominator);
  const merchandiseRefundCents=lines.reduce((sum,line)=>sum+line.amountCents,0);
  return {lines,shippingRefundCents,amountCents:merchandiseRefundCents+shippingRefundCents,
    cashRefundCents:lines.reduce((sum,line)=>sum+line.cashRefundCents,shippingRefundCents),
    creditRefundCents:lines.reduce((sum,line)=>sum+line.creditRefundCents,0)};
}
