import { request, type RequestOptions } from "./api";
const owners = new WeakMap<object, Set<() => void>>();
/** Immediate lifecycle cancellation is subscription-scoped; other pages keep
 * their shared read. Never use this helper for a write operation. */
export function pageRead<T>(page: object, options: Omit<RequestOptions, "method" | "registerAbort">): Promise<T> {
  let handles = owners.get(page);
  if (!handles) { handles = new Set(); owners.set(page, handles); }
  let cancel: (() => void) | undefined;
  return request<T>({ ...options, registerAbort: abort => { cancel = abort; handles!.add(abort); } })
    .finally(() => { if (cancel) handles!.delete(cancel); });
}
export function cancelPageReads(page: object): void {
  const handles = owners.get(page); owners.delete(page);
  for (const abort of handles ?? []) abort();
  handles?.clear();
}
