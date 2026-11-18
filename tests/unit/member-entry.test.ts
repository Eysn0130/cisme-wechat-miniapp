import {beforeEach,expect,it,vi} from 'vitest';
let data:any;
beforeEach(()=>{
  vi.resetModules();data={sessionToken:'',apiBaseUrl:'https://synthetic.invalid',cloudFunction:null};
  vi.stubGlobal('getApp',()=>({globalData:data}));
});
it('does not admit a guest or an identity token that has not completed Account verification',async()=>{
  const entry=await import('../../apps/miniprogram/services/member-entry');
  expect(entry.memberEntryReady()).toBe(false);expect(entry.confirmMemberEntry('')).toBe(false);
  data.sessionToken='pending-identity';expect(entry.memberEntryReady()).toBe(false);
  expect(entry.confirmMemberEntry('different-identity')).toBe(false);expect(entry.memberEntryReady()).toBe(false);
});
it('invalidates confirmed entry after a session, environment or transport change and explicit logout',async()=>{
  const entry=await import('../../apps/miniprogram/services/member-entry');
  data.sessionToken='confirmed-a';expect(entry.confirmMemberEntry('confirmed-a')).toBe(true);expect(entry.memberEntryReady()).toBe(true);
  data.sessionToken='confirmed-b';expect(entry.memberEntryReady()).toBe(false);
  entry.confirmMemberEntry('confirmed-b');data.apiBaseUrl='https://other.synthetic.invalid';expect(entry.memberEntryReady()).toBe(false);
  entry.confirmMemberEntry('confirmed-b');data.cloudFunction={env:'isolated-trial',name:'gateway'};expect(entry.memberEntryReady()).toBe(false);
  entry.confirmMemberEntry('confirmed-b');entry.clearMemberEntry();expect(entry.memberEntryReady()).toBe(false);
});
it('does not accept an explicitly pending registration or missing avatar as a complete profile',async()=>{
  const {hasCompleteLoginProfile}=await import('../../apps/miniprogram/services/member-setup');
  const profile={display_name:'小雨',profile_revision:1,avatar_data_url:'confirmed-avatar',completed_at:'2026-11-17T00:00:00Z',registration_completed_at:null};
  expect(hasCompleteLoginProfile(profile)).toBe(false);
  expect(hasCompleteLoginProfile({...profile,registration_completed_at:'2026-11-17T00:00:00Z'})).toBe(true);
  expect(hasCompleteLoginProfile({...profile,registration_completed_at:'2026-11-17T00:00:00Z',avatar_data_url:null})).toBe(false);
});
