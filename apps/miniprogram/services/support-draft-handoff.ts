// Text-only, in-memory handoff across support page transitions. Never persist
// private conversation text in device storage.
export const GENERAL_SUPPORT_SCOPE="__general_support__";
let pending:{session:string;orderId:string;text:string;createdAt:number}|null=null;
export type SupportSendAttemptHandoff={id:string;body:string;linkedOrderId:string|null;expectedConversationId?:string|null;contextVersion?:number};
let pendingAttempt:{session:string;orderId:string;attempt:SupportSendAttemptHandoff;createdAt:number}|null=null;
const lifetimeMs=10*60*1000;
let recoveryOwner='';
let recoveryRevision=-1;
const recoveries=new Map<string,{value:unknown;expiresAt:number}>();

export function clearSupportDraftHandoffs() {
  pending=null;
  pendingAttempt=null;
  recoveries.clear();
  recoveryOwner='';
  recoveryRevision=-1;
}

// The full-chat recovery may also carry an attachment or operator reply target.
// Both owner and API context must still match before the page rechecks the conversation.
function recoveryScope(owner:string,revision:number) {
  if(owner!==recoveryOwner||revision!==recoveryRevision) {
    recoveries.clear();
    recoveryOwner=owner;
    recoveryRevision=revision;
  }
}

export function stageSupportRecovery<T>(owner:string,revision:number,scope:string,value:T) {
  recoveryScope(owner,revision);
  if(!owner||!scope)return;
  const now=Date.now();
  for(const [key,entry] of recoveries)if(entry.expiresAt<now)recoveries.delete(key);
  recoveries.set(scope,{value,expiresAt:now+lifetimeMs});
}

export function takeSupportRecovery<T>(owner:string,revision:number,scope:string):T|null {
  recoveryScope(owner,revision);
  const entry=recoveries.get(scope);
  recoveries.delete(scope);
  return entry&&entry.expiresAt>=Date.now()?entry.value as T:null;
}

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
  const linkedOrderId=orderId===GENERAL_SUPPORT_SCOPE?null:orderId;
  pendingAttempt=session&&orderId&&attempt?.id&&attempt.body.trim()&&attempt.linkedOrderId===linkedOrderId
    ?{session,orderId,attempt:{...attempt},createdAt:Date.now()}:null;
}

export function takeSupportSendAttempt(session:string,orderId:string):SupportSendAttemptHandoff|null{
  const value=pendingAttempt;
  pendingAttempt=null;
  if(!value||!session||value.session!==session||value.orderId!==orderId||Date.now()-value.createdAt>lifetimeMs)return null;
  return value.attempt;
}
