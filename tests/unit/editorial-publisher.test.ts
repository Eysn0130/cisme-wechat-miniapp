import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {defaultEditorialPublisherName,defaultEditorialPublisherAvatar,editorialPublisherAvatar,officialEditorialPublisherId} from '../../apps/miniprogram/services/editorial-publisher';
import {CISME_OFFICIAL_PUBLISHER} from '@cisme/contracts';

describe('owner-published editorial brand presentation',()=>{
 it('declares a supported JPEG portrait explicitly for upload packaging',()=>{
  const config=JSON.parse(readFileSync(new URL('../../apps/miniprogram/project.config.json',import.meta.url),'utf8'));
  expect(config.packOptions.include).toContainEqual({type:'file',value:defaultEditorialPublisherAvatar.slice(1)});
  const bytes=readFileSync(new URL(`../../apps/miniprogram${defaultEditorialPublisherAvatar}`,import.meta.url));
  expect([...bytes.subarray(0,3)]).toEqual([0xff,0xd8,0xff]);
 });
 it('uses the independent official identity; matching a brand nickname never impersonates it',()=>{
  expect(officialEditorialPublisherId).toBe(CISME_OFFICIAL_PUBLISHER.id);
  expect(editorialPublisherAvatar(defaultEditorialPublisherName,'neutral-avatar',officialEditorialPublisherId)).toBe(defaultEditorialPublisherAvatar);
  for(const author of [defaultEditorialPublisherName,'另一作者',`${defaultEditorialPublisherName}客服`,'',null,undefined])
   expect(editorialPublisherAvatar(author,'neutral-avatar')).toBe('neutral-avatar');
  expect(editorialPublisherAvatar(defaultEditorialPublisherName,'personal-avatar','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBe('personal-avatar');
 });
});
