import {createCipheriv,createHmac,randomBytes} from 'node:crypto';
import type pg from 'pg';
import {DomainError} from '@cisme/domain';
import {transaction,type DbClient} from './db.js';
import {PaidParcelSource,type PaidParcel} from './paidParcel.js';
import {LogisticsRegistrationRejected,validQueryToken,type LogisticsQueryChannel} from './wechatLogisticsQuery.js';

export const logisticsMessageOperation='commerce.logistics.message';
type State='queued'|'retry'|'dispatching'|'registered'|'unknown'|'review'|'cancelled';
type Saved={state:State;attempts:number;nextAttemptAt?:string;bindingHash?:string;sealed?:string;keyVersion?:string;providerCode?:number};
type Job={principal_id:string;idempotency_key:string;business_key:string;request_hash:string;response_body:Saved};
type Options={encryptionKey:string;hashKey:string;keyVersion:string};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const retryable=new Set([-1,40001,42001,45009,48001,48002,9300513]);
const terminalSource=new Set(['MEMBER_NOT_ACTIVE','ORDER_NOT_FOUND','SHIPMENT_NOT_FOUND','LOGISTICS_PAYMENT_BINDING_REQUIRED']);

/** New real shipments only. This journal contains IDs, HMACs and an encrypted
 * provider token, never clear buyer/contact/waybill data. A crash after dispatch
 * fences the attempt: WeChat has no documented token lookup without its token. */
export class LogisticsMessageService {
  constructor(private pool:pg.Pool,private parcels:PaidParcelSource,private channel:LogisticsQueryChannel,private options:Options){
    if(!/^[a-f0-9]{64}$/i.test(options.encryptionKey)||!/^[a-f0-9]{64}$/i.test(options.hashKey)
      ||!/^[A-Za-z0-9._:-]{1,80}$/.test(options.keyVersion))throw Error('LOGISTICS_MESSAGE_VAULT_INVALID');
  }
  private hash(value:unknown){return createHmac('sha256',Buffer.from(this.options.hashKey,'hex')).update(JSON.stringify(value)).digest('hex');}
  private jobHash(owner:string,orderId:string,shipmentId:string){return this.hash({owner,orderId,shipmentId});}
  async enqueue(client:DbClient,owner:string,orderId:string,shipmentId:string){
    if(![owner,orderId,shipmentId].every(x=>uuid.test(x)))throw Error('LOGISTICS_MESSAGE_JOB_INVALID');
    await client.query(`INSERT INTO idempotency_operation(principal_id,operation,idempotency_key,business_key,request_hash,response_status,response_body)
      VALUES($1,$2,$3,$4,$5,202,$6) ON CONFLICT(principal_id,operation,idempotency_key) DO NOTHING`,
      [`member:${owner}`,logisticsMessageOperation,shipmentId,orderId,this.jobHash(owner,orderId,shipmentId),{state:'queued',attempts:0}]);
  }
  private async job(client:DbClient,shipmentId:string){
    const rows=(await client.query<Job>(`SELECT principal_id,idempotency_key,business_key,request_hash,response_body FROM idempotency_operation
      WHERE operation=$1 AND idempotency_key=$2 FOR UPDATE SKIP LOCKED`,[logisticsMessageOperation,shipmentId])).rows;
    if(rows.length!==1)return null;
    const row=rows[0]!,owner=row.principal_id.slice(7);
    if(!row.principal_id.startsWith('member:')||![owner,row.business_key,shipmentId].every(x=>uuid.test(x))
      ||row.request_hash!==this.jobHash(owner,row.business_key,shipmentId))throw Error('LOGISTICS_MESSAGE_JOB_INVALID');
    return row;
  }
  private async save(client:Pick<DbClient,'query'>,job:Job,saved:Saved,expected:State[]){
    await client.query(`UPDATE idempotency_operation SET response_body=$4,response_status=$5
      WHERE principal_id=$1 AND operation=$2 AND idempotency_key=$3 AND response_body->>'state'=ANY($6::text[])`,
      [job.principal_id,logisticsMessageOperation,job.idempotency_key,saved,saved.state==='registered'?200:202,expected]);
  }
  private reschedule(job:Job,providerCode?:number):Saved {
    const attempts=job.response_body.attempts+1;
    return {state:attempts>=8?'review':'retry',attempts,
      nextAttemptAt:new Date(Date.now()+Math.min(3_600_000,60_000*2**Math.min(attempts,6))).toISOString(),
      ...(providerCode===undefined?{}:{providerCode})};
  }
  private seal(token:string,source:PaidParcel){
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(this.options.encryptionKey,'hex'),iv);
    cipher.setAAD(Buffer.from(`${logisticsMessageOperation}:${source.owner}:${source.shipmentId}:${this.options.keyVersion}`));
    return Buffer.concat([iv,cipher.update(token,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64');
  }
  async processOne(shipmentId:string):Promise<State|'busy'>{
    if(!uuid.test(shipmentId))throw Error('LOGISTICS_MESSAGE_JOB_INVALID');
    const candidate=await transaction(this.pool,async client=>{
      const job=await this.job(client,shipmentId);if(!job)return null;
      const saved=job.response_body;
      if(!['queued','retry'].includes(saved.state)||saved.nextAttemptAt&&Date.parse(saved.nextAttemptAt)>Date.now())return null;
      try{
        const source=await this.parcels.read(client,job.principal_id.slice(7),job.business_key);
        if(source.shipmentId!==shipmentId)throw Error('LOGISTICS_MESSAGE_JOB_INVALID');
        return {job,source,hash:this.hash(source)};
      }catch(error){
        const code=error instanceof DomainError?error.code:'';
        await this.save(client,job,{state:terminalSource.has(code)?'cancelled':'review',attempts:saved.attempts},['queued','retry']);
        return null;
      }
    });
    if(!candidate)return 'busy';
    const {job,source,hash}=candidate;
    // Read-only capability probe before the durable mutating dispatch boundary.
    try{await this.channel.assertReady(source.registration.binding);}
    catch{await this.save(this.pool,job,this.reschedule(job),['queued','retry']);return 'retry';}
    const acquired=await transaction(this.pool,async client=>{
      const current=await this.job(client,shipmentId);
      if(!current||!['queued','retry'].includes(current.response_body.state)||current.response_body.attempts!==job.response_body.attempts
        ||current.response_body.nextAttemptAt&&Date.parse(current.response_body.nextAttemptAt)>Date.now())return false;
      const fresh=await this.parcels.read(client,source.owner,job.business_key);
      if(this.hash(fresh)!==hash){await this.save(client,current,{state:'review',attempts:current.response_body.attempts},['queued','retry']);return false;}
      await this.save(client,current,{state:'dispatching',attempts:current.response_body.attempts,bindingHash:hash},['queued','retry']);return true;
    });
    if(!acquired)return 'busy';
    try{
      const token=await this.channel.register(source.registration);
      if(!validQueryToken(token))throw Error('LOGISTICS_MESSAGE_RESPONSE_INVALID');
      await this.save(this.pool,job,{state:'registered',attempts:job.response_body.attempts+1,bindingHash:hash,
        sealed:this.seal(token,source),keyVersion:this.options.keyVersion},['dispatching']);
      return 'registered';
    }catch(error){
      const definitelyNotSent=error instanceof DomainError&&error.code==='LOGISTICS_MESSAGE_NOT_DISPATCHED';
      const rejected=error instanceof LogisticsRegistrationRejected;
      const saved:Saved=definitelyNotSent||rejected&&retryable.has(error.providerCode)?this.reschedule(job,rejected?error.providerCode:undefined):
        {state:rejected?'review':'unknown',attempts:job.response_body.attempts+1,bindingHash:hash,...(rejected?{providerCode:error.providerCode}:{})};
      await this.save(this.pool,job,saved,['dispatching']);return saved.state;
    }
  }
  async runCycle(){
    const rows=(await this.pool.query(`SELECT idempotency_key FROM idempotency_operation WHERE operation=$1
      AND response_body->>'state' IN ('queued','retry')
      AND (response_body->>'nextAttemptAt' IS NULL OR (response_body->>'nextAttemptAt')::timestamptz<=clock_timestamp())
      ORDER BY created_at,idempotency_key LIMIT 5`,[logisticsMessageOperation])).rows;
    const states:Record<string,number>={};
    for(const row of rows){const state=await this.processOne(row.idempotency_key);states[state]=(states[state]??0)+1;}
    return {processed:rows.length,states};
  }
}
