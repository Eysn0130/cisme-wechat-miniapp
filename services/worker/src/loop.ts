/** Run sequentially, including after a service resumes, and drain on shutdown. */
export function startWorkerLoop(run: () => Promise<void>, onError: (error: unknown) => void, intervalMs = 2_000) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void>;
  const tick = () => {
    current = Promise.resolve().then(run).catch(onError).finally(() => {
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
