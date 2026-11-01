import {describe,expect,it} from 'vitest';
import {defaultEditorialPublisherName,defaultEditorialPublisherAvatar,editorialPublisherAvatar} from '../../apps/miniprogram/services/editorial-publisher';

describe('owner-published editorial brand presentation',()=>{
 it('uses the authorized local portrait only for the exact brand name and retains neutral presentation for other authors',()=>{
  expect(editorialPublisherAvatar(defaultEditorialPublisherName,'neutral-avatar')).toBe(defaultEditorialPublisherAvatar);
  for(const author of ['另一作者',`${defaultEditorialPublisherName}客服`,'',null,undefined])
   expect(editorialPublisherAvatar(author,'neutral-avatar')).toBe('neutral-avatar');
 });
});
