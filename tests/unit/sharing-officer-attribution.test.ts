import {beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({request:vi.fn(),token:'',origin:'https://staging-api.cisme.cn'}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request}));
let storage:Map<string,any>;
const a='a'.repeat(32),b='b'.repeat(32),tokenA='A'.repeat(43),tokenB='B'.repeat(43),key='cisme.officer-visits.v1';
function deferred(){let resolve!:(v:any)=>void;const promise=new Promise<any>(yes=>resolve=yes);return {promise,resolve};}
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();m.token='';m.origin='https://staging-api.cisme.cn';storage=new Map();
 (globalThis as any).wx={getStorageSync:(k:string)=>storage.get(k),setStorageSync:(k:string,v:any)=>storage.set(k,structuredClone(v))};
 (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token,apiBaseUrl:m.origin}});
});
it('persists a failed anonymous visit and retries the same visit key before binding on login',async()=>{
 const api=await import('../../apps/miniprogram/services/officer-attribution');m.request.mockRejectedValueOnce({code:'NETWORK_ERROR'});
 await expect(api.incomingOfficerShare(a,'test-product')).rejects.toMatchObject({code:'NETWORK_ERROR'});const original=m.request.mock.calls[0]![0].data.visitKey;expect(storage.get(key)).toHaveLength(1);
 m.token='owner-a';m.request.mockImplementation(async(o:any)=>o.path.includes('/visits')?{productCode:'test-product',visitToken:tokenA}:{recorded:true});
 await api.flushOfficerVisits();expect(m.request.mock.calls[1]![0].data.visitKey).toBe(original);expect(m.request.mock.calls[2]![0]).toMatchObject({idempotencyKey:'touch-'+tokenA,data:{action:'bind_visit',input:{visitToken:tokenA}}});expect(storage.get(key)).toHaveLength(0);
});
it('drains visits arriving during a current flush without deadlocking or dropping a recommendation',async()=>{
 const api=await import('../../apps/miniprogram/services/officer-attribution'),first=deferred();m.token='owner-a';
 m.request.mockImplementation((o:any)=>o.path.includes(a)?first.promise:o.path.includes(b)?Promise.resolve({productCode:'test-product',visitToken:tokenB}):Promise.resolve({recorded:true}));
 const one=api.incomingOfficerShare(a,'test-product'),two=api.incomingOfficerShare(b,'test-product');
 first.resolve({productCode:'test-product',visitToken:tokenA});await Promise.all([one,two,api.flushOfficerVisits()]);
 const binds=m.request.mock.calls.map(c=>c[0]).filter(c=>c.data.action==='bind_visit');expect(binds).toHaveLength(2);expect(new Set(binds.map(c=>c.data.input.visitToken))).toEqual(new Set([tokenA,tokenB]));expect(storage.get(key)).toHaveLength(0);
});
it('keeps staging recommendations out of another API environment after a late response',async()=>{
 const api=await import('../../apps/miniprogram/services/officer-attribution'),pending=deferred();m.request.mockReturnValue(pending.promise);
 const op=api.incomingOfficerShare(a,'test-product');m.origin='https://api.cisme.cn';m.token='other-owner';pending.resolve({productCode:'test-product',visitToken:tokenA});await op;await api.flushOfficerVisits();
 expect(m.request).toHaveBeenCalledTimes(1);expect(storage.get(key)[0]).not.toHaveProperty('token');
});
it('retains a failed identity binding and reuses its idempotency key',async()=>{
 const api=await import('../../apps/miniprogram/services/officer-attribution');m.request.mockResolvedValue({productCode:'test-product',visitToken:tokenA});await api.incomingOfficerShare(a,'test-product');m.token='owner-a';
 m.request.mockRejectedValueOnce({code:'NETWORK_TIMEOUT'});await expect(api.flushOfficerVisits()).rejects.toMatchObject({code:'NETWORK_TIMEOUT'});expect(storage.get(key)).toHaveLength(1);
 m.request.mockResolvedValue({recorded:true});await api.flushOfficerVisits();expect(m.request.mock.calls[1]![0].idempotencyKey).toBe(m.request.mock.calls[2]![0].idempotencyKey);expect(storage.get(key)).toHaveLength(0);
});
it('drops a definitively invalid link without blocking unrelated checkout, and rejects corrupted recovery data',async()=>{
 const api=await import('../../apps/miniprogram/services/officer-attribution');m.request.mockRejectedValue({code:'SHARING_LINK_NOT_FOUND'});expect(await api.incomingOfficerShare(a)).toBeNull();expect(storage.get(key)).toHaveLength(0);
 storage.set(key,[{shareId:'bad'}]);m.token='owner-a';await expect(api.flushOfficerVisits()).rejects.toMatchObject({code:'SHARING_RECOVERY_INVALID'});
});
