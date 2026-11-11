import type { DbClient } from './db.js';

export interface CareDayRewards {
  careDay: string;
  pointsGranted: number;
  pointsReversed: number;
  debtOffset: number;
  pending: boolean;
  components: Array<{ code: string; points: number; reversed: number; ruleVersion: string; grantId: string }>;
}

/** Source-bound receipts, never inferred from a changing wallet balance. */
export async function careDayRewards(client: DbClient, memberId: string, days: readonly string[]) {
  const result = new Map<string, CareDayRewards>(days.map(careDay => [careDay, {
    careDay, pointsGranted: 0, pointsReversed: 0, debtOffset: 0, pending: false, components: []
  }]));
  if (!days.length) return result;
  const grants = (await client.query<{
    id: string; source_id: string; component: string; amount: number; reversed_total: number;
    rule_version: string; offset: string;
  }>(`SELECT g.id,g.source_id,g.component,g.amount,g.reversed_total,g.rule_version,
      COALESCE((SELECT sum(-e.debt_delta) FROM points_entry e
        WHERE e.member_id=g.member_id AND e.grant_id=g.id AND e.entry_type='debt_offset'),0)::text AS offset
    FROM points_grant g WHERE g.member_id=$1 AND g.source_id=ANY($2::text[])
      AND g.source_type IN ('care_day','care_streak') ORDER BY g.created_at,g.id`, [memberId, days])).rows;
  for (const grant of grants) {
    const receipt = result.get(grant.source_id)!;
    const offset = Number(grant.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > grant.amount) throw new Error('CARE_REWARD_RECEIPT_INVALID');
    receipt.pointsGranted += grant.amount;
    receipt.pointsReversed += grant.reversed_total;
    receipt.debtOffset += offset;
    receipt.components.push({ code: grant.component, points: grant.amount, reversed: grant.reversed_total,
      ruleVersion: grant.rule_version, grantId: grant.id });
  }
  const pending = (await client.query<{ day: string }>(`SELECT DISTINCT
      (occurred_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day
    FROM member_points_source_event WHERE member_id=$1 AND state='pending'
      AND kind IN ('care','care_cycle','care_usage')
      AND (occurred_at AT TIME ZONE 'Asia/Shanghai')::date=ANY($2::date[])`, [memberId, days])).rows;
  for (const row of pending) result.get(row.day)!.pending = true;
  return result;
}
