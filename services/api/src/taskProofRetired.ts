import { DomainError } from "@cisme/domain";

/** Compatibility response for removed task/proof clients; this is not a feature flag. */
export function taskProofRetired(): never {
  throw new DomainError("TASK_PROOF_REMOVED", "任务投稿与发布证明流程已移除，请返回社区。", 410);
}
