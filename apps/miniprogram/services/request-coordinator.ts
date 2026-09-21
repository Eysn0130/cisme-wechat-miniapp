interface CachePolicy { ttlMs?: number; staleMs?: number; tags?: readonly string[] }
interface CacheEntry<T> { value?: T; expiresAt: number; staleUntil: number; pending?: Promise<T>; generation: number }

/** Session-scoped in-memory read coalescing with bounded TTL/SWR. */
export class RequestCoordinator {
  private cache = new Map<string, CacheEntry<unknown>>();
  private readonly maxEntries = 256;
  private generation = 0;
  private tagGeneration = new Map<string, number>();
  private flights = new WeakMap<Promise<unknown>, { consumers: number; settled: boolean; abort(): void }>();
  /** Each view owns a subscription, not the underlying shared transport. */
  acquire<T>(key: string, execute: () => { promise: Promise<T>; abort(): void }, policy: CachePolicy = {}): { promise: Promise<T>; abort(reason?: unknown): void; coalesced: boolean } {
    let started = false;
    const shared = this.read(key, () => {
      started = true;
      const task = execute();
      const flight = { consumers: 0, settled: false, abort: task.abort };
      this.flights.set(task.promise, flight);
      void task.promise.then(() => { flight.settled = true; }, () => { flight.settled = true; });
      return task.promise;
    }, policy);
    const flight = this.flights.get(shared);
    if (flight) flight.consumers++;
    let active = true, rejectOwn: (reason: unknown) => void = () => {};
    const leave = () => { if (flight) flight.consumers--; };
    const promise = new Promise<T>((resolve, reject) => {
      rejectOwn = reject;
      void shared.then(value => { if (active) { active = false; leave(); resolve(value); } }, error => { if (active) { active = false; leave(); reject(error); } });
    });
    return { promise, coalesced: !started, abort: (reason = { code: "REQUEST_ABORTED", title: "请求已取消" }) => {
      if (!active) return;
      active = false; leave(); rejectOwn(reason);
      if (flight && !flight.settled && flight.consumers === 0) {
        // Evict before abort: an immediate new reader must not join this dying
        // flight, and late rejection must not delete the new entry.
        for (const [cacheKey, entry] of this.cache) if (entry.pending === shared) this.cache.delete(cacheKey);
        flight.abort();
      }
    } };
  }
  private enforceCapacity(now: number): void {
    if (this.cache.size <= this.maxEntries) return;
    for (const [key, entry] of this.cache) {
      if (this.cache.size <= this.maxEntries) break;
      if (!entry.pending && entry.staleUntil <= now) this.cache.delete(key);
    }
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
  invalidate(tags?: readonly string[]): void {
    if (!tags?.length) { this.generation++; this.cache.clear(); return; }
    for (const tag of tags) this.tagGeneration.set(tag, (this.tagGeneration.get(tag) ?? 0) + 1);
    for (const [key, entry] of this.cache) {
      if (tags.some((tag) => key.includes(`|${tag}:${this.tagGeneration.get(tag)! - 1}`))) this.cache.delete(key);
      else if (entry.generation !== this.generation) this.cache.delete(key);
    }
  }
  read<T>(key: string, execute: () => Promise<T>, policy: CachePolicy = {}): Promise<T> {
    const tags = policy.tags ?? [];
    const tagScope = tags.map((tag) => `|${tag}:${this.tagGeneration.get(tag) ?? 0}`).join("");
    const scoped = `${this.generation}:${key}${tagScope}`;
    const now = Date.now();
    const existing = this.cache.get(scoped) as CacheEntry<T> | undefined;
    if (existing?.value !== undefined && now < existing.expiresAt) return Promise.resolve(existing.value);
    if (existing?.value !== undefined && now < existing.staleUntil) {
      if (!existing.pending) {
        const pending = execute();
        existing.pending = pending;
        void pending.then((value) => {
          if (this.cache.get(scoped) !== existing) return;
          existing.value = value; existing.expiresAt = Date.now() + (policy.ttlMs ?? 0); existing.staleUntil = existing.expiresAt + (policy.staleMs ?? 0); delete existing.pending;
        }, () => { if (this.cache.get(scoped) === existing) delete existing.pending; });
      }
      return Promise.resolve(existing.value);
    }
    if (existing?.pending) return existing.pending;
    const entry: CacheEntry<T> = existing ?? { expiresAt: 0, staleUntil: 0, generation: this.generation };
    const result = execute();
    entry.pending = result;
    this.cache.set(scoped, entry);
    this.enforceCapacity(now);
    void result.then((value) => {
      if (this.cache.get(scoped) !== entry) return;
      delete entry.pending;
      if ((policy.ttlMs ?? 0) > 0 || (policy.staleMs ?? 0) > 0) {
        entry.value = value; entry.expiresAt = Date.now() + (policy.ttlMs ?? 0); entry.staleUntil = entry.expiresAt + (policy.staleMs ?? 0);
      } else this.cache.delete(scoped);
    }, () => { if (this.cache.get(scoped) === entry) this.cache.delete(scoped); });
    return result;
  }
}
