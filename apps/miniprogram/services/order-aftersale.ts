export type OrderAftersale = {caseId:string;phase:'returning'|'refund_review'|'refunding'|'refund_attention'};
export const aftersaleLabels:Record<OrderAftersale['phase'],string>={
  returning:'退货中',refund_review:'待退款审核',refunding:'退款中',refund_attention:'退款待处理'
};

export type RefundApprovalAction = 'request_refund'|'approve_pending_refund';
export type RefundReviewCase = {
  id:string;
  orderId:string;
  canReview?:boolean;
  canStartRefund?:boolean;
  refundApprovalAllowed?:boolean;
  fulfillment?:{canRefundWithoutReturn:boolean};
  refundRequestId?:string|null;
  refund?:{reviewState:string;reviewVersion?:number}|null;
};

export function refundApprovalAction(row:RefundReviewCase,capabilities:readonly string[]):RefundApprovalAction|null{
  if(row.canReview===false||row.refundApprovalAllowed===false||!capabilities.includes('commerce.refund.approve'))return null;
  if(row.refundRequestId&&row.refund?.reviewState==='requested'&&Number.isSafeInteger(row.refund.reviewVersion))return 'approve_pending_refund';
  if((row.canStartRefund??row.fulfillment?.canRefundWithoutReturn)&&capabilities.includes('commerce.aftersale.review'))return 'request_refund';
  return null;
}
