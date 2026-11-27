import type {DbClient} from './db.js';

type ConfirmedShipment={id:string;version:number;receipt_confirmed_at:Date|null};

export async function recordShipmentReceipt(client:DbClient,row:ConfirmedShipment,principal:string,evidence:string){
  const eventKey=`receipt:${row.id}`;
  await client.query(`INSERT INTO commerce_shipment_event(shipment_id,event_key,event_type,actor_principal_id,evidence_reference,occurred_at)
    VALUES($1,$2,'receipt_confirmed',$3,$4,$5)`,[row.id,eventKey,principal,evidence,row.receipt_confirmed_at]);
  await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
    VALUES($1,'commerce.shipment.receipt','commerce_shipment',$2,$3,$4)`,[principal,row.id,{version:row.version},eventKey]);
}

/** Called with the order lock and the just-written, bound platform observation.
 * This timestamp is when CISME verified receipt. It does not attest delivery or settlement. */
export async function applyVerifiedCourierReceipt(client:DbClient,orderId:string,queryId:string){
  const row=(await client.query<ConfirmedShipment>(`UPDATE commerce_shipment s SET receipt_confirmed_at=w.observed_at,version=s.version+1
    FROM commerce_wechat_receipt_observation w,commerce_shipping_sync y
    WHERE s.order_id=$1 AND s.delivery_method='express' AND s.logistics_state<>'exception' AND s.receipt_confirmed_at IS NULL
      AND w.order_id=s.order_id AND w.shipment_id=s.id AND w.query_id=$2
      AND w.platform_order_state IN (3,4) AND w.in_complaint=false AND w.observed_at>=s.shipped_at
      AND y.id=s.shipping_sync_id AND y.order_id=s.order_id AND y.state='synced'
      AND NOT EXISTS(SELECT 1 FROM commission_refund_intent i WHERE i.order_id=s.order_id AND i.state IN ('prepared','abnormal'))
      AND NOT EXISTS(SELECT 1 FROM commerce_aftersale_case c LEFT JOIN commission_refund_intent i ON i.request_id=c.refund_request_id
        WHERE c.order_id=s.order_id AND c.state NOT IN ('cancelled','rejected')
          AND NOT(c.state='refund_pending' AND COALESCE(i.state='succeeded',false)))
    RETURNING s.id,s.version,s.receipt_confirmed_at`,[orderId,queryId])).rows[0];
  if(row)await recordShipmentReceipt(client,row,'system:wechat-receipt',`wechat-receipt:${queryId}`);
  else await client.query(`UPDATE commerce_wechat_receipt_observation w SET
    watch_state='active',watch_next_attempt_at=clock_timestamp()+interval '24 hours'
    FROM commerce_shipment s WHERE w.order_id=$1 AND w.query_id=$2 AND w.platform_order_state=4
      AND s.id=w.shipment_id AND s.order_id=w.order_id AND s.delivery_method='express'
      AND s.receipt_confirmed_at IS NULL AND s.logistics_state<>'exception'`,[orderId,queryId]);
}
