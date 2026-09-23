// Text-only, in-memory handoff between an order's support sheet and the full
// support page. Never persist private conversation text in device storage.
let pending:{session:string;orderId:string;text:string;createdAt:number}|null=null;
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
