import { request } from './api';

export type OrderAftersale = {caseId:string;phase:'returning'|'refund_review'|'refunding'|'refund_attention'};
export const aftersaleLabels:Record<OrderAftersale['phase'],string>={
  returning:'退货中',refund_review:'待退款审核',refunding:'退款中',refund_attention:'退款待处理'
};

export type RefundApprovalAction = 'request_refund'|'approve_pending_refund';
export type ManagementAftersaleAction = RefundApprovalAction|'reject_pending_refund'|'approve_return'|'reject'|'request_info'|
  'send_return_instruction'|'receive_return'|'inspect_return'|'approve_refund_without_return'|'reopen_refund'|'resolve_old_route';
export type RefundReviewCase = {
  id:string;
  orderId:string;
  state?:string;
  kind?:string;
  version?:number;
  orderNumber?:string;
  reason?:string;
  amountCents?:number;
  lines?:Array<{lineId:string;productName:string;skuLabel:string;quantity:number}>;
  claimBasis?:string;
  canReview?:boolean;
  canStartRefund?:boolean;
  partialBeforeDispatch?:boolean;
  refundApprovalAllowed?:boolean;
  fulfillment?:{state?:string;canRefundWithoutReturn:boolean};
  refundRequestId?:string|null;
  refund?:{reviewState:string;reviewVersion?:number;channelState?:string|null}|null;
  returnTracking?:string|null;
  shippedInstructionVersion?:number|null;
  returnDestination?:{version:number}|null;
  routeReviewOutcome?:string|null;
};

export function aftersaleContact(caseId:string){
  return request<{caseId:string;orderId:string;conversationId:string}>({
    path:`/v1/management/aftersales/${encodeURIComponent(caseId)}/contact`,method:'POST',data:{},cacheTags:['support']
  });
}

export function refundApprovalAction(row:RefundReviewCase,capabilities:readonly string[]):RefundApprovalAction|null{
  if(row.canReview===false||row.refundApprovalAllowed===false||!capabilities.includes('commerce.refund.approve'))return null;
  if(row.refundRequestId&&row.refund?.reviewState==='requested'&&Number.isSafeInteger(row.refund.reviewVersion))return 'approve_pending_refund';
  if((row.canStartRefund??row.fulfillment?.canRefundWithoutReturn)&&capabilities.includes('commerce.aftersale.review'))return 'request_refund';
  return null;
}

export const managementAftersaleLabels: Record<ManagementAftersaleAction,string> = {
  request_refund:'同意退款',approve_pending_refund:'同意退款',reject_pending_refund:'拒绝退款',
  approve_return:'同意退货',reject:'拒绝申请',request_info:'补充材料',
  send_return_instruction:'发送退货地址',receive_return:'确认收件',inspect_return:'提交质检',
  approve_refund_without_return:'无需寄回处理',reopen_refund:'恢复处理',resolve_old_route:'处理旧址退货'
};

export function managementAftersaleActions(row:RefundReviewCase, capabilities:readonly string[]) {
  if (row.canReview === false) return [];
  const items: Array<{action:ManagementAftersaleAction;label:string}> = [];
  const add = (action:ManagementAftersaleAction, label = managementAftersaleLabels[action]) => items.push({action,label});
  const refundApproval=refundApprovalAction(row,capabilities);
  if (refundApproval === 'approve_pending_refund') {
    add('approve_pending_refund');
    add('reject_pending_refund');
  }
  const state=row.state??'';
  if (capabilities.includes('commerce.aftersale.review')) {
    const unshipped=row.fulfillment?.canRefundWithoutReturn===true;
    if (row.canStartRefund??(unshipped||['quality_checked','refund_exception_approved'].includes(state)))
      add('request_refund',refundApproval==='request_refund'?'同意退款':'提交退款复核');
    if (state==='requested') {
      if (!unshipped&&row.kind==='return_refund') add('approve_return');
      add('request_info');
    }
    if (state==='requested'||state==='need_info') add('reject',unshipped?'拒绝退款':'拒绝申请');
    if (['awaiting_instruction','awaiting_return'].includes(state)&&row.kind==='return_refund'&&!row.returnTracking&&row.shippedInstructionVersion==null)
      add('send_return_instruction');
    if (['requested','need_info','awaiting_instruction','awaiting_return','return_in_transit'].includes(state)
      &&!unshipped&&(row.kind==='return_refund'||['delivery_issue','missing_item'].includes(row.claimBasis??'')))
      add('approve_refund_without_return');
    if (state==='refund_pending'&&(row.refund?.reviewState==='rejected'||row.refund?.channelState==='closed')) add('reopen_refund');
    if (['awaiting_return','return_in_transit','return_received'].includes(state)&&row.shippedInstructionVersion!=null
      &&row.shippedInstructionVersion<Number(row.returnDestination?.version??0)
      &&(row.routeReviewOutcome===null||row.routeReviewOutcome==='carrier_contacted')) add('resolve_old_route');
  }
  if (state==='return_in_transit'&&capabilities.includes('commerce.return.receive')) add('receive_return');
  if (state==='return_received'&&capabilities.includes('commerce.return.inspect')) add('inspect_return');
  return items;
}

export function pendingRefundDecision(row:RefundReviewCase, decision:'approve'|'reject', reason:string) {
  return {
    path:`/v1/management/refund-requests/${encodeURIComponent(row.refundRequestId!)}/decision`,
    data:{decision,expectedVersion:row.refund!.reviewVersion,reason}
  };
}
