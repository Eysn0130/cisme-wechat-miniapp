import {beforeEach,describe,expect,it,vi} from 'vitest';
import type pg from 'pg';
import {loadConfig,CANONICAL_WECHAT_MINIPROGRAM_APP_ID} from '@cisme/config';
import type {EditorialService} from '../../services/api/src/editorial';
import {EditorialActivityService} from '../../services/api/src/editorialActivity';
import {finishPage,pageScope} from '../../services/api/src/keysetPage';

const mocks=vi.hoisted(()=>({query:vi.fn(),transaction:vi.fn()}));
vi.mock('../../services/api/src/db',()=>({transaction:mocks.transaction}));
const owner='11111111-1111-4111-8111-111111111111',id='abcdefab-cdef-4abc-8abc-abcdefabcdef';
const config=loadConfig({APP_ENV:'test',DATABASE_URL:'postgres://unused',APP_SESSION_SECRET:'synthetic-activity-session',
  UPLOAD_TOKEN_SECRET:'synthetic-activity-upload',WECHAT_APP_ID:CANONICAL_WECHAT_MINIPROGRAM_APP_ID});
const actor=vi.fn(),service=new EditorialActivityService({} as pg.Pool,config,{commentActor:actor} as unknown as EditorialService);
beforeEach(()=>{
  vi.resetAllMocks();actor.mockResolvedValue(owner);
  mocks.transaction.mockImplementation(async(_pool,work)=>work({query:mocks.query}));
});
describe('private editorial activity guards',()=>{
  it.each(['appeals','',null,['comments'],{},42])('rejects unsupported section %j before any database access',async(section)=>{
    await expect(service.read(owner,'synthetic-principal',section)).rejects.toMatchObject({code:'EDITORIAL_ACTIVITY_SECTION_INVALID'});
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each([0,51,'no',1.5])('rejects invalid page size %j before any database access',async(limit)=>{
    await expect(service.read(owner,'synthetic-principal','comments',{limit})).rejects.toMatchObject({code:'PAGE_LIMIT_INVALID'});
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('does not accept a cursor from another actor, section, or ordinary UGC scope',async()=>{
    for(const scope of [pageScope(['editorial-activity',id,'comments']),pageScope(['editorial-activity',owner,'saves']),pageScope(['ugc-activity',owner,'comments',''])]){
      const cursor=finishPage([{id,cursorAt:'2026-10-28 12:00:00.123789+00'},{id:owner,cursorAt:'2026-10-28 12:00:00.123789+00'}],1,scope).nextCursor;
      await expect(service.read(owner,'synthetic-principal','comments',{cursor})).rejects.toMatchObject({code:'PAGE_CURSOR_INVALID'});
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('requires the existing canonical actor without imposing fresh legal acceptance or reading rows after denial',async()=>{
    actor.mockRejectedValue({code:'AUTH_REQUIRED'});
    await expect(service.read(owner,'wrong-principal','comments')).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    expect(actor).toHaveBeenCalledWith(expect.anything(),owner,'wrong-principal',false);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('only projects the allowlisted private comment fields, never the database cursor or extra identity columns',async()=>{
    mocks.query.mockResolvedValueOnce({rows:[{id,created_at:new Date('2026-10-28T12:00:00Z'),cursor_at:'2026-10-28 12:00:00.123789+00',
      post_id:owner,post_title:null,available:false,body:'本人评论',state:'hidden',version:2,parent_id:null,reply_to_id:null,
      author_member_id:owner,private_phone:'synthetic-private',operation_id:'synthetic-private-key'}]}).mockResolvedValueOnce({rows:[{n:1}]});
    const result=await service.read(owner,'synthetic-principal','comments');
    expect(result).toEqual({items:[{id,createdAt:new Date('2026-10-28T12:00:00Z'),source:'editorial',postId:owner,postTitle:null,
      available:false,body:'本人评论',state:'hidden',version:2,parentId:null,replyToId:null}],nextCursor:null,matchingTotal:1,loadedCount:1,hasMore:false});
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private|cursor_at|author_member_id/);
  });
  it.each(['not-a-uuid','editorial:'+id,[],null])('rejects invalid saved article identifier %j without mutation',async(value)=>{
    await expect(service.removeSave(owner,'synthetic-principal',value)).rejects.toMatchObject({code:'EDITORIAL_ACTIVITY_INPUT_INVALID'});
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('removes only the canonical actor save namespace, audits an actual deletion once, and has an existence-neutral response',async()=>{
    mocks.query.mockResolvedValueOnce({rowCount:1}).mockResolvedValueOnce({rowCount:1}).mockResolvedValueOnce({rowCount:0});
    const first=await service.removeSave(owner,'synthetic-principal',id.toUpperCase());
    const second=await service.removeSave(owner,'synthetic-principal',id);
    expect(first).toEqual({id,saved:false});expect(second).toEqual(first);
    expect(actor.mock.calls.every(call=>call[3]===false)).toBe(true);
    const commands=mocks.query.mock.calls;
    expect(commands[0]![1]).toEqual([owner,`editorial:${id}`]);
    expect(commands[0]![0]).toContain("kind='save'");
    expect(commands[1]![1]).toEqual(['synthetic-principal',id,{kind:'save',active:false,actorMemberId:owner},expect.any(String)]);
    expect(commands.filter(call=>String(call[0]).includes('INSERT INTO audit_log'))).toHaveLength(1);
  });
});
