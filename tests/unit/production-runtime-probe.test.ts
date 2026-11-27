import {expect,it,vi} from 'vitest';
import {probeProductionRuntime} from '../../scripts/production-runtime-probe';

const product={sourceKind:'admin',qualificationStatus:'eligible',publicationStatus:'published',purchaseEnabled:true,
  variants:[{active:true,currency:'CNY',priceCents:19800,purchaseEnabled:true,availableQuantity:100}]};
const current:Record<string,unknown>={
  '/health/ready':{status:'ready'},'/v1/identity/capabilities':{phoneBindingEnabled:false},
  '/v1/capabilities':{pointsRulesEnabled:true,pointsRedemptionEnabled:true,ugcGoLiveGate:true},
  '/v1/ugc/status':{publicEnabled:true},'/v1/catalog':{checkoutEnabled:true,items:[product]}
};
const json=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const fetcher=(values:Record<string,unknown>=current)=>vi.fn<typeof fetch>(async input=>json(values[new URL(String(input)).pathname]));

it('checks the commercial production runtime with anonymous GETs, without treating success as full release approval',async()=>{
  const read=fetcher(),result=await probeProductionRuntime(read);
  expect(result.ok).toBe(true);expect(result.probes).toHaveLength(5);
  for(const [url,options] of read.mock.calls){
    expect(new URL(String(url)).origin).toBe('https://api.cisme.cn');
    expect(options).toMatchObject({method:'GET',credentials:'omit',redirect:'manual',cache:'no-store'});
    expect(options?.headers).toEqual({Accept:'application/json'});
  }
  expect(result).not.toHaveProperty('releaseReady');expect(JSON.stringify(result)).not.toContain('19800');
});
it('rejects the actual stale-production pattern even when health and HTTP return success',async()=>{
  const result=await probeProductionRuntime(fetcher({...current,
    '/v1/capabilities':{pointsRulesEnabled:false,pointsRedemptionEnabled:false,ugcGoLiveGate:false},
    '/v1/ugc/status':{publicEnabled:false},'/v1/catalog':{checkoutEnabled:false,items:[]}
  }));
  expect(result.ok).toBe(false);expect(result.errors).toEqual(expect.arrayContaining([
    'PRODUCTION_POINTS_RULES_DISABLED','PRODUCTION_POINTS_REDEMPTION_DISABLED',
    'PRODUCTION_UGC_DISABLED','PRODUCTION_PUBLICATION_UNAVAILABLE','PRODUCTION_CHECKOUT_DISABLED','PRODUCTION_SELLABLE_CATALOG_EMPTY'
  ]));
});
it('requires phone binding to remain disabled for the current WeChat privacy contract',async()=>{
  const enabled=await probeProductionRuntime(fetcher({...current,'/v1/identity/capabilities':{phoneBindingEnabled:true}}));
  expect(enabled.errors).toEqual(['PRODUCTION_PHONE_BINDING_REENABLED']);
  const missing=await probeProductionRuntime(fetcher({...current,'/v1/identity/capabilities':{}}));
  expect(missing.errors).toEqual(['PRODUCTION_IDENTITY_CAPABILITIES_INVALID']);
});
it.each(['synthetic_test','legacy_preview'])('does not count %s as real saleable inventory',async sourceKind=>{
  const result=await probeProductionRuntime(fetcher({...current,'/v1/catalog':{checkoutEnabled:true,items:[{...product,sourceKind}]}}));
  expect(result.errors).toContain('PRODUCTION_SELLABLE_CATALOG_EMPTY');
});
it.each([0,-1,1.5,NaN])('does not count invalid/empty stock %s as saleable',async availableQuantity=>{
  const result=await probeProductionRuntime(fetcher({...current,'/v1/catalog':{checkoutEnabled:true,items:[{...product,variants:[{...product.variants[0],availableQuantity}]}]}}));
  expect(result.errors).toContain('PRODUCTION_SELLABLE_CATALOG_EMPTY');
});
it('rejects redirects without following an unexpected origin',async()=>{
  const read=vi.fn<typeof fetch>(async()=>new Response(null,{status:302,headers:{location:'https://other.example'}}));
  const result=await probeProductionRuntime(read);expect(result.ok).toBe(false);
  expect(result.errors).toEqual(['PRODUCTION_RUNTIME_HTTP_FAILED']);expect(read).toHaveBeenCalledTimes(5);
});
it('rejects deceptive MIME and oversized streams without disclosing response bytes',async()=>{
  const bad=await probeProductionRuntime(vi.fn<typeof fetch>(async()=>new Response('{}',{headers:{'content-type':'application/json-not-json'}})));
  expect(bad.errors).toEqual(['PRODUCTION_RUNTIME_JSON_INVALID']);
  const cancel=vi.fn(),read=vi.fn<typeof fetch>(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1_048_577));},cancel}),{headers:{'content-type':'application/json'}}));
  const large=await probeProductionRuntime(read);expect(large.errors).toEqual(['PRODUCTION_RUNTIME_RESPONSE_TOO_LARGE']);
  expect(cancel).toHaveBeenCalledTimes(5);
});
it('bounds stalled requests and does not echo transport errors or credentials',async()=>{
  const read=vi.fn<typeof fetch>((_,options)=>new Promise((_,reject)=>options!.signal!.addEventListener('abort',()=>reject(new Error('private transport detail')))));
  const result=await probeProductionRuntime(read,5);expect(result.errors).toEqual(['PRODUCTION_RUNTIME_TIMEOUT']);
  expect(JSON.stringify(result)).not.toContain('private transport detail');
});
it('refuses an invalid budget without making requests',async()=>{
  const read=fetcher();expect((await probeProductionRuntime(read,0)).errors).toEqual(['PRODUCTION_PROBE_BUDGET_INVALID']);expect(read).not.toHaveBeenCalled();
});
