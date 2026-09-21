import type pg from 'pg';
import type { AppConfig } from '@cisme/config';
import { startWorkerLoop } from './loop.js';
import { formalPaymentProtocol } from '../../api/src/formalPaymentProtocol.js';
import { RefundCommandService } from '../../api/src/refundCommand.js';
import { AuthorityService } from '../../api/src/authority.js';

/** History-only worker: no processDue, prepay, close, refund create or transfer.
 * Missing/expired independent grants skip their own lane, not other lanes. */
export async function runFormalRecoveryCycle(lanes:Array<{authorize:()=>unknown;run:()=>Promise<unknown>}>){
  const results=[];
  for(const lane of lanes){
    try{lane.authorize();}catch{results.push({status:'not_authorized'});continue;}
    try{await lane.run();results.push({status:'processed'});}
    catch{results.push({status:'failed'});}
  }
  return results;
}
export function startFormalRecoveryWorker(config:AppConfig,pool:pg.Pool,
  protocol:NonNullable<ReturnType<typeof formalPaymentProtocol>>,onError:(error:unknown)=>void){
  const profile=config.commerce.formalProtocol!;
  const refunds=new RefundCommandService(pool,new AuthorityService(pool,config.env),protocol.channel,
    protocol.refundInbox,{merchantId:profile.merchantId,notifyUrl:profile.refundNotifyUrl});
  return startWorkerLoop(async()=>{
    const results=await runFormalRecoveryCycle([
      {authorize:()=>protocol.authorizeRecovery('payment.callback'),run:()=>protocol.inbox.processPending(20)},
      {authorize:()=>protocol.authorizeRecovery('refund.callback'),run:()=>protocol.refundInbox.processPending(20)},
      {authorize:()=>protocol.authorizeRecovery('refund.query'),run:()=>refunds.reconcileAccepted(20)}
    ]);
    if(results.some(r=>r.status==='failed'))onError(new Error('FORMAL_RECOVERY_LANE_FAILED'));
    return false;
  },onError,5000);
}
