import { startWorkerLoop } from "./loop.js";
import { VerifiedPaymentInbox } from "../../api/src/verifiedPaymentInbox.js";
import { VerifiedRefundInbox } from "../../api/src/verifiedRefundInbox.js";
import { RefundCommandService } from "../../api/src/refundCommand.js";
import { SettlementCommandService } from "../../api/src/settlementCommand.js";
import { TransferCallbackInbox } from "../../api/src/transferCallbackInbox.js";

export async function runMoneyWorkerCycle(payment:VerifiedPaymentInbox,refund?:VerifiedRefundInbox,
  refundCommands?:RefundCommandService,settlement?:SettlementCommandService,
  transferCallbacks?:TransferCallbackInbox){
  const submissions=refundCommands?await refundCommands.processDue(20):[];
  const reconciliations=refundCommands?await refundCommands.reconcileAccepted(20):[];
  const payments=await payment.processPending(20);
  const refunds=refund?await refund.processPending(20):[];
  const transfers=settlement?await settlement.processDue(20):[];
  const callbacks=settlement&&transferCallbacks?await transferCallbacks.processPending(settlement,20):[];
  return {submissions,reconciliations,payments,refunds,transfers,callbacks};
}

export function startMoneyBackgroundWorker(payment:VerifiedPaymentInbox,refund:VerifiedRefundInbox|undefined,
  refundCommands:RefundCommandService|undefined,settlement:SettlementCommandService|undefined,
  transferCallbacks:TransferCallbackInbox|undefined,onError:(error:unknown)=>void){
  return startWorkerLoop(async()=>{
    const result=await runMoneyWorkerCycle(payment,refund,refundCommands,settlement,transferCallbacks);
    return result.submissions.length===20||result.reconciliations.length===20||
      result.payments.length===20||result.refunds.length===20||result.transfers.length===20||
      result.callbacks.length===20;
  },onError,2_000);
}
