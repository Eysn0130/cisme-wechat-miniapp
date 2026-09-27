/** Ephemeral handoff for the WeChat receipt component. A process restart
 * cannot turn a persisted client flag into proof of receipt. */
type Status='success'|'fail'|'cancel';
type Pending={orderId:string;sessionToken:string;transactionId:string;startedAt:number;result?:Status};
let pending:Pending|null=null;
const componentAppId='wx1183b055aeec94d1';
const object=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)
  ?value as Record<string,unknown>:null;

export function beginWechatReceiptReturn(orderId:string,sessionToken:string,transactionId:string){
  pending={orderId,sessionToken,transactionId,startedAt:Date.now()};
}
export function clearWechatReceiptReturn(){pending=null;}
export function acceptWechatReceiptReferrer(referrer:unknown){
  if(!pending||Date.now()-pending.startedAt>10*60_000){pending=null;return;}
  const source=object(referrer),data=object(source?.extraData),request=object(data?.req_extradata);
  const requestData=object(request?.extraData)??request;
  if(source?.appId!==componentAppId||!data||!requestData
    ||requestData.transaction_id!==pending.transactionId
    ||data.transaction_id!==undefined&&data.transaction_id!==pending.transactionId
    ||!['success','fail','cancel'].includes(String(data.status)))return;
  pending.result=data.status as Status;
}
export function takeWechatReceiptReturn(orderId:string,sessionToken:string):Status|null{
  if(!pending)return null;
  if(pending.orderId!==orderId||pending.sessionToken!==sessionToken
    ||Date.now()-pending.startedAt>10*60_000){pending=null;return null;}
  if(!pending.result)return null;
  const result=pending.result;pending=null;return result;
}
