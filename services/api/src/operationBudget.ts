import { AsyncLocalStorage } from "node:async_hooks";
import { DomainError } from "@cisme/domain";
import type { FastifyInstance } from "fastify";

const context = new AsyncLocalStorage<OperationBudget>();
export const currentOperationBudget = (): OperationBudget | undefined => context.getStore();
export const runWithOperationBudget = <T>(budget: OperationBudget, work: () => T): T => context.run(budget, work);

/** One monotonic deadline; child transactions and dependencies cannot extend it. */
export class OperationBudget {
  readonly deadline: number;
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly parentSignal: AbortSignal | undefined;
  private readonly onParentAbort = () => this.abort(this.parentSignal?.reason);
  constructor(milliseconds: number, parent = currentOperationBudget(), signal?: AbortSignal) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error("INVALID_OPERATION_BUDGET");
    this.deadline = Math.min(performance.now() + milliseconds, parent?.deadline ?? Infinity);
    this.parentSignal = signal ?? parent?.signal;
    this.timer = setTimeout(() => this.abort(new DomainError("OPERATION_DEADLINE_EXCEEDED", "操作超时；写入结果请查询确认，不要更换幂等键重复提交", 503)), Math.max(0, this.deadline - performance.now()));
    this.timer.unref?.();
    this.parentSignal?.addEventListener("abort", this.onParentAbort, { once: true });
    if (this.parentSignal?.aborted) this.onParentAbort();
  }
  remaining(): number { this.check(); return Math.max(1, Math.floor(this.deadline - performance.now())); }
  check(): void {
    if (this.signal.aborted || performance.now() >= this.deadline) {
      const reason: unknown = this.signal.reason;
      throw reason instanceof DomainError ? reason : new DomainError("OPERATION_DEADLINE_EXCEEDED", "操作已中断或超时；写入结果需查询确认", 503);
    }
  }
  abort(reason?: unknown): void { if (!this.signal.aborted) this.controller.abort(reason); }
  dispose(): void { clearTimeout(this.timer); this.parentSignal?.removeEventListener("abort", this.onParentAbort); }
}

export function assertOperationActive(): void { currentOperationBudget()?.check(); }
export function dependencySignal(maximumMs: number): AbortSignal {
  const budget = currentOperationBudget();
  if (!budget) return AbortSignal.timeout(maximumMs);
  return budget.remaining() <= maximumMs ? budget.signal : AbortSignal.any([budget.signal, AbortSignal.timeout(maximumMs)]);
}

export function installRequestBudgets(app: FastifyInstance, milliseconds: number): void {
  // Callback-style run(done) deliberately includes the rest of Fastify's chain
  // in ALS; enterWith would leak one request's context into another request.
  app.addHook("onRequest", (request, reply, done) => {
    const budget = new OperationBudget(request.routeOptions.handlerTimeout || milliseconds, undefined, request.signal);
    const close = () => { budget.abort(new DomainError("OPERATION_CANCELLED", "请求已结束；未确认的写入请查询结果", 503)); budget.dispose(); };
    reply.raw.once("finish", close);
    reply.raw.once("close", close);
    runWithOperationBudget(budget, done);
  });
}
