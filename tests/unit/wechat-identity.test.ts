import {it,expect,vi} from 'vitest';
import {exchangeWechatIdentity} from '../../services/api/src/wechatIdentity';
it('bounds a chunked identity response, cancels it and does not follow credential-bearing redirects',async()=>{
 let canceled=false;
 const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(32768));},cancel(){canceled=true;}});
 const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
 await expect(exchangeWechatIdentity('synthetic-app','synthetic-secret','synthetic-code',fetcher)).rejects.toMatchObject({code:'WECHAT_LOGIN_FAILED'});
 expect(canceled).toBe(true);expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
});
it('rejects code coercion before any provider call',async()=>{
 const fetcher=vi.fn<typeof fetch>();
 for(const code of [undefined,null,{},42,'','contains space','x'.repeat(257)])
  await expect(exchangeWechatIdentity('synthetic-app','synthetic-secret',code,fetcher)).rejects.toMatchObject({code:'WECHAT_LOGIN_CODE_INVALID'});
 expect(fetcher).not.toHaveBeenCalled();
});
