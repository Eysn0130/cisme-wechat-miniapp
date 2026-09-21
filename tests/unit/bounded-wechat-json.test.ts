import {it,expect} from 'vitest';
import {boundedWechatJson} from '../../services/api/src/boundedWechatJson';
it('cancels a chunked oversized response even when Content-Length is absent',async()=>{
 let canceled=false;
 const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(32768));},cancel(){canceled=true;}});
 await expect(boundedWechatJson(new Response(stream))).rejects.toMatchObject({code:'WECHAT_DEPENDENCY_RESPONSE_INVALID'});
 expect(canceled).toBe(true);
});
it('rejects non-object, malformed and non-success responses without disclosing their bodies',async()=>{
 for(const response of [new Response('null'),new Response('[]'),new Response('private-upstream-body'),new Response('private-upstream-body',{status:503})]){
  try{await boundedWechatJson(response);throw new Error('Expected rejection');}catch(error){
   expect(error).toMatchObject({code:'WECHAT_DEPENDENCY_RESPONSE_INVALID'});expect(String(error)).not.toContain('private-upstream-body');
  }
 }
 expect(await boundedWechatJson(new Response('{"errcode":0}'))).toEqual({errcode:0});
});
