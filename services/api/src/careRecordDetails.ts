import { CARE_PROTOCOL_STEPS, CARE_SELF_ASSESSMENTS, type CareMilestoneCommandInput } from "@cisme/contracts";
import { DomainError } from "@cisme/domain";

/** Shared ordered facts for milestone and independent daily care records. */
export function requireCareRecordDetails(input: Pick<CareMilestoneCommandInput, "stepCodes" | "selfAssessment"> | undefined): Pick<CareMilestoneCommandInput, "stepCodes" | "selfAssessment"> {
  const stepCodes = input?.stepCodes;
  if (!Array.isArray(stepCodes) || stepCodes.length !== CARE_PROTOCOL_STEPS.length || stepCodes.some((step, index) => step !== CARE_PROTOCOL_STEPS[index])) {
    throw new DomainError("CARE_PROTOCOL_STEPS_INCOMPLETE", "All care protocol steps must be completed in order", 422);
  }
  if (!CARE_SELF_ASSESSMENTS.includes(input?.selfAssessment as (typeof CARE_SELF_ASSESSMENTS)[number])) {
    throw new DomainError("CARE_SELF_ASSESSMENT_REQUIRED", "A supported post-care self-assessment is required", 422);
  }
  return { stepCodes: [...stepCodes], selfAssessment: input!.selfAssessment };
}
