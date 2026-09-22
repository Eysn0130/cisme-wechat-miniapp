import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { DomainError } from '@cisme/domain';
import { AuthorityService } from './authority.js';
import { transaction, type DbClient } from './db.js';
import { shippingSyncAction, unifiedShippingPayload, type ShippingBinding, type ShippingSyncState,
  type UnifiedParcel, type WechatOrderShippingClient } from './wechatOrderShipping.js';

type Row = { id: string; order_id: string; created_by_member_id: string; request_key: string;
  request_hmac: string; encrypted_parcel: string; key_version: string; upload_time: Date;
  state: ShippingSyncState; query_attempts: number; claim_token: string | null };
type Options = { enabled: boolean; appId: string; merchantId: string;
  encryptionKey: string; hashKey: string; keyVersion: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(code: string, status = 409): never { throw new DomainError(code, '发货操作需核对，请保留原记录联系运营处理', status); }
function view(row: Row) { return { id: row.id, orderId: row.order_id, state: row.state, queryAttempts: row.query_attempts }; }

/** Durable dispatch-before-network journal. No HTTP route or live grant is
 * enabled by this service; the release composition must supply both explicitly.
 * A platform observation never writes local receipt/refund/completion facts. */
export class ShippingSyncService {
  constructor(private readonly pool: pg.Pool, private readonly authority: AuthorityService,
    private readonly options: Options, private readonly channel: Pick<WechatOrderShippingClient, 'query' | 'uploadOnce'>
      & Partial<Pick<WechatOrderShippingClient,'authorizeUpload'>>) {}

  private gate() {
    if (!this.options.enabled) fail('SHIPPING_SYNC_DISABLED', 503);
    if (!/^[a-f0-9]{64}$/i.test(this.options.encryptionKey) || !/^[a-f0-9]{64}$/i.test(this.options.hashKey)
      || !/^[A-Za-z0-9._:-]{1,80}$/.test(this.options.keyVersion)) fail('SHIPPING_VAULT_UNAVAILABLE', 503);
  }
  private seal(id: string, orderId: string, parcel: UnifiedParcel) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(this.options.encryptionKey, 'hex'), iv);
    cipher.setAAD(Buffer.from(`shipping:${id}:${orderId}:${this.options.keyVersion}`));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(parcel), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
  }
  private open(row: Row): UnifiedParcel {
    if (row.key_version !== this.options.keyVersion) fail('SHIPPING_KEY_VERSION_UNAVAILABLE', 503);
    try {
      const bytes = Buffer.from(row.encrypted_parcel, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.options.encryptionKey, 'hex'), bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      decipher.setAAD(Buffer.from(`shipping:${row.id}:${row.order_id}:${row.key_version}`));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as UnifiedParcel;
    } catch { fail('SHIPPING_PARCEL_AUTHENTICATION_FAILED', 503); }
  }

  private async binding(client: DbClient, orderId: string): Promise<ShippingBinding> {
    const order = (await client.query(`SELECT id,status,transaction_source_kind,order_number FROM commerce_order
      WHERE id=$1 FOR UPDATE`, [orderId])).rows[0];
    if (!order || order.status !== 'paid' || order.transaction_source_kind !== 'verified_commerce') fail('SHIPPING_SETTLED_ORDER_REQUIRED');
    const row = (await client.query(`SELECT p.app_id,p.merchant_id,p.payer_openid,p.out_trade_no,
      i.provider_transaction_id,i.payer_total_cents FROM commerce_payment_attempt p
      JOIN commission_payment_inbox i ON i.order_id=p.order_id AND i.app_id=p.app_id AND i.merchant_id=p.merchant_id
      WHERE p.order_id=$1 AND p.state='paid' AND i.state='applied' AND i.composition_status='full_cash'`, [orderId])).rows;
    if (row.length !== 1 || row[0].app_id !== this.options.appId || row[0].merchant_id !== this.options.merchantId
      || row[0].out_trade_no !== order.order_number) fail('SHIPPING_PAYMENT_BINDING_REQUIRED');
    // Any unresolved/approved refund or composition conflict requires manual review.
    const blocked = (await client.query(`SELECT
      EXISTS(SELECT 1 FROM commerce_refund_request WHERE order_id=$1 AND state IN ('requested','approved')) OR
      EXISTS(SELECT 1 FROM commission_payment_composition_observation WHERE order_id=$1) AS blocked`, [orderId])).rows[0].blocked;
    if (blocked) fail('SHIPPING_FINANCIAL_REVIEW_REQUIRED');
    return { merchantId: row[0].merchant_id, merchantOrderNumber: row[0].out_trade_no,
      transactionId: row[0].provider_transaction_id, payerOpenid: row[0].payer_openid,
      payerTotalCents: Number(row[0].payer_total_cents) };
  }

  async prepare(actor: string | undefined, orderId: string, requestKey: string, parcel: UnifiedParcel, evidenceReference: string) {
    this.gate(); await this.authority.require(actor, 'commerce.fulfillment.manage');
    return transaction(this.pool, client => this.prepareWithClient(client, actor, orderId, requestKey, parcel, evidenceReference), 'SERIALIZABLE');
  }

  /** Compose local shipment + sync intent in ONE caller-owned DB transaction.
   * This method performs no external I/O and rechecks authority itself. */
  async prepareWithClient(client: DbClient, actor: string | undefined, orderId: string, requestKey: string,
    parcel: UnifiedParcel, evidenceReference: string) {
    this.gate();
    if (!UUID.test(orderId) || !/^[A-Za-z0-9._:-]{8,200}$/.test(requestKey)
      || !/^[A-Za-z0-9._:-]{8,120}$/.test(evidenceReference)) fail('SHIPPING_REQUEST_INVALID', 422);
    // Normalize before HMAC/sealing so extra input keys cannot enter storage or network.
    const normalized: UnifiedParcel = { trackingNumber: parcel.trackingNumber, carrierCode: parcel.carrierCode,
      description: parcel.description, ...(parcel.receiverContactMasked ? { receiverContactMasked: parcel.receiverContactMasked } : {}) };
    const fingerprint = createHmac('sha256', Buffer.from(this.options.hashKey, 'hex'))
      .update(JSON.stringify({ orderId, parcel: normalized, evidenceReference })).digest('hex');
    {
      await this.authority.requireWithClient(client, actor, 'commerce.fulfillment.manage');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`shipping:${actor}:${requestKey}`]);
      const existing = (await client.query<Row>(`SELECT * FROM commerce_shipping_sync
        WHERE order_id=$1 OR (created_by_member_id=$2 AND request_key=$3)`, [orderId, actor, requestKey])).rows;
      if (existing.length) {
        const row = existing[0]!;
        if (existing.length === 1 && row.created_by_member_id === actor && row.request_key === requestKey && row.request_hmac === fingerprint) return view(row);
        fail('SHIPPING_PROPOSAL_CONFLICT');
      }
      const binding = await this.binding(client, orderId);
      const uploadTime = new Date().toISOString(); unifiedShippingPayload(binding, normalized, uploadTime);
      const id = randomUUID();
      const row = (await client.query<Row>(`INSERT INTO commerce_shipping_sync(id,order_id,created_by_member_id,
        request_key,request_hmac,encrypted_parcel,key_version,evidence_reference,upload_time)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [id, orderId, actor, requestKey, fingerprint, this.seal(id, orderId, normalized), this.options.keyVersion, evidenceReference, uploadTime])).rows[0]!;
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
        VALUES($1,'commerce.shipping_prepared','commerce_shipping_sync',$2,$3,$4)`,
      [`member:${actor}`, id, { orderId, state: row.state }, `shipping:${id}`]);
      return view(row);
    }
  }

  /** Internal projection; the caller must hold owner/fulfillment authority. */
  async parcelWithClient(client: DbClient, jobId: string): Promise<UnifiedParcel> {
    this.gate();
    const row=(await client.query<Row>('SELECT * FROM commerce_shipping_sync WHERE id=$1',[jobId])).rows[0];
    if(!row) fail('SHIPPING_PROPOSAL_MISSING');
    return this.open(row);
  }

  async processOne(id: string): Promise<string> {
    this.gate(); if (!UUID.test(id)) fail('SHIPPING_ID_INVALID', 422);
    const claim = await transaction(this.pool, async client => {
      const row = (await client.query<Row>(`SELECT * FROM commerce_shipping_sync WHERE id=$1
        AND state IN ('prepared','dispatching','verifying') AND next_attempt_at<=clock_timestamp()
        AND (lease_until IS NULL OR lease_until<clock_timestamp()) FOR UPDATE SKIP LOCKED`, [id])).rows[0];
      if (!row) return null;
      if (row.query_attempts >= 5) {
        await client.query(`UPDATE commerce_shipping_sync SET state='manual_review',claim_token=NULL,
          lease_until=NULL,last_code='QUERY_RETRY_EXHAUSTED',updated_at=clock_timestamp() WHERE id=$1`, [id]);
        return null;
      }
      const token = randomUUID();
      const updated = (await client.query<Row>(`UPDATE commerce_shipping_sync SET claim_token=$2,
        lease_until=clock_timestamp()+interval '1 minute',query_attempts=query_attempts+1,
        updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [id, token])).rows[0]!;
      return updated;
    });
    if (!claim) return 'idle';
    let binding: ShippingBinding, parcel: UnifiedParcel;
    const finish = async (state: ShippingSyncState, code: string, platformState: number | null = null) => {
      const result = await this.pool.query(`UPDATE commerce_shipping_sync SET state=$3,last_code=$4,
        platform_order_state=$5,claim_token=NULL,lease_until=NULL,
        next_attempt_at=clock_timestamp()+($6*interval '1 second'),updated_at=clock_timestamp()
        WHERE id=$1 AND claim_token=$2 AND lease_until>clock_timestamp()`,
      [id, claim.claim_token, state, code, platformState, Math.min(300, 5 * 2 ** claim.query_attempts)]);
      return result.rowCount ? state : 'stale_claim';
    };
    try {
      binding = await transaction(this.pool, async client => {
        if (claim.state === 'prepared') await this.authority.requireWithClient(client, claim.created_by_member_id, 'commerce.fulfillment.manage');
        return this.binding(client, claim.order_id);
      });
      parcel = this.open(claim);
    } catch { return finish('manual_review', 'LOCAL_BINDING_OR_PARCEL_REVIEW'); }
    try {
      const observation = await this.channel.query(binding, parcel);
      const next = shippingSyncAction(claim.state, claim.query_attempts, observation);
      if (next.action !== 'upload_once') {
        // A prepared query retry must remain prepared (no dispatch occurred).
        return finish(next.state, observation.decision.toUpperCase(), observation.platformOrderState);
      }
      this.channel.authorizeUpload?.(binding); // A query-only grant must not consume dispatch.
      const dispatch = await transaction(this.pool, async client => {
        await this.authority.requireWithClient(client, claim.created_by_member_id, 'commerce.fulfillment.manage');
        await this.binding(client, claim.order_id); // Refund/order recheck immediately before dispatch.
        return client.query(`UPDATE commerce_shipping_sync SET state='dispatching',dispatched_at=clock_timestamp(),
          updated_at=clock_timestamp() WHERE id=$1 AND claim_token=$2 AND state='prepared'
          AND lease_until>clock_timestamp() RETURNING id`, [id, claim.claim_token]);
      });
      if (!dispatch.rowCount) return 'stale_claim';
      try {
        await this.channel.uploadOnce(binding, parcel, claim.upload_time.toISOString());
        return finish('verifying', 'UPLOAD_ACKNOWLEDGED_QUERY_REQUIRED');
      } catch { return finish('verifying', 'UPLOAD_OUTCOME_UNKNOWN_QUERY_REQUIRED'); }
    } catch {
      const state = claim.query_attempts >= 5 ? 'manual_review' : claim.state === 'prepared' ? 'prepared' : 'verifying';
      return finish(state, claim.query_attempts >= 5 ? 'QUERY_RETRY_EXHAUSTED' : 'QUERY_UNAVAILABLE');
    }
  }
}
