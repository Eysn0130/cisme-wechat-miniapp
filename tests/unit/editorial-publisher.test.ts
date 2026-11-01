import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {defaultEditorialPublisherName,defaultEditorialPublisherAvatar,editorialPublisherAvatar} from '../../apps/miniprogram/services/editorial-publisher';

describe('owner-published editorial brand presentation',()=>{
 it('declares a supported JPEG portrait explicitly for upload packaging',()=>{
  const config=JSON.parse(readFileSync(new URL('../../apps/miniprogram/project.config.json',import.meta.url),'utf8'));
  expect(config.packOptions.include).toContainEqual({type:'file',value:defaultEditorialPublisherAvatar.slice(1)});
  const bytes=readFileSync(new URL(`../../apps/miniprogram${defaultEditorialPublisherAvatar}`,import.meta.url));
  expect([...bytes.subarray(0,3)]).toEqual([0xff,0xd8,0xff]);
 });
 it('uses the authorized local portrait only for the exact brand name and retains neutral presentation for other authors',()=>{
  expect(editorialPublisherAvatar(defaultEditorialPublisherName,'neutral-avatar')).toBe(defaultEditorialPublisherAvatar);
  for(const author of ['另一作者',`${defaultEditorialPublisherName}客服`,'',null,undefined])
   expect(editorialPublisherAvatar(author,'neutral-avatar')).toBe('neutral-avatar');
 });
});
