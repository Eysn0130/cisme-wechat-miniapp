import {createCipheriv,createDecipheriv,createHmac,randomBytes} from 'node:crypto';
import type pg from 'pg';
import {DomainError} from '@cisme/domain';
import {transaction} from './db.js';
import {PaidParcelSource,type PaidParcel as Source} from './paidParcel.js';
import type {DeliveryAddressService} from './deliveryAddress.js';
import type {ShippingSyncService} from './shippingSync.js';
import {LogisticsRegistrationRejected,validQueryToken,type LogisticsQueryChannel} from './wechatLogisticsQuery.js';

type Options={encryptionKey:string;hashKey:string;keyVersion:string;appId:string;merchantId:string;imageUrl:(code:string)=>string};
type Saved={state:'dispatching'|'rejected'|'ready';sealed?:string;keyVersion?:string};
const operation='commerce.logistics.query';
function fail(code:string,status=409):never{throw new DomainError(code,'物流详情暂不可用，请复制运单号查询或联系客服',status);}

/** Owner-only view of a real, paid parcel. The durable journal is written before
 * network dispatch; unknown outcomes never automatically register it again.
 * Tokens are encrypted and never written to logs, audit details or order data. */
export class LogisticsViewService {
  private parcels:PaidParcelSource;
  constructor(private pool:pg.Pool,private addresses:DeliveryAddressService,private sync:ShippingSyncService,
    private channel:LogisticsQueryChannel,private options:Options){
    this.parcels=new PaidParcelSource(addresses,sync,options);
    if(!/^[a-f0-9]{64}$/i.test(options.encryptionKey)||!/^[a-f0-9]{64}$/i.test(options.hashKey)
      ||!/^[A-Za-z0-9._:-]{1,80}$/.test(options.keyVersion))throw Error('LOGISTICS_VAULT_INVALID');
  }
  private fingerprint(source:Source){return createHmac('sha256',Buffer.from(this.options.hashKey,'hex')).update(JSON.stringify(source)).digest('hex');}
  private seal(token:string,owner:string,shipmentId:string){
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(this.options.encryptionKey,'hex'),iv);
    cipher.setAAD(Buffer.from(`${operation}:${owner}:${shipmentId}:${this.options.keyVersion}`));
    return Buffer.concat([iv,cipher.update(token,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64');
  }
  private open(saved:Saved,owner:string,shipmentId:string){
    try{
      if(saved.keyVersion!==this.options.keyVersion||typeof saved.sealed!=='string')throw Error();
      const bytes=Buffer.from(saved.sealed,'base64'),decipher=createDecipheriv('aes-256-gcm',Buffer.from(this.options.encryptionKey,'hex'),bytes.subarray(0,12));
      decipher.setAAD(Buffer.from(`${operation}:${owner}:${shipmentId}:${this.options.keyVersion}`));decipher.setAuthTag(bytes.subarray(-16));
      const token=Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString('utf8');
      if(!validQueryToken(token))throw Error();return token;
    }catch{fail('LOGISTICS_QUERY_CACHE_INVALID',503);}
  }
  async view(actor:string|undefined,orderId:string){
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(orderId))fail('ORDER_NOT_FOUND',404);
    const source=await transaction(this.pool,client=>this.parcels.read(client,actor,orderId)),hash=this.fingerprint(source);
    // A platform permission error leaves no dispatch intent and can be retried
    // after the operator enables the query component.
    await this.channel.assertReady(source.registration.binding);
    const prior=await transaction(this.pool,async client=>{
      const current=await this.parcels.read(client,actor,orderId);if(this.fingerprint(current)!==hash)fail('LOGISTICS_BINDING_CHANGED');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${operation}:${source.shipmentId}`]);
      const row=(await client.query(`SELECT request_hash,response_body FROM idempotency_operation
        WHERE principal_id=$1 AND operation=$2 AND idempotency_key=$3`,[`member:${source.owner}`,operation,source.shipmentId])).rows[0];
      if(row){
        if(row.request_hash!==hash)fail('LOGISTICS_BINDING_CHANGED');
        const saved=row.response_body as Saved;
        if(saved.state==='ready')return saved;
        if(saved.state!=='rejected')fail('LOGISTICS_QUERY_OUTCOME_UNKNOWN',503);
        await client.query(`UPDATE idempotency_operation SET response_body=$4,response_status=202
          WHERE principal_id=$1 AND operation=$2 AND idempotency_key=$3`,[`member:${source.owner}`,operation,source.shipmentId,{state:'dispatching'}]);
      }else await client.query(`INSERT INTO idempotency_operation(principal_id,operation,idempotency_key,business_key,request_hash,response_status,response_body)
        VALUES($1,$2,$3,$3,$4,202,$5)`,[`member:${source.owner}`,operation,source.shipmentId,hash,{state:'dispatching'}]);
      return null;
    });
    let saved=prior;
    if(!saved){
      let token:string;
      try{token=await this.channel.register(source.registration);if(!validQueryToken(token))fail('LOGISTICS_QUERY_OUTCOME_UNKNOWN',503);}
      catch(error){
        // Only a definite documented provider rejection permits another try.
        // Timeouts, aborted requests and unknown responses keep dispatching.
        if(error instanceof LogisticsRegistrationRejected)await this.pool.query(`UPDATE idempotency_operation SET response_body=$4,response_status=503
          WHERE principal_id=$1 AND operation=$2 AND idempotency_key=$3 AND response_body->>'state'='dispatching'`,
          [`member:${source.owner}`,operation,source.shipmentId,{state:'rejected'}]);
        throw error;
      }
      saved={state:'ready',sealed:this.seal(token,source.owner,source.shipmentId),keyVersion:this.options.keyVersion};
      await this.pool.query(`UPDATE idempotency_operation SET response_body=$4,response_status=200
        WHERE principal_id=$1 AND operation=$2 AND idempotency_key=$3 AND response_body->>'state'='dispatching'`,
        [`member:${source.owner}`,operation,source.shipmentId,saved]);
    }
    return transaction(this.pool,async client=>{
      const current=await this.parcels.read(client,actor,orderId);if(this.fingerprint(current)!==hash)fail('LOGISTICS_BINDING_CHANGED');
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
        VALUES($1,'commerce.shipment.logistics_view','commerce_shipment',$2,$3,$4)`,
        [`member:${source.owner}`,source.shipmentId,{source:'wechat_logistics_plugin'},`logistics-view:${source.shipmentId}`]);
      return {orderId,shipmentId:source.shipmentId,source:'wechat_logistics_plugin' as const,waybillToken:this.open(saved!,source.owner,source.shipmentId)};
    });
  }
}
