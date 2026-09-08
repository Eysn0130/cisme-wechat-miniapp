import { createHmac, timingSafeEqual } from "node:crypto";
import type { Principal } from "@cisme/contracts";
import { DomainError } from "@cisme/domain";

interface SessionPayload {
  principalId: string;
  memberId: string;
  adapter: "wechat" | "dev";
  expiresAt: number;
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueSessionToken(payload: Omit<SessionPayload, "expiresAt">, secret: string, now = Date.now()): string {
  const encoded = Buffer.from(JSON.stringify({ ...payload, expiresAt: now + 12 * 60 * 60 * 1000 })).toString("base64url");
  return `${encoded}.${signature(encoded, secret)}`;
}

export function verifySessionToken(token: string, secret: string, now = Date.now()): Principal {
  const parts = token.split(".");
  if (parts.length !== 2) throw new DomainError("AUTH_INVALID", "Invalid session token", 401);
  const [encoded, supplied] = parts;
  if (!encoded || !supplied) throw new DomainError("AUTH_INVALID", "Invalid session token", 401);
  const expected = signature(encoded, secret);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new DomainError("AUTH_INVALID", "Invalid session token", 401);
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    throw new DomainError("AUTH_INVALID", "Invalid session token", 401);
  }
  if (
    !payload ||
    typeof payload.principalId !== "string" || !payload.principalId ||
    typeof payload.memberId !== "string" || !payload.memberId ||
    (payload.adapter !== "wechat" && payload.adapter !== "dev") ||
    typeof payload.expiresAt !== "number" || !Number.isFinite(payload.expiresAt)
  ) throw new DomainError("AUTH_INVALID", "Invalid session token", 401);
  if (payload.expiresAt <= now) throw new DomainError("AUTH_EXPIRED", "Session token expired", 401);
  return { id: payload.principalId, memberId: payload.memberId, roles: [], adapter: payload.adapter };
}

export function bearer(value: string | undefined): string {
  if (!value?.startsWith("Bearer ")) throw new DomainError("AUTH_REQUIRED", "Bearer session required", 401);
  return value.slice(7);
}
