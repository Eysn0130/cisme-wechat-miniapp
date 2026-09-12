import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction } from "./db.js";

export type MoneyInboxKind="payment"|"refund";
const table=(kind:MoneyInboxKind)=>kind==="payment"?"commission_payment_inbox":"commission_refund_inbox";
const maximumAttempts=8;
function errorCode(error:unknown):{code:string;permanent:boolean}{
  if(error instanceof DomainError)return {code:error.code,permanent:error.status<500};
  const code=typeof(error as {code?:unknown})?.code==="string"?(error as {code:string}).code:"";
  if(/^\d{2}[A-Z0-9]{3}$/.test(code))return {code:`DB_${code}`,permanent:code.startsWith("22")||code.startsWith("23")};
  return {code:"WORKER_UNEXPECTED",permanent:false};
}

export async function claimDueMoneyInbox(pool:pg.Pool,kind:MoneyInboxKind,limit=20):Promise<string[]>{
  const result=await pool.query<{id:string}>(`WITH due AS (
    SELECT id FROM ${table(kind)} WHERE state='pending' AND next_attempt_at<=clock_timestamp()
      AND (lease_until IS NULL OR lease_until<=clock_timestamp())
    ORDER BY next_attempt_at,received_at,id FOR UPDATE SKIP LOCKED LIMIT $1
  ) UPDATE ${table(kind)} item SET lease_until=clock_timestamp()+interval '5 minutes',
    last_attempt_at=clock_timestamp() FROM due WHERE item.id=due.id RETURNING item.id`,
    [Math.max(1,Math.min(limit,100))]);
  return result.rows.map(row=>row.id);
}

export async function recordMoneyInboxFailure(pool:pg.Pool,kind:MoneyInboxKind,id:string,error:unknown){
  const classified=errorCode(error);
  return transaction(pool,async client=>{
    const row=(await client.query(`SELECT state,attempt_count FROM ${table(kind)} WHERE id=$1 FOR UPDATE`,[id])).rows[0];
    if(!row||row.state!=="pending")return row?.state??"missing";
    const attempts=Number(row.attempt_count)+1;
    const isolated=classified.permanent||attempts>=maximumAttempts;
    if(isolated){
      await client.query(`UPDATE ${table(kind)} SET state='exception',exception_code=$2,last_error_code=$3,
        attempt_count=$4,lease_until=NULL,quarantined_at=clock_timestamp() WHERE id=$1`,
        [id,classified.permanent?`PROCESSING_${classified.code}`:"RETRY_EXHAUSTED",classified.code,attempts]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,trace_id)
        VALUES($1,$2,$3,$4,$5,$6)`,[`worker:${kind}-inbox`,`${kind}.inbox_quarantined`,
          kind==="payment"?"commission_payment_inbox":"commission_refund_inbox",id,classified.code,`${kind}-inbox-failure:${id}:${attempts}`]);
      return "exception";
    }
    const delaySeconds=Math.min(3600,5*2**Math.min(attempts-1,10));
    await client.query(`UPDATE ${table(kind)} SET attempt_count=$2,last_error_code=$3,lease_until=NULL,
      next_attempt_at=clock_timestamp()+make_interval(secs=>$4::int) WHERE id=$1`,
      [id,attempts,classified.code,delaySeconds]);
    return "pending";
  });
}

export async function redriveQuarantinedMoneyInbox(pool:pg.Pool,kind:MoneyInboxKind,id:string,
  operatorPrincipal:string,reason:string,authorize?:(client:pg.PoolClient)=>Promise<void>){
  if(!/^member:[0-9a-f-]{36}$/i.test(operatorPrincipal)||reason.trim().length<8||reason.length>300)
    throw new DomainError("INBOX_REDRIVE_AUTH_INVALID","重驱需要授权人员和处理依据",403);
  return transaction(pool,async client=>{
    if(authorize)await authorize(client);
    const row=(await client.query(`SELECT state,quarantined_at FROM ${table(kind)} WHERE id=$1 FOR UPDATE`,[id])).rows[0];
    if(!row||row.state!=="exception"||!row.quarantined_at)
      throw new DomainError("INBOX_REDRIVE_NOT_ALLOWED","该事实不在可重驱隔离队列",409);
    await client.query(`UPDATE ${table(kind)} SET state='pending',exception_code=NULL,quarantined_at=NULL,
      attempt_count=0,next_attempt_at=clock_timestamp(),last_error_code=NULL,lease_until=NULL WHERE id=$1`,[id]);
    await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,trace_id)
      VALUES($1,$2,$3,$4,$5,$6)`,[operatorPrincipal,`${kind}.inbox_redriven`,
        kind==="payment"?"commission_payment_inbox":"commission_refund_inbox",id,reason,`${kind}-inbox-redrive:${id}:${Date.now()}`]);
    return {id,state:"pending" as const};
  });
}
