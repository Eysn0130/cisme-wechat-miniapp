import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { AppConfig } from "@cisme/config";
import { DomainError } from "@cisme/domain";
import { transaction, type DbClient } from "./db.js";

const labels = ["home", "company", "other"] as const;
type AddressLabel = (typeof labels)[number];

export interface AddressPayload {
  recipientName: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  postalCode: string;
  nationalCode: string;
  provinceCode: string;
  cityCode: string;
  districtCode: string;
}

interface AddressInput extends Partial<AddressPayload> {
  label?: unknown;
  isDefault?: unknown;
  expectedVersion?: unknown;
}

interface AddressRow {
  id: string;
  member_id: string;
  encrypted_payload: string;
  payload_hmac: string;
  key_version: string;
  label: AddressLabel;
  is_default: boolean;
  version: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function compatibleAddressPayload(payload: Partial<AddressPayload>): AddressPayload {
  return {
    recipientName: payload.recipientName ?? "", phone: payload.phone ?? "", province: payload.province ?? "", city: payload.city ?? "", district: payload.district ?? "",
    detail: payload.detail ?? "", postalCode: payload.postalCode ?? "", nationalCode: payload.nationalCode ?? payload.districtCode ?? "",
    provinceCode: payload.provinceCode ?? "", cityCode: payload.cityCode ?? "", districtCode: payload.districtCode ?? payload.nationalCode ?? ""
  };
}

const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function text(value: unknown, field: string, min: number, max: number): string {
  const normalized = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  const length = Array.from(normalized).length;
  if (length < min || length > max || unsafeText.test(normalized)) throw new DomainError("DELIVERY_ADDRESS_INVALID", `${field}填写不完整`, 422);
  return normalized;
}

function normalizeInput(input: AddressInput): { payload: AddressPayload; label: AddressLabel; isDefault: boolean } {
  const phone = typeof input.phone === "string" ? input.phone.trim().replace(/[\s-]/g, "") : "";
  if (!/^\+?[0-9]{6,20}$/.test(phone)) throw new DomainError("DELIVERY_ADDRESS_PHONE_INVALID", "请填写可用于配送联系的电话号码", 422);
  const postalCode = typeof input.postalCode === "string" ? input.postalCode.trim() : "";
  const nationalCode = typeof input.nationalCode === "string" ? input.nationalCode.trim() : "";
  const provinceCode = typeof input.provinceCode === "string" ? input.provinceCode.trim() : "";
  const cityCode = typeof input.cityCode === "string" ? input.cityCode.trim() : "";
  const districtCode = typeof input.districtCode === "string" ? input.districtCode.trim() : nationalCode;
  if (postalCode && !/^[A-Za-z0-9 -]{2,12}$/.test(postalCode)) throw new DomainError("DELIVERY_ADDRESS_POSTAL_INVALID", "邮政编码格式不正确", 422);
  if ([nationalCode, provinceCode, cityCode, districtCode].some((code) => code && !/^[A-Za-z0-9-]{1,12}$/.test(code))) throw new DomainError("DELIVERY_ADDRESS_REGION_INVALID", "地区编码格式不正确", 422);
  if (!labels.includes(input.label as AddressLabel)) throw new DomainError("DELIVERY_ADDRESS_LABEL_INVALID", "请选择地址标签", 422);
  if (input.isDefault !== undefined && typeof input.isDefault !== "boolean") throw new DomainError("DELIVERY_ADDRESS_DEFAULT_INVALID", "默认地址状态不正确", 422);
  return {
    payload: {
      recipientName: text(input.recipientName, "收货人", 1, 40),
      phone,
      province: text(input.province, "省份", 1, 40),
      city: text(input.city, "城市", 1, 40),
      district: text(input.district, "区县", 1, 40),
      detail: text(input.detail, "详细地址", 2, 120),
      postalCode,
      nationalCode: nationalCode || districtCode,
      provinceCode,
      cityCode,
      districtCode
    },
    label: input.label as AddressLabel,
    isDefault: input.isDefault === true
  };
}

function expectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new DomainError("DELIVERY_ADDRESS_VERSION_INVALID", "地址版本无效，请刷新后重试", 422);
  return Number(value);
}

export class DeliveryAddressService {
  constructor(private readonly pool: pg.Pool, private readonly config: AppConfig) {}

  enabled(): boolean {
    return /^[0-9a-f]{64}$/i.test(this.config.contacts.encryptionKey || "") && /^[0-9a-f]{64}$/i.test(this.config.contacts.hashKey || "");
  }

  private requireMember(memberId: string | undefined): string {
    if (!memberId) throw new DomainError("AUTH_REQUIRED", "请先登录会员账号", 401);
    return memberId;
  }

  private requireEnabled(): void {
    if (!this.enabled()) throw new DomainError("DELIVERY_ADDRESS_UNAVAILABLE", "地址簿安全存储尚未配置", 503);
  }

  async checkoutSnapshot(client: DbClient, memberId: string | undefined, addressId: string, version: unknown): Promise<{ id: string; version: number; payload: AddressPayload }> {
    const owner = this.requireMember(memberId);
    this.requireEnabled();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(addressId)) {
      throw new DomainError("DELIVERY_ADDRESS_NOT_FOUND", "收货地址不存在", 404);
    }
    const expected = expectedVersion(version);
    const result = await client.query<AddressRow>("SELECT * FROM member_delivery_address WHERE id=$1 AND member_id=$2 AND deleted_at IS NULL FOR SHARE", [addressId, owner]);
    const row = result.rows[0];
    if (!row) throw new DomainError("DELIVERY_ADDRESS_NOT_FOUND", "收货地址不存在", 404);
    if (row.version !== expected) throw new DomainError("DELIVERY_ADDRESS_CHANGED", "收货地址已更新，请重新确认", 409);
    return { id: row.id, version: row.version, payload: this.decrypt(row) };
  }

  sealOrderSnapshot(memberId: string, orderId: string, payload: AddressPayload): { encryptedPayload: string; payloadHmac: string; keyVersion: string } {
    this.requireEnabled();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(this.config.contacts.encryptionKey!, "hex"), iv);
    cipher.setAAD(Buffer.from(`${memberId}:order:${orderId}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return {
      encryptedPayload: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64"),
      payloadHmac: createHmac("sha256", Buffer.from(this.config.contacts.hashKey!, "hex")).update(`${memberId}:order:${JSON.stringify(payload)}`).digest("hex"),
      keyVersion: this.config.contacts.keyVersion
    };
  }

  openOrderSnapshot(memberId: string, orderId: string, encryptedPayload: string, payloadHmac: string, keyVersion: string): AddressPayload {
    this.requireEnabled();
    if (keyVersion !== this.config.contacts.keyVersion) throw new DomainError("DELIVERY_ADDRESS_KEY_UNAVAILABLE", "订单地址加密版本暂不可用，请联系客服", 503);
    try {
      const packed = Buffer.from(encryptedPayload, "base64");
      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(this.config.contacts.encryptionKey!, "hex"), packed.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${memberId}:order:${orderId}`));
      decipher.setAuthTag(packed.subarray(12, 28));
      const payload = compatibleAddressPayload(JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8")) as Partial<AddressPayload>);
      const expected = createHmac("sha256", Buffer.from(this.config.contacts.hashKey!, "hex")).update(`${memberId}:order:${JSON.stringify(payload)}`).digest();
      const supplied = Buffer.from(payloadHmac, "hex");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("ORDER_ADDRESS_HMAC_MISMATCH");
      return payload;
    } catch {
      throw new DomainError("DELIVERY_ADDRESS_DECRYPT_FAILED", "订单地址暂时无法安全读取，请联系客服", 500);
    }
  }

  private payloadHmac(memberId: string, payload: AddressPayload): string {
    return createHmac("sha256", Buffer.from(this.config.contacts.hashKey!, "hex"))
      .update(`${memberId}:${JSON.stringify(payload)}`)
      .digest("hex");
  }

  private encrypt(memberId: string, addressId: string, payload: AddressPayload): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(this.config.contacts.encryptionKey!, "hex"), iv);
    cipher.setAAD(Buffer.from(`${memberId}:${addressId}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  }

  private decrypt(row: AddressRow): AddressPayload {
    if (row.key_version !== this.config.contacts.keyVersion) throw new DomainError("DELIVERY_ADDRESS_KEY_UNAVAILABLE", "地址加密版本暂不可用，请联系客服", 503);
    try {
      const packed = Buffer.from(row.encrypted_payload, "base64");
      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(this.config.contacts.encryptionKey!, "hex"), packed.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${row.member_id}:${row.id}`));
      decipher.setAuthTag(packed.subarray(12, 28));
      return compatibleAddressPayload(JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8")) as Partial<AddressPayload>);
    } catch {
      throw new DomainError("DELIVERY_ADDRESS_DECRYPT_FAILED", "地址暂时无法安全读取，请联系客服", 500);
    }
  }

  private view(row: AddressRow) {
    const payload = this.decrypt(row);
    return {
      id: row.id,
      ...payload,
      label: row.label,
      isDefault: row.is_default,
      version: row.version,
      updatedAt: row.updated_at.toISOString()
    };
  }

  private async audit(client: DbClient, memberId: string, action: string, addressId: string, reasonCode: string): Promise<void> {
    await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,trace_id)
      VALUES($1,$2,'member_delivery_address',$3,$4,gen_random_uuid()::text)`, [`member:${memberId}`, action, addressId, reasonCode]);
  }

  async list(memberId: string | undefined) {
    const owner = this.requireMember(memberId);
    if (!this.enabled()) return { enabled: false, maxAddresses: 10, addresses: [] };
    const result = await this.pool.query<AddressRow>(`SELECT * FROM member_delivery_address
      WHERE member_id=$1 AND deleted_at IS NULL ORDER BY is_default DESC, updated_at DESC, id DESC`, [owner]);
    return { enabled: true, maxAddresses: 10, addresses: result.rows.map((row) => this.view(row)) };
  }

  async create(memberId: string | undefined, clientRequestKey: string, input: AddressInput) {
    const owner = this.requireMember(memberId);
    this.requireEnabled();
    const normalized = normalizeInput(input);
    return transaction(this.pool, async (client) => {
      await client.query("SELECT id FROM member WHERE id=$1 AND status='active' FOR UPDATE", [owner]);
      const replay = await client.query<AddressRow>("SELECT * FROM member_delivery_address WHERE member_id=$1 AND client_request_key=$2", [owner, clientRequestKey]);
      if (replay.rows[0]) {
        if (replay.rows[0].deleted_at) throw new DomainError("DELIVERY_ADDRESS_REQUEST_RETIRED", "这次地址保存请求已经删除，请重新新增", 409);
        return this.view(replay.rows[0]);
      }
      const active = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM member_delivery_address WHERE member_id=$1 AND deleted_at IS NULL", [owner]);
      if ((active.rows[0]?.count ?? 0) >= 10) throw new DomainError("DELIVERY_ADDRESS_LIMIT", "最多保存 10 个收货地址", 409);
      const duplicate = await client.query<AddressRow>("SELECT * FROM member_delivery_address WHERE member_id=$1 AND payload_hmac=$2 AND deleted_at IS NULL", [owner, this.payloadHmac(owner, normalized.payload)]);
      if (duplicate.rows[0]) return this.view(duplicate.rows[0]);
      const id = randomUUID();
      const useDefault = normalized.isDefault || (active.rows[0]?.count ?? 0) === 0;
      if (useDefault) await client.query("UPDATE member_delivery_address SET is_default=false,version=version+1,updated_at=now() WHERE member_id=$1 AND is_default AND deleted_at IS NULL", [owner]);
      const result = await client.query<AddressRow>(`INSERT INTO member_delivery_address
        (id,member_id,encrypted_payload,payload_hmac,key_version,label,is_default,client_request_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [id, owner, this.encrypt(owner, id, normalized.payload), this.payloadHmac(owner, normalized.payload), this.config.contacts.keyVersion, normalized.label, useDefault, clientRequestKey]);
      await this.audit(client, owner, "member.delivery_address_created", id, "USER_ADDRESS_CREATE");
      return this.view(result.rows[0]!);
    }, "SERIALIZABLE");
  }

  async update(memberId: string | undefined, addressId: string, input: AddressInput) {
    const owner = this.requireMember(memberId);
    this.requireEnabled();
    const version = expectedVersion(input.expectedVersion);
    const normalized = normalizeInput(input);
    return transaction(this.pool, async (client) => {
      const current = await client.query<AddressRow>("SELECT * FROM member_delivery_address WHERE id=$1 AND member_id=$2 AND deleted_at IS NULL FOR UPDATE", [addressId, owner]);
      const row = current.rows[0];
      if (!row) throw new DomainError("DELIVERY_ADDRESS_NOT_FOUND", "收货地址不存在", 404);
      if (row.version !== version) throw new DomainError("DELIVERY_ADDRESS_CHANGED", "地址已在其他页面更新，请刷新后重试", 409);
      if (normalized.isDefault && !row.is_default) await client.query("UPDATE member_delivery_address SET is_default=false,version=version+1,updated_at=now() WHERE member_id=$1 AND id<>$2 AND is_default AND deleted_at IS NULL", [owner, addressId]);
      const result = await client.query<AddressRow>(`UPDATE member_delivery_address SET encrypted_payload=$3,payload_hmac=$4,key_version=$5,label=$6,
        is_default=$7,version=version+1,updated_at=now() WHERE id=$1 AND member_id=$2 RETURNING *`, [addressId, owner, this.encrypt(owner, addressId, normalized.payload), this.payloadHmac(owner, normalized.payload), this.config.contacts.keyVersion, normalized.label, normalized.isDefault || row.is_default,]);
      await this.audit(client, owner, "member.delivery_address_updated", addressId, "USER_ADDRESS_UPDATE");
      return this.view(result.rows[0]!);
    }, "SERIALIZABLE");
  }

  async setDefault(memberId: string | undefined, addressId: string, input: AddressInput) {
    const owner = this.requireMember(memberId);
    this.requireEnabled();
    const version = expectedVersion(input.expectedVersion);
    return transaction(this.pool, async (client) => {
      const current = await client.query<AddressRow>("SELECT * FROM member_delivery_address WHERE id=$1 AND member_id=$2 AND deleted_at IS NULL FOR UPDATE", [addressId, owner]);
      const row = current.rows[0];
      if (!row) throw new DomainError("DELIVERY_ADDRESS_NOT_FOUND", "收货地址不存在", 404);
      if (row.version !== version) throw new DomainError("DELIVERY_ADDRESS_CHANGED", "地址已更新，请刷新后重试", 409);
      if (!row.is_default) {
        await client.query("UPDATE member_delivery_address SET is_default=false,version=version+1,updated_at=now() WHERE member_id=$1 AND id<>$2 AND is_default AND deleted_at IS NULL", [owner, addressId]);
        await client.query("UPDATE member_delivery_address SET is_default=true,version=version+1,updated_at=now() WHERE id=$1", [addressId]);
      }
      const result = await client.query<AddressRow>("SELECT * FROM member_delivery_address WHERE id=$1", [addressId]);
      await this.audit(client, owner, "member.delivery_address_defaulted", addressId, "USER_ADDRESS_DEFAULT");
      return this.view(result.rows[0]!);
    }, "SERIALIZABLE");
  }

  async remove(memberId: string | undefined, addressId: string, input: AddressInput) {
    const owner = this.requireMember(memberId);
    this.requireEnabled();
    const version = expectedVersion(input.expectedVersion);
    return transaction(this.pool, async (client) => {
      const current = await client.query<AddressRow>("SELECT * FROM member_delivery_address WHERE id=$1 AND member_id=$2 AND deleted_at IS NULL FOR UPDATE", [addressId, owner]);
      const row = current.rows[0];
      if (!row) return { removed: true, defaultAddressId: null };
      if (row.version !== version) throw new DomainError("DELIVERY_ADDRESS_CHANGED", "地址已更新，请刷新后重试", 409);
      await client.query("UPDATE member_delivery_address SET is_default=false,deleted_at=now(),version=version+1,updated_at=now() WHERE id=$1", [addressId]);
      let defaultAddressId: string | null = null;
      if (row.is_default) {
        const replacement = await client.query<{ id: string }>("SELECT id FROM member_delivery_address WHERE member_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT 1 FOR UPDATE", [owner]);
        defaultAddressId = replacement.rows[0]?.id ?? null;
        if (defaultAddressId) await client.query("UPDATE member_delivery_address SET is_default=true,version=version+1,updated_at=now() WHERE id=$1", [defaultAddressId]);
      }
      await this.audit(client, owner, "member.delivery_address_deleted", addressId, "USER_ADDRESS_DELETE");
      return { removed: true, defaultAddressId };
    }, "SERIALIZABLE");
  }
}
