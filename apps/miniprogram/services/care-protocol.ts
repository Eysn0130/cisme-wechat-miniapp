export const careProtocolSteps = [
  {
    code: "00",
    label: "净澈",
    title: "温和净澈",
    eyebrow: "PREPARE",
    instruction: "先充分湿润头皮与发根，用指腹轻柔带走表面附着物，为后续护理做好准备。",
    cue: "保持动作轻缓，不抓挠头皮。"
  },
  {
    code: "01",
    label: "清洁",
    title: "日常清洁",
    eyebrow: "CLEANSE",
    instruction: "将清洁产品在掌心起泡后分区带到头皮，用指腹画小圈清洁，再彻底冲净。",
    cue: "重点照顾发际线与耳后，避免用指甲。"
  },
  {
    code: "02",
    label: "修护",
    title: "舒缓修护",
    eyebrow: "REPAIR",
    instruction: "擦去多余水分后，将护理精华分线点涂于头皮，轻按帮助均匀覆盖。",
    cue: "少量多点，出现明显不适时停止使用。"
  },
  {
    code: "03",
    label: "精护",
    title: "专注精护",
    eyebrow: "FINISH",
    instruction: "用指腹由两侧向头顶缓慢按压，完成本次护理，让头皮自然保持轻盈。",
    cue: "约 60 秒即可，无需用力摩擦。"
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
