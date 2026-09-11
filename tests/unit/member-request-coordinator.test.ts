import { describe, expect, it, vi } from 'vitest';
import { RequestCoordinator } from '../../apps/miniprogram/services/request-coordinator';
const deferred = () => { let resolve!:(value:number)=>void; const promise=new Promise<number>(r=>resolve=r);return {promise,resolve}; };
describe('concurrent native reads',()=>{
 it('coalesces concurrent reads but never treats a completed read as current authority',async()=>{
  const queue=new RequestCoordinator(),pending=deferred(),run=vi.fn(()=>pending.promise);
  const first=queue.read('member:care',run),second=queue.read('member:care',run);
  expect(first).toBe(second);expect(run).toHaveBeenCalledTimes(1);
  pending.resolve(1);await first;
  await queue.read('member:care',run);expect(run).toHaveBeenCalledTimes(2);
 });
 it('isolates identity keys and invalidates reads around writes without old completion deleting new work',async()=>{
  const queue=new RequestCoordinator(),old=deferred(),fresh=deferred();
  const run=vi.fn(()=>fresh.promise);
  const a=queue.read('a',()=>old.promise);queue.invalidate();
  const b=queue.read('a',run);expect(a).not.toBe(b);
  old.resolve(1);await a;expect(queue.read('a',run)).toBe(b);expect(run).toHaveBeenCalledTimes(1);
  expect(queue.read('other-member',()=>Promise.resolve(2))).not.toBe(b);
 fresh.resolve(3);await b;
 });
 it('serves bounded session-local cache entries and invalidates only matching tags',async()=>{
  vi.useFakeTimers();
  try {
   const queue=new RequestCoordinator();let member=1;let feed=10;
   const memberRead=vi.fn(async()=>member),feedRead=vi.fn(async()=>feed);
   expect(await queue.read('session-a:member',memberRead,{ttlMs:1000,tags:['member']})).toBe(1);
   member=2;
   expect(await queue.read('session-a:member',memberRead,{ttlMs:1000,tags:['member']})).toBe(1);
   expect(await queue.read('session-a:feed',feedRead,{ttlMs:1000,tags:['feed']})).toBe(10);
   queue.invalidate(['member']);
   expect(await queue.read('session-a:member',memberRead,{ttlMs:1000,tags:['member']})).toBe(2);
   feed=11;
   expect(await queue.read('session-a:feed',feedRead,{ttlMs:1000,tags:['feed']})).toBe(10);
  } finally { vi.useRealTimers(); }
 });
 it('serves stale data to every reader while one background refresh is pending',async()=>{
  vi.useFakeTimers();
  try {
   const queue=new RequestCoordinator();
   expect(await queue.read('feed',async()=>1,{ttlMs:100,staleMs:1000,tags:['feed']})).toBe(1);
   await vi.advanceTimersByTimeAsync(101);
   const refresh=deferred();
   const run=vi.fn(()=>refresh.promise);
   const first=queue.read('feed',run,{ttlMs:100,staleMs:1000,tags:['feed']});
   const second=queue.read('feed',run,{ttlMs:100,staleMs:1000,tags:['feed']});
   expect(await first).toBe(1);
   expect(await second).toBe(1);
   expect(run).toHaveBeenCalledTimes(1);
   refresh.resolve(2);
   await refresh.promise;
   await Promise.resolve();
   expect(await queue.read('feed',run,{ttlMs:100,staleMs:1000,tags:['feed']})).toBe(2);
  } finally { vi.useRealTimers(); }
 });
});
