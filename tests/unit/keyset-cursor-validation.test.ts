import {describe,expect,it} from 'vitest';
import {finishPage,pageScope,readPageCursor} from '../../services/api/src/keysetPage';

const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const scope=pageScope(['cursor-validation','synthetic-member']);
const cursor=(t:unknown,s=scope)=>Buffer.from(JSON.stringify({v:1,s,t,i:id})).toString('base64url');

describe('keyset cursor timestamp validation',()=>{
  it.each([
    '0','2026-02-30T10:00:00.123456Z','2025-02-29T00:00:00.000001Z',
    '2026-09-23','09/23/2026','2026-09-23T12:00:00.123',
    '2026-09-23T12:00:00.1234567Z','2026-09-23T24:00:00.000Z',
    '0000-01-01T00:00:00.000000Z','2026-13-01T00:00:00.000Z',
    '2026-09-23 12:00:00.123456+16','2026-09-23 12:00:00+08:60',
    '2026-02-30 12:00:00.123456+00','2026-09-23 24:00:00+00',
    '2026-09-23 12:00:00+08:00:60',null,123456
  ])('rejects unsupported or normalized boundary %s',(at)=>{
    expect(()=>readPageCursor(cursor(at),scope)).toThrow('列表位置已失效');
  });
  it.each([
    '2026-09-23T12:00:00.123456Z','2026-09-23T12:00:00.123Z',
    '2024-02-29T00:00:00.000001Z','2026-09-23T12:00:00Z',
    '2026-09-23 12:00:00.123456+00','2026-09-23 12:00:00+00',
    '2026-09-23 12:00:00.000001+08','2026-09-23 12:00:00.123456-07',
    '2026-09-23 12:00:00.123456+05:30','2026-09-23T12:00:00.123+08:00',
    '2026-09-23 12:00:00.000001+05:30:15'
  ])('preserves the exact accepted SQL boundary %s',(at)=>{
    expect(readPageCursor(cursor(at),scope)).toEqual({at,id});
  });
  it('round-trips a producer microsecond cursor without rounding down to milliseconds',()=>{
    const at='2026-09-23T12:00:00.123789Z';
    const page=finishPage([{id,cursorAt:at},{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',cursorAt:at}],1,scope);
    expect(readPageCursor(page.nextCursor,scope)).toEqual({at,id});
  });
  it('round-trips PostgreSQL text emitted by member and public comment pages',()=>{
    const at='2026-09-23 12:00:00.123789+00';
    const page=finishPage([{id,cursorAt:at},{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',cursorAt:at}],1,scope);
    expect(readPageCursor(page.nextCursor,scope)).toEqual({at,id});
  });
  it('retains scope and malformed-container rejection',()=>{
    expect(()=>readPageCursor(cursor('2026-09-23T12:00:00.000001Z','other-scope'),scope)).toThrow('列表位置已失效');
    for(const value of [null,[],{},'not-an-object']){
      expect(()=>readPageCursor(Buffer.from(JSON.stringify(value)).toString('base64url'),scope)).toThrow('列表位置已失效');
    }
  });
  it('keeps absent and empty cursors as first-page requests',()=>{
    expect(readPageCursor(undefined,scope)).toBeNull();
    expect(readPageCursor(null,scope)).toBeNull();
    expect(readPageCursor('',scope)).toBeNull();
  });
});
