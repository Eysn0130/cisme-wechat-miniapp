import { expect,it } from 'vitest';
import type COS from 'cos-nodejs-sdk-v5';
import { loadConfig } from '@cisme/config';
import { createCosSuppressionRemote } from '../../services/api/src/accountClosureRemote';
import type { Marker } from '../../services/api/src/accountClosure';

it('stores only immutable identity digests and replays every paginated remote marker',async()=>{
  const config=loadConfig({APP_ENV:'test',DATABASE_URL:'postgres://unused/cisme_test',APP_SESSION_SECRET:'closure-remote',
    UPLOAD_TOKEN_SECRET:'closure-remote-upload',
    OBJECT_STORAGE_DRIVER:'cos_gateway',S3_ACCESS_KEY_ID:'fixture',S3_SECRET_ACCESS_KEY:'fixture',
    S3_BUCKET:'fixture-bucket',S3_REGION:'ap-shanghai',WECHAT_APP_ID:'wx4eac2d4fb11d299b'});
  const objects=new Map<string,Buffer>();let versioned=false;
  const client={
    getBucketVersioning:async()=>({VersioningConfiguration:versioned?{Status:'Enabled'}:{}}),
    putObject:async(input:{Key:string;Body:Buffer;Headers:Record<string,string>})=>{
      expect(input.Headers['x-cos-forbid-overwrite']).toBe('true');
      if(objects.has(input.Key))throw new Error('ObjectAlreadyExists');
      objects.set(input.Key,Buffer.from(input.Body));return {};
    },
    getObject:async(input:{Key:string})=>{const Body=objects.get(input.Key);if(!Body)throw new Error('NoSuchKey');return {Body};},
    getBucket:async(input:{Prefix:string;Marker?:string})=>{
      const keys=[...objects.keys()].filter(key=>key.startsWith(input.Prefix)&&(!input.Marker||key>input.Marker)).sort();
      const first=keys[0];
      return {Contents:first?[{Key:first}]:[],IsTruncated:keys.length>1?'true':'false',NextMarker:first};
    }
  } as unknown as COS;
  const remote=createCosSuppressionRemote(config,client);
  const rows:Marker[]=[1,2].map(n=>({version:1,memberId:`00000000-0000-4000-8000-00000000000${n}`,
    identityDigest:String(n).repeat(64),requestId:`11111111-1111-4111-8111-11111111111${n}`,createdAt:'2026-09-23T00:00:00.000Z'}));
  for(const row of rows)await remote.put(row);
  const profile:Marker={version:2,memberId:rows[0]!.memberId,identityDigest:rows[0]!.identityDigest,
    requestId:'22222222-2222-4222-8222-222222222222',createdAt:'2026-09-23T01:00:00.000Z',
    scope:'member_optional_profile_v1',displayNameSha256:'e'.repeat(64)};
  await remote.put(profile);
  await remote.put(rows[0]!);
  expect(await remote.list()).toEqual([rows[0],profile,rows[1]]);
  expect(JSON.stringify([...objects.values()].map(value=>value.toString()))).not.toContain('openid');
  await expect(remote.put({...rows[0]!,identityDigest:'f'.repeat(64)})).rejects.toThrow('ObjectAlreadyExists');
  versioned=true;
  await expect(remote.list()).rejects.toThrow('ACCOUNT_CLOSURE_REMOTE_VERSIONING_UNSAFE');
  await expect(remote.put(rows[0]!)).rejects.toThrow('ACCOUNT_CLOSURE_REMOTE_VERSIONING_UNSAFE');
});
