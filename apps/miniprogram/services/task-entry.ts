export interface ConsumerTaskEntry {
  id: string;
  name?: string;
  claimable?: boolean;
  submission_id?: string;
  submission_status?: string;
  actionLabel: string;
  statusLabel: string;
  actionPriority: number;
}

function taskAction(task: Omit<ConsumerTaskEntry, "actionLabel" | "statusLabel" | "actionPriority">): Pick<ConsumerTaskEntry, "actionLabel" | "statusLabel" | "actionPriority"> {
  switch (task.submission_status) {
    case "rejected": return { actionLabel: "查看结果并申请复核", statusLabel: "待处理 · 审核未通过", actionPriority: 0 };
    case "needs_changes": return { actionLabel: "按审核要求补件", statusLabel: "待处理 · 需要补件", actionPriority: 1 };
    case "draft": return { actionLabel: "继续完成投稿", statusLabel: "草稿待提交", actionPriority: 2 };
    case "submitted": return { actionLabel: "查看审核进度", statusLabel: "人工审核中", actionPriority: 4 };
    case "appealed": return { actionLabel: "查看复核进度", statusLabel: "人工复核中", actionPriority: 4 };
    case "approved": return { actionLabel: "查看审核结果", statusLabel: "审核已通过", actionPriority: 5 };
    default:
      return task.claimable
        ? { actionLabel: "领取有效投稿邀请", statusLabel: "邀请可领取", actionPriority: 3 }
        : { actionLabel: "查看投稿记录", statusLabel: "投稿记录", actionPriority: 6 };
  }
}

export function consumerTaskEntries(history: any[]): ConsumerTaskEntry[] {
  return history
    .filter((task) => task.claimable === true || Boolean(task.submission_id))
    .map((task) => ({ ...task, ...taskAction(task) }))
    .sort((left, right) => left.actionPriority - right.actionPriority || String(left.id).localeCompare(String(right.id)));
}
