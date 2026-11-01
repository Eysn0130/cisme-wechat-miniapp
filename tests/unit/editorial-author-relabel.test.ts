import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {describe,expect,it,vi} from 'vitest';
import {CANONICAL_WECHAT_MINIPROGRAM_APP_ID,type AppConfig} from '@cisme/config';
import {AuthorityService} from '../../services/api/src/authority';
import {validateEditorialPublication,type EditorialPublication} from '../../services/api/src/editorial';
import {relabelEditorialAuthors,type EditorialAuthorRelabelPlan} from '../../services/api/src/editorialAuthorRelabel';

const digest=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const operator='10000000-0000-4000-8000-000000000001',author='10000000-0000-4000-8000-000000000002';
const principal='wechat_miniprogram:10000000-0000-4000-8000-000000000003';
const oldName='ʜᴇ ʜᴇ ʜᴇ',newName='CISME头皮实验室';
const config={env:'staging',databaseUrl:'postgresql://fixture:fixture@127.0.0.1/cisme_trial',wechat:{appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID}} as AppConfig;
type Store={articles:Record<string,any>;revisions:any[];audits:any[];untouched:{memberName:string;comments:any[];follows:number}};
function fixture(){
  const articles:Record<string,any>={},revisions:any[]=[];
  for(const [index,slug]of ['alpha','beta'].entries()){
    const content:EditorialPublication={externalRef:`cisme-owned:${slug}`,authorMemberId:author,author:oldName,
      title:`原文${index}`,excerpt:'原摘要',body:'只保留的正文，不进入作者重标记审计',sourceUrl:null,
      authorizationRef:'synthetic-original-owner-authorization',rightsEvidence:{kind:'owner_authorized_original_rewrite',sources:[]},media:[]};
    const id=`20000000-0000-4000-8000-00000000000${index+1}`;
    const hash=digest(validateEditorialPublication(content));
    articles[id]={id,external_ref:content.externalRef,author_member_id:author,author_display_name:oldName,title:content.title,excerpt:content.excerpt,
      body:content.body,source_url:null,authorization_ref:content.authorizationRef,rights_evidence:content.rightsEvidence,media:[],content_sha256:hash,
      status:'published',version:index+1,published_by:operator,published_principal_id:principal,
      published_at:`2026-10-26T0${index}:00:00.000Z`,created_at:'2026-10-26T00:00:00.000Z',updated_at:'2026-10-26T00:00:00.000Z',comments_enabled:true};
    revisions.push({article_id:id,version:index+1,content_sha256:hash,action:'publish'});
  }
  const store:Store={articles,revisions,audits:[],untouched:{memberName:oldName,comments:[{id:'original-comment',author:oldName}],follows:7}};
  const plan:EditorialAuthorRelabelPlan={schemaVersion:1,environment:'staging',databaseName:'cisme_trial',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,
    operatorMemberId:operator,operatorPrincipalId:principal,authorMemberId:author,oldName,newName,authorizationRef:'synthetic-owner-author-relabel-20261101',
    targets:Object.values(articles).reverse().map(row=>({id:row.id,externalRef:row.external_ref,expectedVersion:row.version,
      expectedContentSha256:row.content_sha256,expectedRowSha256:digest(row)}))};
  return {store,plan};
}
function harness(initial:Store,options:{database?:string;operatorActive?:boolean;authorActive?:boolean;grant?:boolean;failWrite?:number;zeroUpdate?:boolean}={}){
  let committed=structuredClone(initial),pending:Store|undefined,writes=0;
  const calls:Array<{sql:string;values:any[]}>=[];
  const query=vi.fn(async(sql:string,values:any[]=[])=>{
    calls.push({sql,values:structuredClone(values)});
    const ok=(rows:any[]=[],rowCount=rows.length)=>({rows,rowCount,command:'SELECT'});
    if(sql.startsWith('BEGIN')){pending=structuredClone(committed);return ok();}
    if(sql==='COMMIT'){committed=pending!;pending=undefined;return {...ok(),command:'COMMIT'};}
    if(sql==='ROLLBACK'){pending=undefined;return {...ok(),command:'ROLLBACK'};}
    if(sql.startsWith('SELECT set_config'))return ok();
    if(sql==='SELECT current_database() AS name')return ok([{name:options.database??'cisme_trial'}]);
    if(sql.includes('FROM member m JOIN wechat_identity w'))return ok((values.length===3?options.operatorActive:options.authorActive)===false?[]:[{'?column?':1}]);
    if(sql.startsWith('SELECT g.expires_at FROM authority_grant'))return ok(options.grant===false?[]:[{expires_at:null}]);
    if(sql.includes('pg_advisory_xact_lock'))return ok();
    if(sql.includes('AS relabel_row_sha256')){
      const row=pending!.articles[values[0]];return ok(row?.external_ref===values[1]?[{...structuredClone(row),relabel_row_sha256:digest(row)}]:[]);
    }
    if(sql.startsWith('SELECT content_sha256,action FROM editorial_article_revision'))
      return ok(pending!.revisions.filter(row=>row.article_id===values[0]&&row.version===values[1]));
    if(/^(UPDATE|INSERT)/.test(sql)){
      writes++;if(writes===options.failWrite)throw new Error('synthetic write failure');
      if(sql.startsWith('UPDATE editorial_article')){
        if(options.zeroUpdate)return ok([],0);
        Object.assign(pending!.articles[values[0]],{author_display_name:values[1],content_sha256:values[2],version:values[3],updated_at:'2026-11-01T00:00:00.000Z'});
      }else if(sql.startsWith('INSERT INTO editorial_article_revision'))pending!.revisions.push({article_id:values[0],version:values[1],content_sha256:values[2],action:'publish',
        authorization_sha256:values[3],rights_sha256:values[4],actor_member_id:values[5],actor_principal_id:values[6]});
      else if(sql.startsWith('INSERT INTO audit_log'))pending!.audits.push({principal_id:values[0],object_id:values[1],before_state:values[2],after_state:values[3],trace_id:values[4]});
      else throw new Error('unexpected write: '+sql);
      return ok([],1);
    }
    throw new Error('unexpected query: '+sql);
  });
  const client={query,on:vi.fn(),removeListener:vi.fn(),release:vi.fn()};
  const pool={connect:vi.fn().mockResolvedValue(client),query:vi.fn(()=>{throw new Error('pool query outside transaction');})} as unknown as pg.Pool;
  const authority=new AuthorityService(pool,'staging');const requireWithClient=vi.spyOn(authority,'requireWithClient');
  return {pool,authority,requireWithClient,calls,client,getStore:()=>structuredClone(committed),writes:()=>writes};
}

describe('exact trial editorial author relabelling',()=>{
  it('changes only author label, normalized hash, version and updated time, preserving order, content, identities and existing revisions',async()=>{
    const {store,plan}=fixture(),h=harness(store);
    const result=await relabelEditorialAuthors(h.pool,config,h.authority,plan),after=h.getStore();
    expect(result).toMatchObject({mode:'author_relabelled',count:2,authorMemberId:author,oldName,newName});
    expect(result.articles.map(row=>row.externalRef)).toEqual(['cisme-owned:alpha','cisme-owned:beta']);
    expect(h.requireWithClient).toHaveBeenCalledOnce();expect(h.requireWithClient).toHaveBeenCalledWith(expect.anything(),operator,'editorial.manage');
    expect(after.untouched).toEqual(store.untouched);expect(after.revisions.slice(0,store.revisions.length)).toEqual(store.revisions);
    for(const [id,before]of Object.entries(store.articles)){
      const current=after.articles[id];
      expect(current).toMatchObject({author_display_name:newName,version:before.version+1});
      const unchanged=(row:any)=>Object.fromEntries(Object.entries(row).filter(([key])=>!['author_display_name','content_sha256','version','updated_at'].includes(key)));
      expect(unchanged(current)).toEqual(unchanged(before));
      const publication:EditorialPublication={externalRef:before.external_ref,authorMemberId:author,author:newName,title:before.title,excerpt:before.excerpt,body:before.body,
        sourceUrl:before.source_url,authorizationRef:before.authorization_ref,rightsEvidence:before.rights_evidence,media:before.media};
      expect(current.content_sha256).toBe(digest(validateEditorialPublication(publication)));
      expect(after.revisions.find(row=>row.article_id===id&&row.version===current.version)).toMatchObject({content_sha256:current.content_sha256,action:'publish',
        authorization_sha256:digest(before.authorization_ref),rights_sha256:digest(before.rights_evidence),actor_member_id:operator,actor_principal_id:principal});
    }
    expect(after.audits).toHaveLength(2);expect(JSON.stringify(after.audits)).not.toContain(store.articles[plan.targets[0]!.id].body);
    for(const audit of after.audits)expect(audit).toMatchObject({before_state:{authorName:oldName},after_state:{authorName:newName,authorizationRef:plan.authorizationRef}});
    const updates=h.calls.filter(call=>call.sql.startsWith('UPDATE'));
    expect(updates).toHaveLength(2);
    for(const {sql}of updates)expect(sql.split('WHERE')[0]!.replace(/\s+/g,' ').trim()).toBe('UPDATE editorial_article SET author_display_name=$2,content_sha256=$3,version=$4,updated_at=now()');
    expect(h.calls.filter(call=>call.sql==='COMMIT')).toHaveLength(1);expect(h.calls.some(call=>call.sql==='ROLLBACK')).toBe(false);
    expect(h.pool.query).not.toHaveBeenCalled();expect(h.client.release).toHaveBeenCalledOnce();
  });
  it('takes every advisory and exact row lock in external-ref order and validates the whole set before any write',async()=>{
    const {store,plan}=fixture(),h=harness(store);await relabelEditorialAuthors(h.pool,config,h.authority,plan);
    expect(h.calls.filter(call=>call.sql.includes('pg_advisory_xact_lock')).map(call=>call.values[0])).toEqual(['editorial:cisme-owned:alpha','editorial:cisme-owned:beta']);
    expect(h.calls.filter(call=>call.sql.includes('AS relabel_row_sha256')).map(call=>call.values[1])).toEqual(['cisme-owned:alpha','cisme-owned:beta']);
    const firstWrite=h.calls.findIndex(call=>call.sql.startsWith('UPDATE'));
    const rowLocks=h.calls.slice(0,firstWrite).filter(call=>call.sql.includes('AS relabel_row_sha256'));
    expect(rowLocks).toHaveLength(2);expect(rowLocks.every(call=>call.sql.includes("digest(to_jsonb(a)::text,'sha256')")&&call.sql.includes('FOR UPDATE OF a'))).toBe(true);
    expect(h.calls.filter(call=>call.sql.includes('FROM member m JOIN wechat_identity w')).every(call=>call.sql.includes("w.adapter='wechat'")&&call.sql.includes('FOR SHARE OF m,w'))).toBe(true);
  });
  it.each([
    ['wrong schema',(p:any)=>{p.schemaVersion=2;}],['wrong environment',(p:any)=>{p.environment='production';}],
    ['wrong database',(p:any)=>{p.databaseName='cisme';}],['wrong app',(p:any)=>{p.appId='wx-other';}],
    ['missing operator',(p:any)=>{p.operatorMemberId='';}],['wrong principal',(p:any)=>{p.operatorPrincipalId='dev:fixture';}],
    ['missing author',(p:any)=>{p.authorMemberId='';}],['equal names',(p:any)=>{p.newName=p.oldName;}],
    ['unclean name',(p:any)=>{p.newName=' '+newName;}],['untracked authorization',(p:any)=>{p.authorizationRef='授权正文';}],
    ['empty targets',(p:any)=>{p.targets=[];}],['too many targets',(p:any)=>{p.targets=Array.from({length:31},(_,i)=>({...p.targets[0],id:randomUUID(),externalRef:'unique-ref-'+i}));}],
    ['duplicate id',(p:any)=>{p.targets[1].id=p.targets[0].id;}],['duplicate ref',(p:any)=>{p.targets[1].externalRef=p.targets[0].externalRef;}],
    ['missing version',(p:any)=>{p.targets[0].expectedVersion=0;}],['unsafe hash',(p:any)=>{p.targets[0].expectedContentSha256='not-a-sha';}],
    ['missing row hash',(p:any)=>{delete p.targets[0].expectedRowSha256;}],['unsafe row hash',(p:any)=>{p.targets[0].expectedRowSha256='not-a-sha';}],
    ['unknown plan scope',(p:any)=>{p.includeAllAuthors=true;}],['unknown target scope',(p:any)=>{p.targets[0].allVersions=true;}]
  ])('rejects %s before obtaining a database connection',async(_label,mutate)=>{
    const {store,plan}=fixture(),h=harness(store);mutate(plan);
    await expect(relabelEditorialAuthors(h.pool,config,h.authority,plan)).rejects.toThrow();expect(h.pool.connect).not.toHaveBeenCalled();expect(h.getStore()).toEqual(store);
  });
  it.each([
    {env:'production'}, {databaseUrl:'postgresql://fixture:fixture@127.0.0.1/cisme'}, {wechat:{appId:'wrong'}}
  ])('refuses a configuration outside the pinned trial %j',async(patch)=>{
    const {store,plan}=fixture(),h=harness(store);await expect(relabelEditorialAuthors(h.pool,{...config,...patch} as AppConfig,h.authority,plan)).rejects.toMatchObject({code:'EDITORIAL_RELABEL_TARGET_MISMATCH'});
    expect(h.pool.connect).not.toHaveBeenCalled();
  });
  it.each([{database:'cisme'},{operatorActive:false},{authorActive:false},{grant:false}])('rolls back on live target, canonical identity or authority failure %j',async(options)=>{
    const {store,plan}=fixture(),h=harness(store,options);await expect(relabelEditorialAuthors(h.pool,config,h.authority,plan)).rejects.toThrow();
    expect(h.getStore()).toEqual(store);expect(h.writes()).toBe(0);expect(h.calls.some(call=>call.sql==='ROLLBACK')).toBe(true);expect(h.calls.some(call=>call.sql==='COMMIT')).toBe(false);
  });
  it.each([
    ['foreign author',(row:any)=>{row.author_member_id=randomUUID();}],['changed label',(row:any)=>{row.author_display_name='其他作者';}],
    ['withdrawn',(row:any)=>{row.status='withdrawn';}],['changed version',(row:any)=>{row.version++;}],
    ['changed hash',(row:any)=>{row.content_sha256='f'.repeat(64);}],['different source',(row:any)=>{row.external_ref='foreign-ref';}],
    ['tampered content',(row:any)=>{row.body='未经核对的不同正文';}],['changed comment policy',(row:any)=>{row.comments_enabled=false;}],
    ['changed timestamp',(row:any)=>{row.updated_at='2026-11-01T00:01:00.000Z';}]
  ])('rejects %s under the exact row locks before any batch write',async(_label,mutate)=>{
    const {store,plan}=fixture();mutate(store.articles[plan.targets[0]!.id]);const h=harness(store);
    await expect(relabelEditorialAuthors(h.pool,config,h.authority,plan)).rejects.toThrow();expect(h.getStore()).toEqual(store);expect(h.writes()).toBe(0);
    expect(h.calls.some(call=>call.sql==='ROLLBACK')).toBe(true);
  });
  it('refuses a missing current publication revision and a missing exact row',async()=>{
    for(const kind of ['revision','article']){
      const {store,plan}=fixture();if(kind==='revision')store.revisions=[];else delete store.articles[plan.targets[0]!.id];const h=harness(store);
      await expect(relabelEditorialAuthors(h.pool,config,h.authority,plan)).rejects.toThrow();expect(h.getStore()).toEqual(store);expect(h.writes()).toBe(0);
    }
  });
  it('uses the exact database row digest and immutable revision without inventing a historical JSON serialization',async()=>{
    const {store,plan}=fixture();
    // A legacy publication fingerprint can differ after JSONB reorders nested
    // rights keys, even when all current database facts are independently pinned.
    for(const target of plan.targets){
      const row=store.articles[target.id];row.content_sha256='c'.repeat(64);
      target.expectedContentSha256=row.content_sha256;target.expectedRowSha256=digest(row);
      store.revisions.find(revision=>revision.article_id===row.id).content_sha256=row.content_sha256;
    }
    const h=harness(store);await expect(relabelEditorialAuthors(h.pool,config,h.authority,plan)).resolves.toMatchObject({count:2});
    expect(Object.values(h.getStore().articles).every(row=>row.author_display_name===newName)).toBe(true);
  });
  it('rejects an independently mismatched full-row digest despite matching ID, version, author and historical content hash',async()=>{
    const {store,plan}=fixture();plan.targets[0]!.expectedRowSha256='f'.repeat(64);const h=harness(store);
    await expect(relabelEditorialAuthors(h.pool,config,h.authority,plan)).rejects.toMatchObject({code:'EDITORIAL_RELABEL_CONFLICT'});
    expect(h.getStore()).toEqual(store);expect(h.writes()).toBe(0);
  });
  it.each([2,3,4,5,6])('rolls back every prior row, new revision and audit if batch write %s fails',async(failWrite)=>{
    const {store,plan}=fixture(),h=harness(store,{failWrite});
    await expect(relabelEditorialAuthors(h.pool,config,h.authority,plan)).rejects.toThrow('synthetic write failure');
    expect(h.getStore()).toEqual(store);expect(h.calls.filter(call=>call.sql==='ROLLBACK')).toHaveLength(1);expect(h.calls.some(call=>call.sql==='COMMIT')).toBe(false);
    expect(h.client.release).toHaveBeenCalledOnce();
  });
  it('fails closed if the guarded UPDATE confirms no changed row',async()=>{
    const {store,plan}=fixture(),h=harness(store,{zeroUpdate:true});
    await expect(relabelEditorialAuthors(h.pool,config,h.authority,plan)).rejects.toMatchObject({code:'EDITORIAL_RELABEL_CONFLICT'});expect(h.getStore()).toEqual(store);
    expect(h.calls.some(call=>call.sql.startsWith('INSERT'))).toBe(false);
  });
  it('detaches the exact plan before asynchronous work and cannot be redirected by caller mutation',async()=>{
    const {store,plan}=fixture(),h=harness(store);const pending=relabelEditorialAuthors(h.pool,config,h.authority,plan);
    plan.newName='被替换计划';plan.targets[0]!.id=randomUUID();await pending;
    expect(Object.values(h.getStore().articles).every(row=>row.author_display_name===newName)).toBe(true);
  });
});
