import type { DbClient } from "./db.js";
import type { EventType } from "@cisme/contracts";

export async function enqueue(
  client: DbClient,
  event: { eventType: EventType; aggregateType: string; aggregateId: string; aggregateVersion: number; businessKey: string; payload: Record<string, unknown>; occurredAt: Date }
): Promise<void> {
  await client.query(`
    INSERT INTO outbox_event(event_type, aggregate_type, aggregate_id, aggregate_version, business_key, payload, occurred_at, next_attempt_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
    ON CONFLICT (business_key) DO NOTHING
  `, [event.eventType, event.aggregateType, event.aggregateId, event.aggregateVersion, event.businessKey, event.payload, event.occurredAt]);
}
