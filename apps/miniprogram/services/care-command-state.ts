interface CareFact { id: string; version: number; startedOn?: string | null; records?: { milestone: string; completedAt?: string; stepCodes?: string[]; selfAssessment?: string | null }[] }
export interface CareCommand { path: string; key: string; data: WechatMiniprogram.IAnyObject; token: string }
/** Desired facts in a fresh server snapshot can confirm a lost response. An
 * absent record is NOT proof that a write was never executed. */
export function careCommandConfirmed(command: CareCommand, care: CareFact | null): boolean {
  if (!care) return false;
  const activate = /^\/v1\/care-cycles\/([^/]+)\/activate$/.exec(command.path);
  if (activate) return care.id === activate[1] && typeof care.startedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(care.startedOn)
    && Number.isSafeInteger(command.data.expectedVersion) && care.version > command.data.expectedVersion;
  const complete = /^\/v1\/care-cycles\/([^/]+)\/milestones\/(D1|D7|D14|D28)\/complete$/.exec(command.path);
  if (!complete || care.id !== complete[1]) return false;
  return Boolean(care.records?.some(record => record.milestone === complete[2]
    && typeof record.completedAt === "string" && Number.isFinite(Date.parse(record.completedAt))
    && Array.isArray(record.stepCodes) && record.stepCodes.join(",") === "00,01,02,03"
    && Array.isArray(command.data.stepCodes) && command.data.stepCodes.join(",") === "00,01,02,03"
    && record.selfAssessment === command.data.selfAssessment));
}
