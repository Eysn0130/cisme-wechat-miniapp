import { migrationReadOnly } from '@cisme/config';

/** Run sequentially, drain full batches immediately, and back off while idle or unhealthy.
 * The migration fence prevents admission of new work; stop() still drains an
 * already admitted job. Operators must drain every writer before migration.
 */
export function startWorkerLoop(run: () => Promise<boolean | void>, onError: (error: unknown) => void, intervalMs = 2_000) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void>;
  const tick = () => {
    current = Promise.resolve().then(() => migrationReadOnly() ? false : run()).then((hasMore) => {
      if (!stopped) timer = setTimeout(tick, hasMore ? 0 : intervalMs);
    }).catch((error) => {
      onError(error);
      if (!stopped) timer = setTimeout(tick, intervalMs);
    });
  };
  tick();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    }
  };
}
