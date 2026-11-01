import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { describe, it } from "vitest";

// Execute the real Page and the existing GET-owner helper with synthetic transports.
// This is lifecycle regression coverage, not WeChat renderer/device acceptance.
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const source=(path:string)=>stripTypeScriptTypes(readFileSync(path,"utf8").replace(/^import[^\n]*\n/gm,"").replace(/\bexport /g,""));
const event=(key:string,value:string,source?:string)=>({currentTarget:{dataset:{[key]:value,...source?{source}:{}}}});
function fixture(sourceName:"editorial"|"ugc"="ugc"){
  const state={token:"synthetic-a",revision:1,access:true};
  const calls:any[]=[],modals:any[]=[];let definition:any;
  const request=(options:any)=>new Promise((resolve,reject)=>{
    const call={...options,resolve,reject,aborted:0};
    options.registerAbort?.(()=>{call.aborted+=1;});calls.push(call);
  });
  const helpers=runInNewContext(source("apps/miniprogram/services/page-requests.ts")+"\n;({pageRead,cancelPageReads});",{request});
  const navigation:any[]=[],accessUrls:string[]=[];
  const wx={showModal:()=>new Promise((resolve,reject)=>modals.push({resolve,reject})),showToast:()=>{},navigateTo:(options:any)=>navigation.push(options)};
  const editorial=runInNewContext(source("apps/miniprogram/services/editorial.ts")+"\n;({editorialIdentifier});",{...helpers,request});
  const editorialCommands=runInNewContext(source("apps/miniprogram/services/editorial-comments.ts")+"\n;({deleteEditorialComment,setEditorialBlock});",{...helpers,...editorial,request});
  runInNewContext(source("apps/miniprogram/pages/community-activity/index.ts"),{
    ...helpers,...editorialCommands,request,requireMemberAccess:(url:string)=>{accessUrls.push(url);return state.access;},currentChromeStyle:()=>"",shouldReduceMotion:()=>false,
    commerceContextRevision:()=>state.revision,getApp:()=>({globalData:{sessionToken:state.token}}),
    wx,Page:(value:any)=>{definition=value;}
  });
  const page={...definition,data:structuredClone(definition.data),updates:[] as any[],
    setData(patch:any){this.updates.push(patch);Object.assign(this.data,patch);}};
  page.sessionToken=state.token;page.contextRevision=state.revision;
  page.data.loading=false;page.data.source=sourceName;
  if(sourceName==="ugc")page.data.tabs=[...page.data.tabs.slice(0,3),{key:"appeals",label:"申诉"},page.data.tabs[3]];
  return {page,state,calls,modals,navigation,accessUrls};
}
const empty={items:[],nextCursor:null,matchingTotal:0};
const row={id:"synthetic-comment",postId:"synthetic-post",memberId:"synthetic-member",state:"published",createdAt:"2026-01-01T00:00:00Z"};
const writes=[
  {method:"removeSaved",key:"synthetic-post",section:"saves"},
  {method:"unblock",key:"synthetic-member",section:"blocks"},
  {method:"deleteComment",key:"synthetic-comment",section:"comments"}
];
const editorialRow={...row,id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",postId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",memberId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",postTitle:"真实精选标题",available:true,source:"editorial"};
const editorialPage=(items:any[]=[],nextCursor:string|null=null,matchingTotal=items.length)=>({items,nextCursor,matchingTotal,loadedCount:items.length,hasMore:nextCursor!==null});

describe("community activity editorial and submission sources",()=>{
  it("defaults new entry to editorial while preserving explicit submission links and login return intent",()=>{
    const fresh=fixture();fresh.page.onLoad({});assert.equal(fresh.page.data.source,"editorial");assert.equal(fresh.calls[0].path,"/v1/me/editorial/activity/comments?limit=30");
    assert.deepEqual(Array.from(fresh.page.data.tabs,(tab:any)=>tab.key),["comments","saves","reports","blocks"]);
    const old=fixture();old.page.onLoad({source:"ugc",section:"appeals"});assert.equal(old.calls[0].path,"/v1/me/ugc/activity/appeals?limit=30");assert.equal(old.page.data.section,"appeals");
    assert.equal(old.accessUrls[0],"/pages/community-activity/index?source=ugc&section=appeals");
    const denied=fixture("editorial");denied.state.access=false;denied.page.onLoad({source:"ugc",section:"saves"});assert.equal(denied.calls.length,0);assert.equal(denied.accessUrls[0],"/pages/community-activity/index?source=ugc&section=saves");
    assert.match(readFileSync("apps/miniprogram/pages/community-post/index.ts","utf8"),/community-activity\/index\?source=ugc&section=comments/);
  });
  it("switches source with no stale cursor, cancels the old owned read and rejects its late result",async()=>{
    const f=fixture("editorial"),first=f.page.load();f.page.data.nextCursor="old-cursor";f.page.selectSource(event("source","ugc"));
    assert.equal(f.calls[0].aborted,1);assert.equal(f.calls[1].path,"/v1/me/ugc/activity/comments?limit=30");assert.equal(f.page.data.nextCursor,null);
    f.calls[1].resolve({items:[row],nextCursor:null,matchingTotal:1});await flush();f.calls[0].resolve(editorialPage([editorialRow],"old-next"));await first;
    assert.equal(f.page.data.source,"ugc");assert.equal(f.page.data.items[0].id,row.id);assert.equal(f.page.data.nextCursor,null);
  });
  it("drops source ABA results and resets an unavailable appeals section to editorial comments",async()=>{
    const f=fixture("editorial"),first=f.page.load();f.page.selectSource(event("source","ugc"));f.page.selectSection(event("section","appeals"));f.page.selectSource(event("source","editorial"));
    assert.equal(f.page.data.section,"comments");assert.equal(f.page.data.activeTabIndex,0);assert.equal(f.calls[3].path,"/v1/me/editorial/activity/comments?limit=30");
    f.calls[3].resolve(editorialPage([{...editorialRow,id:"new"}]));await flush();f.calls[0].resolve(editorialPage([editorialRow]));f.calls[1].resolve(empty);f.calls[2].resolve(empty);await first;await flush();
    assert.equal(f.page.data.items[0].id,"new");
    f.page.selectSection(event("section","appeals"));assert.equal(f.calls.length,4);
  });
  it("keeps real comment states, deleted history and authoritative totals instead of filtering private history",async()=>{
    const f=fixture("editorial"),load=f.page.load();
    const states=["pending_review","published","rejected","hidden","deleted"];
    f.calls[0].resolve(editorialPage(states.map((state,index)=>({...editorialRow,id:String(index),state,body:state==="deleted"?null:"本人评论",available:state!=="hidden",postTitle:state==="hidden"?null:editorialRow.postTitle})),null,9));await load;
    assert.equal(f.page.data.matchingTotal,9);assert.equal(f.page.data.items.length,5);assert.deepEqual(Array.from(f.page.data.items,(item:any)=>item.stateLabel),["待审核","已公开","未通过","已隐藏","已删除"]);
    assert.equal(f.page.data.items[4].body,null);assert.equal(f.page.data.items[3].postTitle,null);
  });
  it("paginates only the selected source and rejects malformed editorial pagination rather than showing a false empty state",async()=>{
    const f=fixture("editorial"),load=f.page.load();f.calls[0].resolve(editorialPage([editorialRow],"next",2));await load;
    const more=f.page.load(false);assert.equal(f.calls[1].path,"/v1/me/editorial/activity/comments?limit=30&cursor=next");f.calls[1].resolve(editorialPage([{...editorialRow,id:"second"}],null,2));await more;assert.equal(f.page.data.items.length,2);
    const broken=f.page.load();f.calls[2].resolve({items:[],matchingTotal:0,nextCursor:null});await broken;assert.equal(f.page.data.loading,false);assert.ok(f.page.data.error);assert.equal(f.page.data.items.length,0);
  });
  it("opens visible editorial rows in the editorial detail and preserves the submission route",()=>{
    const f=fixture("editorial");f.page.data.items=[editorialRow];f.page.openPost(event("id",editorialRow.postId,"editorial"));assert.equal(f.navigation[0].url,`/pages/post/index?id=${editorialRow.postId}&source=editorial`);
    f.page.data.items=[{...editorialRow,available:false}];f.page.openPost(event("id",editorialRow.postId,"editorial"));assert.equal(f.navigation.length,1);
    f.page.data.source="ugc";f.page.data.items=[row];f.page.openPost(event("id",row.postId,"editorial"));assert.equal(f.navigation.length,1);
    f.page.openPost(event("id",row.postId,"ugc"));assert.equal(f.navigation[1].url,`/pages/community-post/index?id=${row.postId}`);
  });
  for(const action of ["save","block"] as const){
    it(`${action}: uses only its real editorial write and reconciles the same source after settlement`,async()=>{
      const f=fixture("editorial");f.page.data.section=action==="save"?"saves":action==="block"?"blocks":"comments";f.page.data.items=[{...editorialRow,available:false,postTitle:null}];
      const method=action==="save"?"removeSaved":action==="block"?"unblock":"deleteComment",id=action==="save"?editorialRow.postId:action==="block"?editorialRow.memberId:editorialRow.id;
      const operation=f.page[method](event("id",id,"editorial"));f.modals[0].resolve({confirm:true});await flush();
      const call=f.calls[0];assert.equal(call.path,action==="save"?`/v1/me/editorial/saves/${editorialRow.postId}`:action==="block"?`/v1/editorial/blocks/${editorialRow.memberId}`:`/v1/editorial/articles/${editorialRow.postId}/comments/${editorialRow.id}`);assert.equal(call.method,action==="block"?"PUT":"DELETE");
      call.resolve(action==="save"?{id:editorialRow.postId,saved:false}:action==="block"?{authorId:editorialRow.memberId,blocked:false}:{id:editorialRow.id,status:"deleted"});await operation;
      assert.equal(f.page.data.busy,false);assert.equal(f.calls.length,2);assert.ok(f.calls[1].path.startsWith('/v1/me/editorial/activity/'));f.calls[1].resolve(editorialPage());await flush();assert.equal(f.page.data.items.length,0);
    });
  }
  it("does not dispatch a modal-confirmed editorial mutation after a source switch",async()=>{
    const f=fixture("editorial");f.page.data.section="saves";f.page.data.items=[editorialRow];const operation=f.page.removeSaved(event("id",editorialRow.postId,"editorial"));f.page.selectSource(event("source","ugc"));f.modals[0].resolve({confirm:true});await operation;assert.ok(f.calls.every(call=>!call.method));
  });
  it("does not paint an old source's notice or refresh over the new source after its write completes",async()=>{
    const f=fixture("editorial");f.page.data.section="saves";f.page.data.items=[editorialRow];const operation=f.page.removeSaved(event("id",editorialRow.postId,"editorial"));f.modals[0].resolve({confirm:true});await flush();
    f.page.selectSource(event("source","ugc"));f.calls[1].resolve({items:[row],nextCursor:null,matchingTotal:1});await flush();f.calls[0].resolve({id:editorialRow.postId,saved:false});await operation;
    assert.equal(f.page.data.source,"ugc");assert.equal(f.page.data.items[0].id,row.id);assert.equal(f.page.data.busy,false);assert.equal(f.page.data.notice,"");assert.equal(f.calls.length,2);
  });
  for(const origin of ["editorial","ugc"] as const)for(const outcome of ["success","uncertain"] as const){
    it(`shared unblock from ${origin} reconciles the other source after ${outcome} without replay`,async()=>{
      const f=fixture(origin),target=origin==="editorial"?"ugc":"editorial",blocked={...editorialRow,source:"shared",displayName:"公开昵称"};
      f.page.data.section="blocks";f.page.data.items=[blocked];
      const operation=f.page.unblock(event("id",blocked.memberId,origin));f.modals[0].resolve({confirm:true});await flush();
      assert.equal(f.calls[0].method,"PUT");f.page.selectSource(event("source",target));
      const oldPage=target==="editorial"?editorialPage([blocked]):{items:[blocked],nextCursor:null,matchingTotal:1};
      f.calls[1].resolve(oldPage);await flush();assert.equal(f.page.data.items.length,1);assert.equal(f.page.data.busy,true);
      if(outcome==="success")f.calls[0].resolve({authorId:blocked.memberId,blocked:false});else f.calls[0].reject({code:"NETWORK_TIMEOUT"});
      await operation;
      assert.equal(f.calls.length,3,"shared relation must supersede the other source's pre-settlement read");
      assert.equal(f.calls[2].path,`/v1/me/${target}/activity/blocks?limit=30`);assert.equal(f.calls.filter(call=>call.method).length,1);
      assert.equal(f.page.data.source,target);assert.equal(f.page.data.busy,false);assert.equal(f.page.data.notice,"");assert.equal(f.page.data.error,"");
      const authoritative=outcome==="success"?[]:[blocked];
      f.calls[2].resolve(target==="editorial"?editorialPage(authoritative):{items:authoritative,nextCursor:null,matchingTotal:authoritative.length});await flush();
      assert.equal(f.page.data.items.length,authoritative.length);assert.equal(f.page.data.matchingTotal,authoritative.length);
    });
  }
  it("reconciles source ABA with one write and keeps uncertain editorial removals visible without replay",async()=>{
    const f=fixture("editorial");f.page.data.section="saves";f.page.data.items=[editorialRow];const operation=f.page.removeSaved(event("id",editorialRow.postId,"editorial"));f.modals[0].resolve({confirm:true});await flush();
    f.page.selectSource(event("source","ugc"));f.page.selectSource(event("source","editorial"));f.calls[2].resolve(editorialPage([editorialRow]));await flush();f.calls[0].reject({status:503});await operation;
    assert.equal(f.calls.length,4);assert.equal(f.calls.filter(call=>call.method).length,1);assert.equal(f.page.data.busy,false);f.calls[3].resolve(editorialPage([editorialRow]));await flush();assert.equal(f.page.data.items.length,1);
  });
  it("keeps mutation errors honest and does not accept mismatched removal acknowledgements",async()=>{
    const f=fixture("editorial");f.page.data.section="saves";f.page.data.items=[editorialRow];const operation=f.page.removeSaved(event("id",editorialRow.postId,"editorial"));f.modals[0].resolve({confirm:true});await flush();f.calls[0].resolve({id:"different",saved:false});await operation;
    assert.equal(f.page.data.items.length,1);assert.equal(f.page.data.notice,"");assert.match(f.page.data.error,/尚未确认/);assert.equal(f.calls.length,1);
  });
  it("discards an editorial read after account ABA and reads only the current account on resume",async()=>{
    const f=fixture("editorial"),load=f.page.load();f.state.token="synthetic-b";f.state.revision+=1;f.state.token="synthetic-a";f.state.revision+=1;
    f.calls[0].resolve(editorialPage([editorialRow]));await load;assert.equal(f.page.data.items.length,0);
    f.page.onShow();assert.equal(f.calls[1].path,"/v1/me/editorial/activity/comments?limit=30");f.calls[1].resolve(editorialPage());await flush();assert.equal(f.page.data.loading,false);
  });
  it("never dispatches an editorial confirmation after the account changes",async()=>{
    const f=fixture("editorial");f.page.data.section="saves";f.page.data.items=[editorialRow];const operation=f.page.removeSaved(event("id",editorialRow.postId,"editorial"));f.state.token="synthetic-b";f.state.revision+=1;f.modals[0].resolve({confirm:true});await operation;assert.equal(f.calls.length,0);
  });
  it("an old editorial account cannot clear a new account's mutation lock or private rows",async()=>{
    const f=fixture("editorial");f.page.data.section="saves";f.page.data.items=[editorialRow];const first=f.page.removeSaved(event("id",editorialRow.postId,"editorial"));f.modals[0].resolve({confirm:true});await flush();
    f.state.token="synthetic-b";f.state.revision+=1;f.page.onShow();f.calls[1].resolve(editorialPage([editorialRow]));await flush();
    const second=f.page.removeSaved(event("id",editorialRow.postId,"editorial"));f.modals[1].resolve({confirm:true});await flush();
    f.calls[0].resolve({id:editorialRow.postId,saved:false});await first;assert.equal(f.page.data.busy,true);assert.equal(f.page.data.items.length,1);
    f.calls[2].resolve({id:editorialRow.postId,saved:false});await second;assert.equal(f.page.data.busy,false);assert.equal(f.calls.length,4);f.calls[3].resolve(editorialPage());await flush();
  });
  it("keeps normal editorial authors from removing a published comment in personal activity",async()=>{
    const f=fixture("editorial");f.page.data.items=[editorialRow];await f.page.deleteComment(event("id",editorialRow.id,"editorial"));
    assert.equal(f.modals.length,0);assert.equal(f.calls.length,0);
  });
  it("does not offer a deleted editorial comment another deletion",async()=>{
    const f=fixture("editorial");f.page.data.items=[{...editorialRow,state:"deleted",body:null}];await f.page.deleteComment(event("id",editorialRow.id,"editorial"));assert.equal(f.modals.length,0);assert.equal(f.calls.length,0);
  });
  for(const action of ["save","block"] as const)it(`${action}: preserves the editorial write lock through hide/resume and supersedes an earlier read`,async()=>{
    const f=fixture("editorial");f.page.data.section=action==="save"?"saves":action==="block"?"blocks":"comments";f.page.data.items=[editorialRow];
    const method=action==="save"?"removeSaved":action==="block"?"unblock":"deleteComment",id=action==="save"?editorialRow.postId:action==="block"?editorialRow.memberId:editorialRow.id;
    const operation=f.page[method](event("id",id,"editorial"));f.modals[0].resolve({confirm:true});await flush();f.page.onHide();f.page.onShow();assert.equal(f.page.data.busy,true);
    f.calls[1].resolve(editorialPage([editorialRow]));await flush();f.calls[0].resolve(action==="save"?{id:editorialRow.postId,saved:false}:action==="block"?{authorId:editorialRow.memberId,blocked:false}:{id:editorialRow.id,status:"deleted"});await operation;
    assert.equal(f.calls.filter(call=>call.method).length,1);assert.equal(f.page.data.busy,false);assert.equal(f.calls.length,3);f.calls[2].resolve(editorialPage());await flush();assert.equal(f.page.data.items.length,0);
  });
});

describe("community activity request and mutation ownership",()=>{
  for(const action of writes){
    for(const readFirst of [true,false])it(`${action.method}: reconciles a resumed read after write settlement (read first: ${readFirst})`,async()=>{
      const f=fixture();f.page.data.section=action.section;f.page.data.items=[row];
      const operation=f.page[action.method](event("id",action.key));
      f.modals[0].resolve({confirm:true});await flush();const write=f.calls[0];
      f.page.onHide();f.page.onShow();const staleRead=f.calls[1];
      if(readFirst){staleRead.resolve({items:[row],nextCursor:null,matchingTotal:1});await flush();}
      write.resolve({});await operation;
      const reconciliation=f.calls[2];assert.ok(reconciliation,"settled write must supersede the pre-settlement read");
      reconciliation.resolve(empty);await flush();
      if(!readFirst){staleRead.resolve({items:[row],nextCursor:null,matchingTotal:1});await flush();}
      assert.equal(f.page.data.items.length,0);assert.equal(f.page.data.busy,false);
      assert.equal(f.calls.filter(call=>call.method).length,1);
    });
    it(`${action.method}: reconciles after tab ABA without replaying the write`,async()=>{
      const f=fixture();f.page.data.section=action.section;f.page.data.items=[row];
      const operation=f.page[action.method](event("id",action.key));f.modals[0].resolve({confirm:true});await flush();
      f.page.selectSection(event("section","reports"));f.page.selectSection(event("section",action.section));
      f.calls[2].resolve({items:[row],nextCursor:null,matchingTotal:1});await flush();
      f.calls[0].resolve({});await operation;
      assert.ok(f.calls[3],"tab ABA must converge from a new read");f.calls[3].resolve(empty);await flush();
      assert.equal(f.page.data.items.length,0);assert.equal(f.calls.filter(call=>call.method).length,1);
    });
  }
  for(const action of writes){
    for(const fail of [false,true])it(`${action.method}: releases its lock after a tab change and ${fail?"failure":"success"}`,async()=>{
      const f=fixture();f.page.data.section=action.section;f.page.data.items=[row];
      const operation=f.page[action.method](event("id",action.key));
      f.modals[0].resolve({confirm:true});await flush();
      assert.equal(f.page.data.busy,true);const write=f.calls.find(call=>call.method);
      f.page.selectSection(event("section","reports"));
      if(fail)write.reject({title:"old failure"});else write.resolve({});
      await operation;
      assert.equal(f.page.data.busy,false);assert.equal(f.page.data.section,"reports");
      assert.equal(f.page.data.notice,"");assert.equal(f.page.data.error,"");
      assert.equal(f.calls.filter(call=>call.method).length,1);
    });
  }
  it("cancels owned GET subscriptions on hide and ignores their late result",async()=>{
    const f=fixture(),load=f.page.load();const read=f.calls[0];f.page.onHide();
    assert.equal(read.aborted,1);const count=f.page.updates.length;
    read.resolve({items:[row],nextCursor:null,matchingTotal:1});await load;
    assert.equal(f.page.updates.length,count);assert.equal(f.page.data.items.length,0);
    f.page.onShow();assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>!call.method));
    f.calls[1].resolve(empty);await flush();assert.equal(f.page.data.loading,false);
  });
  it("rejects A-to-B-to-A results even when the token string is the same",async()=>{
    const f=fixture(),load=f.page.load();f.state.token="synthetic-b";f.state.revision+=1;
    f.state.token="synthetic-a";f.state.revision+=1;
    f.calls[0].resolve({items:[row],nextCursor:null,matchingTotal:1});await load;
    assert.equal(f.page.data.items.length,0);
    f.page.onShow();assert.equal(f.calls.length,2);
  });
  it("does not dispatch a modal-confirmed write after hide",async()=>{
    const f=fixture();f.page.data.items=[row];const operation=f.page.deleteComment(event("id",row.id));
    f.page.onHide();f.modals[0].resolve({confirm:true});await operation;
    assert.equal(f.calls.length,0);
  });
  it("does not dispatch a modal-confirmed write after a context revision change",async()=>{
    const f=fixture();f.page.data.items=[row];const operation=f.page.deleteComment(event("id",row.id));
    f.state.revision+=1;f.modals[0].resolve({confirm:true});await flush();
    assert.equal(f.calls.length,0);await operation;
  });
  it("never submits stale visible rows under a newly changed account before onShow",async()=>{
    const f=fixture();f.page.data.items=[row];f.state.token="synthetic-b";f.state.revision+=1;
    const operation=f.page.deleteComment(event("id",row.id));f.modals[0].resolve({confirm:true});await flush();
    assert.equal(f.calls.length,0);await operation;
  });
  it("an old account's completion cannot unlock a newer account's operation",async()=>{
    const f=fixture();f.page.data.items=[row];const first=f.page.deleteComment(event("id",row.id));
    f.modals[0].resolve({confirm:true});await flush();const oldWrite=f.calls[0];
    f.state.token="synthetic-b";f.state.revision+=1;f.page.onShow();f.page.data.items=[row];
    const second=f.page.deleteComment(event("id",row.id));f.modals[1].resolve({confirm:true});await flush();
    oldWrite.resolve({});await first;assert.equal(f.page.data.busy,true);
    f.calls.find((call:any)=>call.method&&call!==oldWrite).resolve({});await second;assert.equal(f.page.data.busy,false);
  });
  it("treats modal rejection as cancellation without an unhandled operation",async()=>{
    const f=fixture();f.page.data.items=[row];const operation=f.page.deleteComment(event("id",row.id));
    f.modals[0].reject(new Error("synthetic modal cancelled"));await operation;
    assert.equal(f.calls.length,0);assert.equal(f.page.data.busy,false);
  });
  it("rechecks the write lock after two overlapping confirmation dialogs",async()=>{
    const f=fixture();f.page.data.items=[row];const first=f.page.deleteComment(event("id",row.id)),second=f.page.deleteComment(event("id",row.id));
    f.modals[0].resolve({confirm:true});await flush();f.modals[1].resolve({confirm:true});await flush();
    assert.equal(f.calls.filter(call=>call.method).length,1);await second;f.calls[0].resolve({});await first;
    assert.equal(f.page.data.busy,false);
  });
  it("never updates the unloaded page after a write settles",async()=>{
    const f=fixture();f.page.data.items=[row];const operation=f.page.deleteComment(event("id",row.id));
    f.modals[0].resolve({confirm:true});await flush();f.page.onUnload();const count=f.page.updates.length;
    f.calls[0].resolve({});await operation;assert.equal(f.page.updates.length,count);
  });
  it("deduplicates identifiers both within one response and across pagination",async()=>{
    const f=fixture(),load=f.page.load();f.calls[0].resolve({items:[row,row],nextCursor:"next",matchingTotal:2});await load;
    assert.equal(f.page.data.items.length,1);const more=f.page.load(false);
    f.calls[1].resolve({items:[row,{...row,id:"second"},{...row,id:"second"}],nextCursor:null,matchingTotal:2});await more;
    assert.equal(f.page.data.items.length,2);
  });
  it("clears private rows, notices and locks when membership access is lost",()=>{
    const f=fixture();f.page.data.items=[row];f.page.data.notice="old account";f.page.data.busy=true;f.page.data.loadingMore=true;
    f.state.access=false;f.page.onShow();assert.equal(f.page.data.items.length,0);
    assert.equal(f.page.data.notice,"");assert.equal(f.page.data.busy,false);assert.equal(f.page.data.loadingMore,false);
  });
  it("keeps only the newest read after rapid A-to-B-to-A tab selection",async()=>{
    const f=fixture(),first=f.page.load();f.page.selectSection(event("section","saves"));f.page.selectSection(event("section","comments"));
    f.calls[2].resolve({items:[{...row,id:"new"}],nextCursor:null,matchingTotal:1});await flush();
    f.calls[0].resolve({items:[row],nextCursor:null,matchingTotal:1});f.calls[1].resolve(empty);await first;await flush();
    assert.equal(f.page.data.items[0].id,"new");assert.equal(f.page.data.section,"comments");
  });
  it("retains an in-flight write lock while hidden and restores it until settlement",async()=>{
    const f=fixture();f.page.data.items=[row];const operation=f.page.deleteComment(event("id",row.id));
    f.modals[0].resolve({confirm:true});await flush();f.page.onHide();f.page.onShow();
    assert.equal(f.page.data.busy,true);f.calls[0].resolve({});await operation;assert.equal(f.page.data.busy,false);
  });
});
