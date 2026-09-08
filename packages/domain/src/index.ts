import { CARE_MILESTONES, type CareMilestone } from "@cisme/contracts";

const milestoneOffset: Record<CareMilestone, number> = { D1: 0, D7: 6, D14: 13, D28: 27 };

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409
  ) {
    super(message);
  }
}

export function milestoneDueOn(startedOn: string, milestone: CareMilestone, scheduleOffsetDays = 0): string {
  const start = new Date(`${startedOn}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() + milestoneOffset[milestone] + scheduleOffsetDays);
  return start.toISOString().slice(0, 10);
}

export function deriveDueMilestone(
  startedOn: string | null,
  completed: readonly CareMilestone[],
  now: Date,
  timezone = "UTC",
  scheduleOffsetDays = 0
): CareMilestone | null {
  if (!startedOn) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const today = `${values.year}-${values.month}-${values.day}`;
  const completedSet = new Set(completed);
  return CARE_MILESTONES.find((milestone) => !completedSet.has(milestone) && milestoneDueOn(startedOn, milestone, scheduleOffsetDays) <= today) ?? null;
}

export function assertMilestone(value: string): asserts value is CareMilestone {
  if (!CARE_MILESTONES.includes(value as CareMilestone)) {
    throw new DomainError("INVALID_MILESTONE", `Unsupported care milestone: ${value}`, 400);
  }
}

export function assertTimezone(value: string): void {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
  } catch {
    throw new DomainError("INVALID_TIMEZONE", `Invalid IANA timezone: ${value}`, 400);
  }
}

export function sha256Base64(bytes: Uint8Array): Promise<string> {
  return import("node:crypto").then(({ createHash }) => createHash("sha256").update(bytes).digest("base64"));
}
