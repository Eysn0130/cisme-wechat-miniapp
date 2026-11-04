import {createCipheriv,createHash} from 'node:crypto';
import type pg from 'pg';
import {expect,it,vi} from 'vitest';
import {loadConfig} from '@cisme/config';
import {UgcSafetyService} from '../../services/api/src/ugcSafety';
import type {ObjectStorage} from '../../services/api/src/storage';

const token='synthetic-callback-token';
const key=Buffer.from('0123456789abcdef0123456789abcdef');
const appId='wx4eac2d4fb11d299b';
const base=loadConfig({APP_ENV:'test',DATABASE_URL:'postgres://local/test',
  APP_SESSION_SECRET:'synthetic-session-secret',UPLOAD_TOKEN_SECRET:'synthetic-upload-secret'});
const config={...base,env:'staging' as const,wechat:{...base.wechat,appId,messageToken:token,
  messageAesKey:key.toString('base64').slice(0,43),plaintextCallbackTestOnly:false}};
function service(){
  const query=vi.fn(),fetcher=vi.fn();
  return {query,fetcher,safety:new UgcSafetyService({query} as unknown as pg.Pool,
    config,{} as ObjectStorage,fetcher)};
}
function signed(timestamp=String(Math.floor(Date.now()/1000))){
  const nonce='synthetic-challenge-nonce';
  return {timestamp,nonce,signature:createHash('sha1').update([token,timestamp,nonce].sort().join('')).digest('hex')};
}
function encrypted(content:string){
  const bytes=Buffer.from(content),length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);
  const plain=Buffer.concat([Buffer.from('abcdefghijklmnop'),length,bytes,Buffer.from(appId)]);
  const padding=32-plain.length%32;
  const cipher=createCipheriv('aes-256-cbc',key,key.subarray(0,16));cipher.setAutoPadding(false);
  const echostr=Buffer.concat([cipher.update(Buffer.concat([plain,Buffer.alloc(padding,padding)])),cipher.final()]).toString('base64');
  const query=signed();
  return {...query,echostr,msg_signature:createHash('sha1').update([token,query.timestamp,query.nonce,echostr].sort().join('')).digest('hex')};
}

it('accepts a token-signed URL challenge while live message delivery remains encrypted',async()=>{
  const {safety,query,fetcher}=service();
  expect(safety.verifyChallenge({...signed(),echostr:'configuration-check-001'})).toBe('configuration-check-001');
  await expect(safety.receiveCallback(signed(),{Event:'wxa_media_check'}))
    .rejects.toMatchObject({code:'UGC_CALLBACK_ENCRYPTION_REQUIRED'});
  expect(query).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
});
it('keeps the existing recipient-bound encrypted URL challenge working',()=>{
  expect(service().safety.verifyChallenge(encrypted('encrypted-check-001'))).toBe('encrypted-check-001');
});
it('rejects missing, forged and expired URL signatures',()=>{
  const {safety}=service();
  for(const query of [{timestamp:signed().timestamp,nonce:'nonce'},
    {...signed(),signature:'0'.repeat(40)},signed(String(Math.floor(Date.now()/1000)-601))]){
    expect(()=>safety.verifyChallenge({...query,echostr:'challenge'})).toThrow();
  }
});
it('does not downgrade an invalid encrypted challenge to its valid plain signature',()=>{
  expect(()=>service().safety.verifyChallenge({...signed(),echostr:'plain-check',msg_signature:'0'.repeat(40)})).toThrow();
});
it('rejects empty or oversized verification responses',()=>{
  for(const echostr of ['', 'a'.repeat(4097)])expect(()=>service().safety.verifyChallenge({...signed(),echostr})).toThrow();
});
