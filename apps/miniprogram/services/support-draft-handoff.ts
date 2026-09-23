// Text-only, in-memory handoff between an order's support sheet and the full
// support page. Never persist private conversation text in device storage.
let pending:{session:string;orderId:string;text:string;createdAt:number}|null=null;
export type SupportSendAttemptHandoff={id:string;body:string;linkedOrderId:string};
let pendingAttempt:{session:string;orderId:string;attempt:SupportSendAttemptHandoff;createdAt:number}|null=null;
const lifetimeMs=10*60*1000;

export function stageSupportDraft(session:string,orderId:string,text:string):void{
  pending=session&&orderId&&text.trim()?{session,orderId,text,createdAt:Date.now()}:null;
}

export function takeSupportDraft(session:string,orderId:string):string|null{
  const value=pending;
  pending=null;
  if(!value||!session||value.session!==session||value.orderId!==orderId||Date.now()-value.createdAt>lifetimeMs)return null;
  return value.text;
}

// Keep an uncertain text-only send in memory across the order sheet / full
// conversation transition. The original client message ID must be reused.
export function stageSupportSendAttempt(session:string,orderId:string,attempt:SupportSendAttemptHandoff|null):void{
  pendingAttempt=session&&orderId&&attempt?.id&&attempt.body.trim()&&attempt.linkedOrderId===orderId
    ?{session,orderId,attempt:{...attempt},createdAt:Date.now()}:null;
}

export function takeSupportSendAttempt(session:string,orderId:string):SupportSendAttemptHandoff|null{
  const value=pendingAttempt;
  pendingAttempt=null;
  if(!value||!session||value.session!==session||value.orderId!==orderId||Date.now()-value.createdAt>lifetimeMs)return null;
  return value.attempt;
}
