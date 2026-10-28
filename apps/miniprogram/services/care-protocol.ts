export const careProtocolSteps = [
  {
    code: "00",
    label: "净澈",
    title: "周期净澈",
    eyebrow: "PREPARE",
    instruction: "按产品说明完成本次净澈。",
    cue: "用量、频次及冲洗方式以产品说明为准。"
  },
  {
    code: "01",
    label: "清洁",
    title: "日常头皮清洁",
    eyebrow: "CLEANSE",
    instruction: "按照清洁产品说明清洁头皮，动作轻缓，避免用指甲抓挠。",
    cue: "用量及冲洗方式以产品说明为准。"
  },
  {
    code: "02",
    label: "修护",
    title: "发丝水光修护",
    eyebrow: "REPAIR",
    instruction: "用于发丝，用量、停留和冲洗方式按产品说明。",
    cue: "本步骤护理发丝；出现明显不适时停止使用。"
  },
  {
    code: "03",
    label: "精护",
    title: "洗后头皮精护",
    eyebrow: "FINISH",
    instruction: "按照精护产品说明完成洗后头皮护理，再记录本次护理后的自我感受。",
    cue: "用量及使用方式以产品说明为准，避免用力摩擦。"
  }
] as const;

export type CareProtocolStepView = (typeof careProtocolSteps)[number];

export const careSelfAssessments = [
  { value: "comfortable", label: "舒适轻盈", note: "没有明显紧绷或不适" },
  { value: "neutral", label: "感觉一般", note: "与护理前相比变化不明显" },
  { value: "attention", label: "需要留意", note: "有不适感，建议暂停并观察" }
] as const;

export type CareSelfAssessmentValue = (typeof careSelfAssessments)[number]["value"];

export interface CareDaypart {
  greeting: "早上好" | "下午好" | "晚上好" | "夜深了";
  careAction: "开始今日护理" | "开始今晚护理";
  isNight: boolean;
}

function hourInTimezone(now: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23"
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23) return hour;
  } catch { /* Older runtimes fall back to the device-local hour. */ }
  return now.getHours();
}

export function careDaypart(now = new Date(), timezone = "Asia/Shanghai"): CareDaypart {
  const hour = hourInTimezone(now, timezone);
  if (hour < 5) return { greeting: "夜深了", careAction: "开始今晚护理", isNight: true };
  if (hour < 11) return { greeting: "早上好", careAction: "开始今日护理", isNight: false };
  if (hour < 18) return { greeting: "下午好", careAction: "开始今日护理", isNight: false };
  return { greeting: "晚上好", careAction: "开始今晚护理", isNight: true };
}

export function careGreeting(displayName: string | undefined, daypart: CareDaypart): string {
  const normalized = (displayName || "CISME 会员").trim().replace(/\s*会员$/, "").trim() || "CISME";
  return `${daypart.greeting}，${normalized}`;
}
