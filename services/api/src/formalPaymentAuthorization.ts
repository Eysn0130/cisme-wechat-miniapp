import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import type { AppConfig } from '@cisme/config';
import { DomainError } from '@cisme/domain';

export type RecoveryCapability='payment.query'|'refund.query'|'bill.read'|'payment.callback'|'refund.callback';
const capabilities:readonly string[]=['payment.query','refund.query','bill.read','payment.callback','refund.callback'];
type Profile=NonNullable<AppConfig['commerce']['formalProtocol']>;
/** Only explicitly configured files are opened. No secret-directory discovery,
 * symlink following or writable-by-other-user approval files. */
export function protectedText(path:string):string{
  if(!path.startsWith('/')||path.includes('\0'))throw new Error('FAIL_CLOSED:PROTECTED_PATH_REQUIRED');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const s=fstatSync(fd);
    if(!s.isFile()||s.size>65536||(s.mode&0o077)!==0||
      (typeof process.getuid==='function'&&s.uid!==process.getuid()&&s.uid!==0))
      throw new Error('FAIL_CLOSED:PROTECTED_FILE_PERMISSIONS');
    return readFileSync(fd,'utf8');
  }finally{closeSync(fd);}
}

export function recoveryAuthorization(config:AppConfig,profile:Profile,now=()=>Date.now()){
  const path=profile.recoveryAuthorizationFile;
  const read=()=>{
    if(!path)throw new DomainError('FORMAL_PAYMENT_RECOVERY_NOT_AUTHORIZED','正式支付恢复尚未授权',503);
    let grant:Record<string,unknown>;
    try{grant=JSON.parse(protectedText(path));}catch{throw new Error('FAIL_CLOSED:FORMAL_RECOVERY_GRANT_INVALID');}
    if(!grant||grant.schemaVersion!==1||grant.mode!=='ordinary-merchant-recovery-only'||
      !['staging','production'].includes(config.env)||grant.environment!==config.env||
      grant.appId!==profile.appId||grant.merchantId!==profile.merchantId||
      typeof grant.approvalReference!=='string'||!/^[-A-Za-z0-9_:.]{8,120}$/.test(grant.approvalReference)||
      typeof grant.expiresAt!=='string'||!Number.isFinite(Date.parse(grant.expiresAt))||Date.parse(grant.expiresAt)<=now()||
      !Array.isArray(grant.capabilities)||!grant.capabilities.length||
      grant.capabilities.some(c=>typeof c!=='string'||!capabilities.includes(c))||
      new Set(grant.capabilities).size!==grant.capabilities.length)
      throw new Error('FAIL_CLOSED:FORMAL_RECOVERY_GRANT_BINDING');
    return grant;
  };
  if(path)read(); // Invalid configured grants fail startup; absence stays inert.
  return (capability:RecoveryCapability)=>{
    const grant=read();
    if(!(grant.capabilities as string[]).includes(capability))
      throw new DomainError('FORMAL_PAYMENT_CAPABILITY_NOT_AUTHORIZED','该支付恢复能力尚未授权',503);
    return String(grant.approvalReference);
  };
}

export function recoveryTransport(authorize:(capability:RecoveryCapability)=>string):typeof fetch{
  return async(input,init)=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    const method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
    let capability:RecoveryCapability|undefined;
    if(method==='GET'&&url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&!url.port){
      if(url.hostname==='api.mch.weixin.qq.com'){
        if(/^\/v3\/pay\/transactions\/out-trade-no\/[A-Za-z0-9_-]{6,32}$/.test(url.pathname))capability='payment.query';
        else if(/^\/v3\/refund\/domestic\/refunds\/[A-Za-z0-9_-]{6,64}$/.test(url.pathname))capability='refund.query';
        else if(url.pathname==='/v3/bill/tradebill')capability='bill.read';
      }
      if(['api.mch.weixin.qq.com','api2.mch.weixin.qq.com'].includes(url.hostname)&&url.pathname.startsWith('/v3/billdownload/'))capability='bill.read';
    }
    if(!capability)throw new DomainError('FORMAL_PAYMENT_OUTBOUND_DENIED','正式支付请求不在恢复能力范围',503);
    const approvalReference=authorize(capability); // Re-read on every dispatch; no cached authority.
    const started=Date.now();
    try{
      const response=await fetch(input,{...init,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(15000),...(init?.signal?[init.signal]:[])])});
      const raw=response.headers.get('Request-ID')??'';
      const requestId=/^[A-Za-z0-9_-]{16,128}$/.test(raw)?raw:null;
      console.info(JSON.stringify({event:'formal_payment_recovery_response',capability,approvalReference,
        status:response.status,requestId,elapsedMs:Date.now()-started}));
      return response;
    }catch(error){
      console.info(JSON.stringify({event:'formal_payment_recovery_transport_unknown',capability,approvalReference,
        elapsedMs:Date.now()-started}));
      throw error; // No URL, credential, order number, body or raw error is logged.
    }
  };
}
